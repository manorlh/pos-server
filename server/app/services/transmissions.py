"""
Card transaction transmission to Shva (שידור עסקאות) — docs/SHIFTS_API.md §4.

The till's card application keeps every approved card sale until the till calls
`doPeriodic`, which deposits the batch with Shva. Money not transmitted is not paid, and
the card companies refuse a transaction transmitted more than seven days after it was
taken. This module holds the cloud's side of that:

* **Reports** (`record_report`): every attempt the till makes, idempotent by the till's id.
  A successful one marks the card legs it carried — matched per till by the terminal's uid
  of the sale, which the till already sent in the leg's `nayax_meta`.
* **Late legs** (`mark_legs_on_ingest`): a document that reaches the cloud after the report
  that carried its sale (the till was offline) is marked when it lands, from the uids kept
  with each report. A re-pushed document is re-marked the same way, so replacing its legs
  never loses a mark.
* **Our records** (`untransmitted_*`): card legs after the till's tracking start in no
  successful batch — the recovery list, and the second opinion beside the till's own count.
* **The till's reading** (`apply_heartbeat_block`): its pending count as it last said.

Nothing here gates a shift close or a Z. The X and the Z only *show* it (`period_block`).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session, aliased

from app.models.card_transmission import (
    CardTransmission,
    CardTransmissionItem,
    TransmissionStatus,
)
from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.schemas.transmission import HeartbeatTransmission, TransmissionReportIn

logger = logging.getLogger(__name__)

CARD_METHOD = "card"

#: Documents whose card legs reach a batch. A cancelled sale was cancelled on the terminal
#: too (it leaves the batch); a pending one never completed.
TRANSMITTABLE_STATUSES = (
    TransactionStatus.COMPLETED,
    TransactionStatus.REFUNDED,
    TransactionStatus.PARTIAL_REFUND,
)

ZERO = Decimal("0.00")


# ── Reading the acquirer reply ────────────────────────────────────────────────


def _text(value: Any) -> Optional[str]:
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    text = str(value).strip()
    if not text or text.lower() == "null":
        return None
    return text


def _result_of(meta: Any) -> dict:
    result = meta.get("result") if isinstance(meta, dict) else None
    return result if isinstance(result, dict) else {}


def terminal_uid_of(meta: Any) -> Optional[str]:
    """
    The terminal's id of a card sale — Agamento's `uid`, what `doPeriodic` lists.

    The till stores it as `uid` at the top of the leg's reply, and the reply's own
    `result` carries it too. Never our `vuid`: that is the till's request id, which no
    batch lists.
    """
    if not isinstance(meta, dict):
        return None
    uid = _text(meta.get("uid")) or _text(_result_of(meta).get("uid"))
    return uid[:64] if uid else None


def approval_number_of(meta: Any) -> Optional[str]:
    if not isinstance(meta, dict):
        return None
    result = _result_of(meta)
    return (
        _text(meta.get("authNum"))
        or _text(meta.get("authNumber"))
        or _text(result.get("issuerAuthNum"))
        or _text(result.get("authNum"))
    )


def card_last4_of(meta: Any) -> Optional[str]:
    """
    The last four digits and nothing more. A masked number is cut down to its tail,
    so a reply that happened to carry more is never passed on.
    """
    if not isinstance(meta, dict):
        return None
    for raw in (meta.get("cardLast4"), meta.get("last4"), meta.get("maskedCard"),
                _result_of(meta).get("cardNumber")):
        text = _text(raw)
        if not text:
            continue
        digits = "".join(ch for ch in text if ch.isdigit())
        tail = text.rsplit("*", 1)[-1] if "*" in text else digits
        tail = "".join(ch for ch in tail if ch.isdigit())
        if len(tail) >= 4:
            return tail[-4:]
    return None


def leg_terminal_uid(method: Optional[str], meta: Any) -> Optional[str]:
    """What an ingested leg stores as `terminal_uid`: card legs only."""
    if (method or "").strip().lower() != CARD_METHOD:
        return None
    return terminal_uid_of(meta)


# ── Tracking start ────────────────────────────────────────────────────────────


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def ensure_tracking(machine: POSMachine, now: datetime) -> None:
    """The first time the cloud hears about transmissions from this till."""
    if machine.transmission_tracking_started_at is None:
        machine.transmission_tracking_started_at = now


def reset_for_replacement(machine: POSMachine) -> None:
    """
    A replacement device adopts the till (docs/SHIFTS_API.md §4.9): its card application
    holds none of the old one's batch. The old reading is cleared and tracking restarts
    at the new device's first report, so legs from before stop being counted.
    """
    machine.transmission_pending_count = None
    machine.transmission_pending_amount = None
    machine.transmission_assumed_count = None
    machine.transmission_oldest_pending_at = None
    machine.transmission_last_success_at = None
    machine.transmission_last_attempt_at = None
    machine.transmission_last_error = None
    machine.transmission_source = None
    machine.transmission_reported_at = None
    machine.transmission_tracking_started_at = None


# ── The heartbeat block ───────────────────────────────────────────────────────


def apply_heartbeat_block(
    machine: POSMachine, block: Optional[HeartbeatTransmission], *, now: Optional[datetime] = None
) -> None:
    """A snapshot: replaces the stored reading field by field. No block, no change."""
    if block is None:
        return
    now = now or datetime.now(timezone.utc)
    machine.transmission_pending_count = block.pending_count
    machine.transmission_pending_amount = block.pending_amount
    machine.transmission_assumed_count = block.assumed_count
    machine.transmission_oldest_pending_at = _utc(block.oldest_pending_at)
    machine.transmission_last_success_at = _utc(block.last_success_at)
    machine.transmission_last_attempt_at = _utc(block.last_attempt_at)
    machine.transmission_last_error = block.last_error
    machine.transmission_source = block.source
    machine.transmission_reported_at = now
    ensure_tracking(machine, now)


# ── Reports ───────────────────────────────────────────────────────────────────


@dataclass
class ReportOutcome:
    transmission: CardTransmission
    created: bool
    legs_marked: int


def _fill(row: CardTransmission, body: TransmissionReportIn) -> None:
    row.trigger = body.trigger
    row.request_id = body.request_id
    row.started_at = _utc(body.started_at)
    row.finished_at = _utc(body.finished_at)
    row.status = body.status
    row.status_code = body.status_code
    row.status_message = body.status_message
    row.batch_number = body.batch_number
    row.transaction_count = body.transaction_count
    row.amount = body.amount
    row.terminal_transaction_count = len(body.terminal_transaction_ids)
    row.report_text = body.report_text
    row.error = body.error


def _replace_items(db: Session, row: CardTransmission, machine: POSMachine, ids: Sequence[str]) -> None:
    db.query(CardTransmissionItem).filter(
        CardTransmissionItem.transmission_id == row.id
    ).delete(synchronize_session=False)
    db.add_all(
        CardTransmissionItem(
            id=uuid.uuid4(), transmission_id=row.id, machine_id=machine.id, terminal_uid=uid
        )
        for uid in ids
    )
    db.flush()


def _card_legs_query(db: Session, machine_id):
    return (
        db.query(TransactionPayment)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(
            Transaction.machine_id == machine_id,
            TransactionPayment.method == CARD_METHOD,
        )
    )


def mark_legs(db: Session, machine: POSMachine, row: CardTransmission, ids: Sequence[str]) -> int:
    """Mark this till's unmarked card legs whose uid the successful batch carried."""
    if row.status != TransmissionStatus.SUCCESS or not ids:
        return 0
    marked = 0
    ids = list(ids)
    # Chunked: a day's batch is hundreds of ids, and an IN list has its limits.
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        legs = (
            _card_legs_query(db, machine.id)
            .filter(
                TransactionPayment.terminal_uid.in_(chunk),
                TransactionPayment.transmission_id.is_(None),
            )
            .all()
        )
        for leg in legs:
            leg.transmission_id = row.id
            leg.transmitted_batch = row.batch_number
            marked += 1
    db.flush()
    return marked


