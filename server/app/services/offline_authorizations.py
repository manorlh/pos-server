"""
Offline (deferred) card authorization — Nayax/Agamento `authorizePendingTransactions`.

A sale the terminal approved on its own while the acquirer was out of reach is held until
the till sends it for authorization. The acquirer may then decline it: the document
stands, the money will not come. This module holds the cloud's side of that:

* **Reports** (`record_report`): every run the till makes, idempotent by the till's id,
  with the uids it answered and their outcome.
* **On the X and the Z** (`offline_block`): the card legs of a period that went through
  such a run, matched per till by the terminal's uid — and the declined ones by name.
* **Elsewhere on the dashboard**: per shift (`declined_by_shift`), per document
  (`outcomes_by_transaction`), and the runs over a range (`build_report`).

Nothing here marks a leg or gates a shift close or a Z. The X and the Z only *show* it.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, exists, func
from sqlalchemy.orm import Session

from app.models.offline_authorization import (
    OfflineAuthorization,
    OfflineAuthorizationItem,
    OfflineOutcome,
)
from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.schemas.offline_authorization import (
    OfflineAuthorizationIn,
    OfflineAuthorizationReportResponse,
    OfflineAuthorizationRowOut,
    OfflineAuthorizationTotalsOut,
    OfflineDeclinedLegOut,
)
from app.services.scoping import scope_query_by_user
from app.services.transmissions import CARD_METHOD, ZERO, _iso, _utc, money

CENT = Decimal("0.01")


# ── Reports ───────────────────────────────────────────────────────────────────


@dataclass
class ReportOutcome:
    authorization: OfflineAuthorization
    created: bool


def record_report(
    db: Session, machine: POSMachine, body: OfflineAuthorizationIn, *, now: Optional[datetime] = None
) -> ReportOutcome:
    """
    Store one run. Idempotent by the till's id: the same id again is a no-op (the run's
    outcome does not change), another till's id is refused.
    """
    now = now or datetime.now(timezone.utc)
    existing = db.query(OfflineAuthorization).filter(OfflineAuthorization.id == body.id).first()
    if existing is not None:
        if existing.machine_id != machine.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="offline_authorization_id_conflict"
            )
        return ReportOutcome(existing, False)

    row = OfflineAuthorization(
        id=body.id,
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        authorized_at=_utc(body.authorized_at),
        status_code=body.status_code,
        total_amount_agorot=body.total_amount,
        total_count=body.total_count,
        created_at=now,
    )
    db.add(row)
    db.flush()
    # A uid in both lists is kept as declined: the decline is the one that costs money.
    declined = set(body.declined)
    outcomes = [(uid, OfflineOutcome.DECLINED) for uid in body.declined]
    outcomes += [(uid, OfflineOutcome.APPROVED) for uid in body.approved if uid not in declined]
    db.add_all(
        OfflineAuthorizationItem(
            id=uuid.uuid4(),
            authorization_id=row.id,
            machine_id=machine.id,
            terminal_uid=uid,
            outcome=outcome,
        )
        for uid, outcome in outcomes
    )
    db.flush()
    return ReportOutcome(row, True)


# ── On the X and the Z ────────────────────────────────────────────────────────


def offline_block(db: Session, machine: POSMachine, shifts: Sequence[Shift]) -> dict:
    """
    The informational `offline` block of an X or of one till's Z section: the period's
    card legs that an offline authorization run of this till approved or declined. A uid
    declined by any run is declined, whatever another run said.
    """
    shift_ids = [s.id for s in shifts]
    legs = []
    if shift_ids:
        legs = (
            db.query(TransactionPayment, Transaction)
            .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
            .filter(
                Transaction.shift_id.in_(shift_ids),
                Transaction.machine_id == machine.id,
                TransactionPayment.method == CARD_METHOD,
                TransactionPayment.terminal_uid.isnot(None),
            )
            .all()
        )

    uids = list({leg.terminal_uid for leg, _tx in legs})
    outcomes: Dict[str, Set[str]] = {}
    authorizations: Set[uuid.UUID] = set()
    # Chunked: a day's card legs can be hundreds, and an IN list has its limits.
    for start in range(0, len(uids), 500):
        rows = (
            db.query(
                OfflineAuthorizationItem.terminal_uid,
                OfflineAuthorizationItem.outcome,
                OfflineAuthorizationItem.authorization_id,
            )
            .filter(
                OfflineAuthorizationItem.machine_id == machine.id,
                OfflineAuthorizationItem.terminal_uid.in_(uids[start:start + 500]),
            )
            .all()
        )
        for uid, outcome, authorization_id in rows:
            outcomes.setdefault(uid, set()).add(outcome)
            authorizations.add(authorization_id)

    approved: List[TransactionPayment] = []
    declined = []
    for leg, tx in legs:
        seen = outcomes.get(leg.terminal_uid)
        if not seen:
            continue
        if OfflineOutcome.DECLINED in seen:
            declined.append((leg, tx))
        else:
            approved.append(leg)
    declined.sort(key=lambda pair: (_utc(pair[1].created_at), pair[0].sequence or 0))

    return {
        "authorizationCount": len(authorizations),
        "approvedCount": len(approved),
        "approvedAmount": money(sum((leg.amount for leg in approved), ZERO)),
        "declinedCount": len(declined),
        "declinedAmount": money(sum((leg.amount for leg, _tx in declined), ZERO)),
        "declined": [
            {
                "transactionId": str(tx.id),
                "documentNumber": tx.transaction_number,
                "amount": money(leg.amount),
                "terminalUid": leg.terminal_uid,
                "at": _iso(tx.created_at),
            }
            for leg, tx in declined
        ],
    }


def z_totals(sections: Optional[Sequence[dict]]) -> Optional[Dict[str, object]]:
    """
    The Z's offline figures: the sum of its sections' own blocks, as stored. None when no
    section carries one (a Z built before the block, or a legacy Z).
    """
    blocks = [s.get("offline") for s in (sections or []) if isinstance(s.get("offline"), dict)]
    if not blocks:
        return None
    return {
        "authorization_count": sum(int(b.get("authorizationCount") or 0) for b in blocks),
        "approved_count": sum(int(b.get("approvedCount") or 0) for b in blocks),
        "declined_count": sum(int(b.get("declinedCount") or 0) for b in blocks),
        "declined_amount": sum((Decimal(str(b.get("declinedAmount") or "0")) for b in blocks), ZERO),
    }


def section_declined(section: dict) -> Tuple[int, Decimal]:
    """A stored Z section's declined (count, amount); zero for one built before the block."""
    block = section.get("offline") if isinstance(section, dict) else None
    if not isinstance(block, dict):
        return 0, ZERO
    return int(block.get("declinedCount") or 0), Decimal(str(block.get("declinedAmount") or "0"))