def record_report(
    db: Session, machine: POSMachine, body: TransmissionReportIn, *, now: Optional[datetime] = None
) -> ReportOutcome:
    """
    Store one attempt (docs/SHIFTS_API.md §4.1). Idempotent by the till's id, except that
    a stored `unknown`/`failed` attempt is replaced by a later `success` under the same id.
    """
    now = now or datetime.now(timezone.utc)
    existing = db.query(CardTransmission).filter(CardTransmission.id == body.id).first()
    if existing is not None and existing.machine_id != machine.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="transmission_id_conflict")

    ensure_tracking(machine, now)

    if existing is not None:
        upgrade = (
            existing.status != TransmissionStatus.SUCCESS
            and body.status == TransmissionStatus.SUCCESS
        )
        if not upgrade:
            return ReportOutcome(existing, False, 0)
        _fill(existing, body)
        _replace_items(db, existing, machine, body.terminal_transaction_ids)
        marked = mark_legs(db, machine, existing, body.terminal_transaction_ids)
        return ReportOutcome(existing, False, marked)

    row = CardTransmission(
        id=body.id,
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        received_at=now,
    )
    _fill(row, body)
    db.add(row)
    db.flush()
    _replace_items(db, row, machine, body.terminal_transaction_ids)
    marked = mark_legs(db, machine, row, body.terminal_transaction_ids)
    return ReportOutcome(row, True, marked)


def mark_legs_on_ingest(db: Session, machine: POSMachine, legs: Iterable[Tuple[uuid.UUID, Optional[str]]]) -> int:
    """
    Legs just written for one document: mark any whose uid a successful batch of this
    till already carried. Also how a re-pushed document keeps its marks.
    """
    by_uid: Dict[str, List[uuid.UUID]] = {}
    for leg_id, uid in legs:
        if uid:
            by_uid.setdefault(uid, []).append(leg_id)
    if not by_uid:
        return 0
    rows = (
        db.query(CardTransmissionItem.terminal_uid, CardTransmission.id, CardTransmission.batch_number)
        .join(CardTransmission, CardTransmission.id == CardTransmissionItem.transmission_id)
        .filter(
            CardTransmissionItem.machine_id == machine.id,
            CardTransmissionItem.terminal_uid.in_(list(by_uid)),
            CardTransmission.status == TransmissionStatus.SUCCESS,
        )
        .order_by(CardTransmission.started_at.asc())
        .all()
    )
    first: Dict[str, Tuple[uuid.UUID, Optional[str]]] = {}
    for uid, transmission_id, batch in rows:
        first.setdefault(uid, (transmission_id, batch))
    marked = 0
    for uid, (transmission_id, batch) in first.items():
        for leg_id in by_uid[uid]:
            db.query(TransactionPayment).filter(TransactionPayment.id == leg_id).update(
                {
                    TransactionPayment.transmission_id: transmission_id,
                    TransactionPayment.transmitted_batch: batch,
                },
                synchronize_session=False,
            )
            marked += 1
    return marked


# ── Our records: untransmitted card legs ──────────────────────────────────────


def _charged_expr():
    """
    A card leg as the terminal's batch holds it: the goods it paid for plus the document's
    card tip, which the terminal charged on the same card (a tip at the till, or one the
    terminal asked for — "טיפ במסופון"). A tip is not a leg in the ledger, but it is in the
    batch, and the untransmitted figure is read against the terminal's. Added to the card
    leg that settled the document (its last), so a tip is never counted twice — as the
    till's own pending figure does (TransmissionStores.kt, PENDING_LEGS_SQL).
    """
    other = aliased(TransactionPayment)
    last_card = (
        select(func.max(other.sequence))
        .where(other.transaction_id == TransactionPayment.transaction_id, other.method == CARD_METHOD)
        .scalar_subquery()
    )
    return TransactionPayment.amount + case(
        (
            and_(Transaction.tip_payment_method == CARD_METHOD, TransactionPayment.sequence == last_card),
            func.coalesce(Transaction.tip_amount, 0),
        ),
        else_=0,
    )


def _charged_by_leg(db: Session, leg_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, Decimal]:
    """[_charged_expr] for these legs."""
    if not leg_ids:
        return {}
    rows = (
        db.query(TransactionPayment.id, _charged_expr())
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(TransactionPayment.id.in_(list(leg_ids)))
        .all()
    )
    return {r[0]: Decimal(r[1]).quantize(Decimal("0.01")) for r in rows}


def _untransmitted_query(db: Session):
    """Card legs with a uid, in no successful batch, after their till's tracking start."""
    return (
        db.query(TransactionPayment, Transaction)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .join(POSMachine, POSMachine.id == Transaction.machine_id)
        .filter(
            TransactionPayment.method == CARD_METHOD,
            TransactionPayment.terminal_uid.isnot(None),
            TransactionPayment.transmission_id.is_(None),
            Transaction.status.in_(TRANSMITTABLE_STATUSES),
            POSMachine.transmission_tracking_started_at.isnot(None),
            Transaction.created_at >= POSMachine.transmission_tracking_started_at,
        )
    )