# ── Elsewhere on the dashboard ────────────────────────────────────────────────


def _declined_exists():
    """The leg's uid was declined by a run of the leg's own till."""
    return exists().where(
        OfflineAuthorizationItem.machine_id == Transaction.machine_id,
        OfflineAuthorizationItem.terminal_uid == TransactionPayment.terminal_uid,
        OfflineAuthorizationItem.outcome == OfflineOutcome.DECLINED,
    )


def declined_by_shift(
    db: Session, shift_ids: Sequence[uuid.UUID]
) -> Dict[uuid.UUID, Tuple[int, Decimal]]:
    """Per shift: (count, amount) of its card legs a run of its till declined. One query."""
    if not shift_ids:
        return {}
    rows = (
        db.query(
            Transaction.shift_id,
            func.count(TransactionPayment.id),
            func.coalesce(func.sum(TransactionPayment.amount), 0),
        )
        .select_from(TransactionPayment)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(
            Transaction.shift_id.in_(list(shift_ids)),
            TransactionPayment.method == CARD_METHOD,
            TransactionPayment.terminal_uid.isnot(None),
            _declined_exists(),
        )
        .group_by(Transaction.shift_id)
        .all()
    )
    return {r[0]: (int(r[1]), Decimal(r[2]).quantize(CENT)) for r in rows}