def untransmitted_summary(
    db: Session, machine_ids: Sequence[uuid.UUID]
) -> Dict[uuid.UUID, Tuple[int, Decimal, Optional[datetime]]]:
    """Per till: (count, amount, oldest document time) of its untransmitted card legs."""
    if not machine_ids:
        return {}
    rows = (
        db.query(
            Transaction.machine_id,
            func.count(TransactionPayment.id),
            func.coalesce(func.sum(_charged_expr()), 0),
            func.min(Transaction.created_at),
        )
        .select_from(TransactionPayment)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .join(POSMachine, POSMachine.id == Transaction.machine_id)
        .filter(
            Transaction.machine_id.in_(list(machine_ids)),
            TransactionPayment.method == CARD_METHOD,
            TransactionPayment.terminal_uid.isnot(None),
            TransactionPayment.transmission_id.is_(None),
            Transaction.status.in_(TRANSMITTABLE_STATUSES),
            POSMachine.transmission_tracking_started_at.isnot(None),
            Transaction.created_at >= POSMachine.transmission_tracking_started_at,
        )
        .group_by(Transaction.machine_id)
        .all()
    )
    return {
        r[0]: (int(r[1]), Decimal(r[2]).quantize(Decimal("0.01")), _utc(r[3])) for r in rows
    }


def untransmitted_items(db: Session, machine: POSMachine) -> List[dict]:
    """The recovery list (docs/SHIFTS_API.md §4.8), oldest first."""
    rows = (
        _untransmitted_query(db)
        .filter(Transaction.machine_id == machine.id)
        .order_by(Transaction.created_at.asc(), TransactionPayment.sequence.asc())
        .all()
    )
    charged = _charged_by_leg(db, [leg.id for leg, _tx in rows])
    out = []
    for leg, tx in rows:
        meta = leg.nayax_meta if isinstance(leg.nayax_meta, dict) else {}
        out.append(
            {
                "transactionId": str(tx.id),
                "transactionNumber": tx.transaction_number,
                "documentType": tx.document_type,
                "createdAt": _utc(tx.created_at),
                "shiftId": str(tx.shift_id) if tx.shift_id else None,
                "legId": str(leg.id),
                # As the terminal charged it: the card tip included (see _charged_expr).
                "amount": money(charged.get(leg.id, leg.amount)),
                "approvalNumber": approval_number_of(meta),
                "terminalTransactionId": leg.terminal_uid,
                "cardLast4": card_last4_of(meta),
                "creditPayments": meta.get("creditPayments") if isinstance(meta.get("creditPayments"), int) else None,
            }
        )
    return out


def has_untransmitted(db: Session, machine: POSMachine) -> bool:
    """Would a new device leave card sales behind? The till's word, or our records."""
    if (machine.transmission_pending_count or 0) > 0:
        return True
    if machine.transmission_tracking_started_at is None:
        return False  # never reported: nothing of it is judged
    return untransmitted_summary(db, [machine.id]).get(machine.id, (0,))[0] > 0


# ── Latest attempts ───────────────────────────────────────────────────────────


def latest_by_machine(db: Session, machine_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, dict]:
    """Per till: the latest report and the latest successful one."""
    if not machine_ids:
        return {}
    ids = list(machine_ids)
    out: Dict[uuid.UUID, dict] = {}
    latest_started = (
        db.query(CardTransmission.machine_id, func.max(CardTransmission.started_at))
        .filter(CardTransmission.machine_id.in_(ids))
        .group_by(CardTransmission.machine_id)
        .all()
    )
    for machine_id, started in latest_started:
        row = (
            db.query(CardTransmission)
            .filter(CardTransmission.machine_id == machine_id, CardTransmission.started_at == started)
            .first()
        )
        out.setdefault(machine_id, {})["latest"] = row
    success = (
        db.query(
            CardTransmission.machine_id,
            func.max(func.coalesce(CardTransmission.finished_at, CardTransmission.started_at)),
        )
        .filter(
            CardTransmission.machine_id.in_(ids),
            CardTransmission.status == TransmissionStatus.SUCCESS,
        )
        .group_by(CardTransmission.machine_id)
        .all()
    )
    for machine_id, at in success:
        out.setdefault(machine_id, {})["success_at"] = _utc(at)
    return out


def money(value) -> Optional[str]:
    if value is None:
        return None
    return str(Decimal(value).quantize(Decimal("0.01")))


def _later(a: Optional[datetime], b: Optional[datetime]) -> Optional[datetime]:
    a, b = _utc(a), _utc(b)
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


def _earlier(a: Optional[datetime], b: Optional[datetime]) -> Optional[datetime]:
    a, b = _utc(a), _utc(b)
    if a is None:
        return b
    if b is None:
        return a
    return min(a, b)