def outcomes_by_transaction(
    db: Session, transaction_ids: Sequence[uuid.UUID]
) -> Dict[uuid.UUID, str]:
    """
    Per document: `declined` if a run of its till declined any of its card legs, else
    `approved` if a run approved one; absent if no run answered any. One query.
    """
    if not transaction_ids:
        return {}
    rows = (
        db.query(TransactionPayment.transaction_id, OfflineAuthorizationItem.outcome)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .join(
            OfflineAuthorizationItem,
            and_(
                OfflineAuthorizationItem.machine_id == Transaction.machine_id,
                OfflineAuthorizationItem.terminal_uid == TransactionPayment.terminal_uid,
            ),
        )
        .filter(
            TransactionPayment.transaction_id.in_(list(transaction_ids)),
            TransactionPayment.method == CARD_METHOD,
        )
        .distinct()
        .all()
    )
    out: Dict[uuid.UUID, str] = {}
    for transaction_id, outcome in rows:
        if outcome == OfflineOutcome.DECLINED or transaction_id not in out:
            out[transaction_id] = outcome
    return out


# ── The report: runs over a range ─────────────────────────────────────────────

#: Runs one report returns; a range with more says so (`truncated`).
REPORT_ROWS_MAX = 1000


def _legs_by_uid(
    db: Session, tenant_id, pairs: Set[Tuple[uuid.UUID, str]]
) -> Dict[Tuple[uuid.UUID, str], Tuple[TransactionPayment, Transaction]]:
    """The card leg each (till, uid) names — the oldest, should a uid repeat."""
    out: Dict[Tuple[uuid.UUID, str], Tuple[TransactionPayment, Transaction]] = {}
    if not pairs:
        return out
    machine_ids = list({m for m, _uid in pairs})
    uids = sorted({uid for _m, uid in pairs})
    # Chunked: a range's runs can name many uids, and an IN list has its limits.
    for start in range(0, len(uids), 500):
        rows = (
            db.query(TransactionPayment, Transaction)
            .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
            .filter(
                Transaction.tenant_id == tenant_id,
                Transaction.machine_id.in_(machine_ids),
                TransactionPayment.method == CARD_METHOD,
                TransactionPayment.terminal_uid.in_(uids[start:start + 500]),
            )
            .order_by(Transaction.created_at.asc())
            .all()
        )
        for leg, tx in rows:
            key = (tx.machine_id, leg.terminal_uid)
            if key in pairs:
                out.setdefault(key, (leg, tx))
    return out