@dataclass
class MachineTransmission:
    """Everything the machines list shows and the status flags read, for one till."""

    pending_count: Optional[int]
    pending_amount: Optional[Decimal]
    oldest_pending_at: Optional[datetime]
    last_transmission_at: Optional[datetime]
    last_error: Optional[str]
    untransmitted_legs: int
    untransmitted_amount: Optional[Decimal]
    tracking_started_at: Optional[datetime]

    @property
    def anything_pending(self) -> bool:
        return (self.pending_count or 0) > 0 or self.untransmitted_legs > 0


def machine_transmission(
    machine: POSMachine,
    untransmitted: Optional[Tuple[int, Decimal, Optional[datetime]]],
    latest: Optional[dict],
) -> MachineTransmission:
    legs, legs_amount, legs_oldest = untransmitted or (0, None, None)
    reported = machine.transmission_reported_at is not None
    tracking = _utc(machine.transmission_tracking_started_at)

    if reported and machine.transmission_pending_count is not None:
        pending_count = machine.transmission_pending_count
        pending_amount = machine.transmission_pending_amount
    elif tracking is not None:
        pending_count = legs
        pending_amount = legs_amount if legs else (ZERO if tracking else None)
    else:
        pending_count, pending_amount = None, None

    till_oldest = (
        machine.transmission_oldest_pending_at
        if (machine.transmission_pending_count or 0) > 0
        else None
    )
    oldest = _earlier(till_oldest, legs_oldest if legs else None)

    latest = latest or {}
    last_success = _later(machine.transmission_last_success_at, latest.get("success_at"))

    # The newer of the two accounts of the last attempt decides whether it failed.
    last_error = None
    report = latest.get("latest")
    report_at = _utc((report.finished_at or report.started_at)) if report is not None else None
    hb_at = _utc(machine.transmission_last_attempt_at)
    if report is not None and (hb_at is None or report_at >= hb_at):
        if report.status != TransmissionStatus.SUCCESS:
            last_error = report.error or report.status_message or report.status
    elif machine.transmission_last_error:
        last_error = machine.transmission_last_error

    return MachineTransmission(
        pending_count=pending_count,
        pending_amount=pending_amount,
        oldest_pending_at=oldest,
        last_transmission_at=last_success,
        last_error=last_error,
        untransmitted_legs=legs,
        untransmitted_amount=legs_amount if legs else (ZERO if tracking else None),
        tracking_started_at=tracking,
    )


def machine_fields(data: MachineTransmission) -> Dict[str, Any]:
    return {
        "pendingTransmissionCount": data.pending_count,
        "pendingTransmissionAmount": money(data.pending_amount),
        "oldestPendingTransmissionAt": data.oldest_pending_at,
        "lastTransmissionAt": data.last_transmission_at,
        "lastTransmissionError": data.last_error,
        "untransmittedCardLegs": data.untransmitted_legs,
        "untransmittedCardAmount": money(data.untransmitted_amount),
        "transmissionTrackingStartedAt": data.tracking_started_at,
    }


# ── Out ───────────────────────────────────────────────────────────────────────


def legs_matched(db: Session, transmission_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, int]:
    if not transmission_ids:
        return {}
    rows = (
        db.query(TransactionPayment.transmission_id, func.count(TransactionPayment.id))
        .filter(TransactionPayment.transmission_id.in_(list(transmission_ids)))
        .group_by(TransactionPayment.transmission_id)
        .all()
    )
    return {r[0]: int(r[1]) for r in rows}


def transmission_to_out(
    db: Session, row: CardTransmission, *, matched: Optional[int] = None, detail: bool = False
) -> dict:
    if matched is None:
        matched = legs_matched(db, [row.id]).get(row.id, 0)
    out = {
        "id": str(row.id),
        "machineId": str(row.machine_id),
        "trigger": row.trigger,
        "requestId": str(row.request_id) if row.request_id else None,
        "startedAt": _utc(row.started_at),
        "finishedAt": _utc(row.finished_at),
        "receivedAt": _utc(row.received_at),
        "status": row.status,
        "statusCode": row.status_code,
        "statusMessage": row.status_message,
        "batchNumber": row.batch_number,
        "transactionCount": row.transaction_count,
        "amount": money(row.amount),
        "error": row.error,
        "terminalTransactionCount": row.terminal_transaction_count or 0,
        "legsMatched": matched,
    }
    if detail:
        out["terminalTransactionIds"] = [
            item.terminal_uid
            for item in db.query(CardTransmissionItem)
            .filter(CardTransmissionItem.transmission_id == row.id)
            .order_by(CardTransmissionItem.terminal_uid.asc())
            .all()
        ]
        out["reportText"] = row.report_text
    return out


def list_for_machine(db: Session, machine: POSMachine, *, limit: int, offset: int) -> dict:
    query = db.query(CardTransmission).filter(CardTransmission.machine_id == machine.id)
    total = query.count()
    rows = (
        query.order_by(CardTransmission.started_at.desc(), CardTransmission.received_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    matched = legs_matched(db, [r.id for r in rows])
    return {
        "total": total,
        "items": [transmission_to_out(db, r, matched=matched.get(r.id, 0)) for r in rows],
    }


# ── On the X and the Z ────────────────────────────────────────────────────────


def period_block(
    db: Session,
    machine: POSMachine,
    shifts: Sequence[Shift],
    *,
    now: Optional[datetime] = None,
) -> dict:
    """
    The informational `transmission` block of an X or of one till's Z section
    (docs/SHIFTS_API.md §4.11). Never a condition on either.
    """
    now = now or datetime.now(timezone.utc)
    shift_ids = [s.id for s in shifts]
    tracking = _utc(machine.transmission_tracking_started_at)

    legs = []
    if shift_ids:
        legs = (
            db.query(TransactionPayment, Transaction.created_at)
            .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
            .filter(
                Transaction.shift_id.in_(shift_ids),
                Transaction.machine_id == machine.id,
                TransactionPayment.method == CARD_METHOD,
                TransactionPayment.terminal_uid.isnot(None),
                Transaction.status.in_(TRANSMITTABLE_STATUSES),
            )
            .all()
        )
    card_legs = len(legs)
    transmitted = [leg for leg, _at in legs if leg.transmission_id is not None]
    untracked = [
        leg for leg, at in legs
        if leg.transmission_id is None and (tracking is None or _utc(at) < tracking)
    ]
    untransmitted = [
        leg for leg, at in legs
        if leg.transmission_id is None and tracking is not None and _utc(at) >= tracking
    ]
    in_period: Dict[uuid.UUID, int] = {}
    for leg in transmitted:
        in_period[leg.transmission_id] = in_period.get(leg.transmission_id, 0) + 1

    start = min((_utc(s.opened_at) for s in shifts if s.opened_at), default=None)
    ends = [_utc(s.closed_at or s.close_accepted_at) for s in shifts]
    end = now if (not ends or any(e is None for e in ends)) else max(ends)

    batch_ids = set(in_period)
    rows: List[CardTransmission] = []
    if start is not None:
        rows = (
            db.query(CardTransmission)
            .filter(
                CardTransmission.machine_id == machine.id,
                CardTransmission.started_at >= start,
                CardTransmission.started_at <= end,
            )
            .all()
        )
    seen = {r.id for r in rows}
    missing = [tid for tid in batch_ids if tid not in seen]
    if missing:
        rows += db.query(CardTransmission).filter(CardTransmission.id.in_(missing)).all()
    rows.sort(key=lambda r: _utc(r.started_at), reverse=True)

    reported = machine.transmission_reported_at is not None
    return {
        "batches": [
            {
                "id": str(r.id),
                "batchNumber": r.batch_number,
                "status": r.status,
                "trigger": r.trigger,
                "startedAt": _iso(r.started_at),
                "finishedAt": _iso(r.finished_at),
                "transactionCount": r.transaction_count,
                "amount": money(r.amount),
                "legsInPeriod": in_period.get(r.id, 0),
            }
            for r in rows
        ],
        "cardLegs": card_legs,
        "transmittedLegs": len(transmitted),
        "untransmittedLegs": len(untransmitted),
        "untransmittedAmount": money(sum(
            (amount for amount in _charged_by_leg(db, [leg.id for leg in untransmitted]).values()), ZERO,
        )),
        "untrackedLegs": len(untracked),
        "tillPendingCount": machine.transmission_pending_count if reported else None,
        "tillPendingAmount": money(machine.transmission_pending_amount) if reported else None,
        "tillReportedAt": _iso(machine.transmission_reported_at),
        "asOf": _iso(now),
    }


def _iso(moment: Optional[datetime]) -> Optional[str]:
    """ISO text: the Z section is stored as JSON, and read back as it was stored."""
    moment = _utc(moment)
    return moment.isoformat() if moment is not None else None