def build_report(
    db: Session,
    current_user,
    tenant_id,
    window,
    *,
    shop_id: Optional[uuid.UUID] = None,
    machine_id: Optional[uuid.UUID] = None,
) -> OfflineAuthorizationReportResponse:
    """
    The runs reported in the window (by `authorizedAt`), newest first, each with its
    declined uids matched to the till's card legs. Scoped like every report here: a role
    that sees nothing gets an empty report, not an error.
    """
    empty = OfflineAuthorizationReportResponse(
        window=window.to_schema(),
        generated_at=datetime.now(timezone.utc),
        totals=OfflineAuthorizationTotalsOut(),
        items=[],
    )
    query = db.query(OfflineAuthorization).filter(
        OfflineAuthorization.tenant_id == tenant_id,
        OfflineAuthorization.authorized_at >= window.start,
        OfflineAuthorization.authorized_at < window.end,
    )
    query = scope_query_by_user(
        query,
        current_user,
        db,
        shop_column=OfflineAuthorization.shop_id,
        machine_column=OfflineAuthorization.machine_id,
    )
    if query is None:
        return empty
    if shop_id is not None:
        query = query.filter(OfflineAuthorization.shop_id == shop_id)
    if machine_id is not None:
        query = query.filter(OfflineAuthorization.machine_id == machine_id)
    runs: List[OfflineAuthorization] = (
        query.order_by(OfflineAuthorization.authorized_at.desc(), OfflineAuthorization.id.asc())
        .limit(REPORT_ROWS_MAX + 1)
        .all()
    )
    truncated = len(runs) > REPORT_ROWS_MAX
    runs = runs[:REPORT_ROWS_MAX]
    if not runs:
        return empty

    items_of: Dict[uuid.UUID, List[OfflineAuthorizationItem]] = {}
    run_ids = [r.id for r in runs]
    for start in range(0, len(run_ids), 500):
        for item in (
            db.query(OfflineAuthorizationItem)
            .filter(OfflineAuthorizationItem.authorization_id.in_(run_ids[start:start + 500]))
            .order_by(OfflineAuthorizationItem.terminal_uid.asc())
            .all()
        ):
            items_of.setdefault(item.authorization_id, []).append(item)

    legs = _legs_by_uid(
        db, tenant_id, {(i.machine_id, i.terminal_uid) for items in items_of.values() for i in items}
    )
    machines = {
        m.id: m
        for m in db.query(POSMachine).filter(POSMachine.id.in_({r.machine_id for r in runs})).all()
    }
    shop_ids = {r.shop_id for r in runs if r.shop_id is not None}
    shop_names = dict(db.query(Shop.id, Shop.name).filter(Shop.id.in_(shop_ids)).all()) if shop_ids else {}

    totals = OfflineAuthorizationTotalsOut(authorization_count=len(runs))
    rows: List[OfflineAuthorizationRowOut] = []
    for run in runs:
        approved_count = 0
        approved_amount = ZERO
        declined: List[OfflineDeclinedLegOut] = []
        for item in items_of.get(run.id, []):
            leg, tx = legs.get((item.machine_id, item.terminal_uid), (None, None))
            if item.outcome == OfflineOutcome.APPROVED:
                approved_count += 1
                approved_amount += Decimal(leg.amount) if leg is not None else ZERO
                continue
            declined.append(
                OfflineDeclinedLegOut(
                    terminal_uid=item.terminal_uid,
                    matched=leg is not None,
                    transaction_id=tx.id if tx is not None else None,
                    document_number=tx.transaction_number if tx is not None else None,
                    amount=Decimal(leg.amount).quantize(CENT) if leg is not None else None,
                    sold_at=_utc(tx.created_at) if tx is not None else None,
                )
            )
        # The terminal's own total is the authority on what it approved; the legs we
        # hold may not all have reached the cloud yet.
        if run.total_amount_agorot is not None:
            approved_amount = Decimal(run.total_amount_agorot) / 100
        declined_amount = sum((d.amount for d in declined if d.amount is not None), ZERO)
        unmatched = sum(1 for d in declined if not d.matched)
        machine = machines.get(run.machine_id)
        rows.append(
            OfflineAuthorizationRowOut(
                id=run.id,
                authorized_at=_utc(run.authorized_at),
                received_at=_utc(run.created_at),
                shop_id=run.shop_id,
                shop_name=shop_names.get(run.shop_id),
                machine_id=run.machine_id,
                machine_name=machine.name if machine is not None else None,
                pos_number=machine.pos_number if machine is not None else None,
                status_code=run.status_code,
                approved_count=approved_count,
                approved_amount=approved_amount.quantize(CENT),
                declined_count=len(declined),
                declined_amount=declined_amount.quantize(CENT),
                declined_unmatched_count=unmatched,
                declined=declined,
            )
        )
        totals.approved_count += approved_count
        totals.approved_amount += approved_amount
        totals.declined_count += len(declined)
        totals.declined_amount += declined_amount
        totals.declined_unmatched_count += unmatched
    totals.approved_amount = totals.approved_amount.quantize(CENT)
    totals.declined_amount = totals.declined_amount.quantize(CENT)

    return OfflineAuthorizationReportResponse(
        window=window.to_schema(),
        generated_at=empty.generated_at,
        totals=totals,
        items=rows,
        truncated=truncated,
    )
