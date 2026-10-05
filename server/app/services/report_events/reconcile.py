"""
"התאמות": the event's documents against the Z reports and the card transmissions
(docs/SPEC_EVENTS.md §5).

**Z.** Per till, every Z that holds a shift of the till which overlaps the window, or the
shift of a document in the window — a shop Z (`origin = cloud`, the till's `perMachine`
section) or a till Z (`origin = till`, its one section). For each (Z × till) the Z's frozen
figures are set against the documents of the Z's shifts of that till, split into those
inside the event's window and those outside it:

* Z − (inside + outside) ≠ 0 → the Z does not add up to its documents: a mismatch (late or
  amended documents after the Z was built are the usual cause, and are shown);
* outside ≠ 0 → expected, not a mismatch: "the Z also covers sales outside the window";
* a document in the window whose shift is in no Z (or has no shift) → "waiting for a Z".

**Card transmissions.** Per till, the card legs of the window's documents: transmitted
(the leg is marked with its batch, matched by the terminal's uid), not yet transmitted
(a uid, after the till's tracking start, no batch) and unmatched (no uid, or before
tracking). Every batch carrying them, and every attempt of the till since the event began,
is listed; a failed or unanswered one is flagged. A batch whose uids are kept is compared
per transaction (legs marked to it vs its count and amount); one without is compared at the
level of amounts — the till's card legs since its previous successful batch — and says so.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models.card_transmission import CardTransmission, TransmissionStatus
from app.models.pos_machine import POSMachine
from app.models.report_event import ReportEvent
from app.models.shift import Shift
from app.models.transaction import Transaction
from app.models.transaction_payment import TransactionPayment
from app.models.z_report import ZOrigin, ZReport
from app.services.dashboard_stats import SALE_STATUSES
from app.services.tenders import refund_condition

from .common import (
    CENT,
    FIGURE_KEYS,
    FIGURE_LABELS,
    ZERO,
    Doc,
    chunks,
    dec,
    figures,
    figures_out,
    iso,
    make_doc,
    money,
    utc,
)

#: Transmission attempts are listed up to this long after the event ended.
TRANSMISSION_LOOKAHEAD = timedelta(days=7)
_COMPARED = ("sales", "refunds", "cash", "card", "other", "tips", "count")


def _uuid(value: Any) -> Optional[uuid.UUID]:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def z_label(z: ZReport) -> str:
    if z.origin == ZOrigin.TILL:
        return f"Z קופה #{z.machine_sequence_number}" if z.machine_sequence_number else "Z קופה"
    if z.per_machine is None:
        return f"Z #{z.shop_sequence_number}" if z.shop_sequence_number else "Z (ישן)"
    return f"Z סניפי #{z.shop_sequence_number}" if z.shop_sequence_number else "Z סניפי"


def _section_figures(section: Dict[str, Any]) -> Dict[str, Decimal]:
    breakdown = section.get("paymentBreakdown") or {}
    other = sum(
        (dec(v) for k, v in breakdown.items() if (k or "").strip().lower() not in ("cash", "card", "exchange")),
        ZERO,
    )
    sales = dec(section.get("totalSales"))
    refunds = dec(section.get("totalRefunds"))
    return {
        "sales": sales,
        "refunds": refunds,
        "net": sales - refunds,
        "cash": dec(section.get("totalCash")),
        "card": dec(section.get("totalCard")),
        "other": other,
        "exchange": dec(section.get("totalExchange")),
        "tips": dec(section.get("totalTips")),
        "count": Decimal(int(section.get("transactionsCount") or 0)),
    }


def _load_docs(db: Session, query) -> List[Doc]:
    txs = query.all()
    if not txs:
        return []
    legs: Dict[Any, List[TransactionPayment]] = {}
    ids = [t.id for t in txs]
    for chunk in chunks(ids):
        for leg in db.query(TransactionPayment).filter(TransactionPayment.transaction_id.in_(list(chunk))).all():
            legs.setdefault(leg.transaction_id, []).append(leg)
    return [make_doc(t, legs.get(t.id, [])) for t in txs]


def reconcile_z(
    db: Session,
    event: ReportEvent,
    machines: Dict[str, POSMachine],
    docs: Sequence[Doc],
    window_shifts: Sequence[Shift],
) -> Dict[str, Any]:
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    till_ids = [m.id for m in machines.values()]

    shifts: Dict[str, Shift] = {str(s.id): s for s in window_shifts}
    missing = sorted({d.shift_id for d in docs if d.shift_id and d.shift_id not in shifts})
    for chunk in chunks(missing):
        for s in db.query(Shift).filter(Shift.id.in_([_uuid(i) for i in chunk])).all():
            shifts[str(s.id)] = s

    z_ids = {s.z_report_id for s in shifts.values() if s.z_report_id and str(s.machine_id) in machines}
    zs = (
        {z.id: z for z in db.query(ZReport).filter(ZReport.id.in_(list(z_ids))).all()}
        if z_ids else {}
    )
    # Every shift of the event's tills in those Zs — a Z may take shifts outside the window.
    z_shifts: Dict[Tuple[Any, str], List[Shift]] = {}
    if zs:
        for s in (
            db.query(Shift)
            .filter(Shift.z_report_id.in_(list(zs)), Shift.machine_id.in_(till_ids))
            .all()
        ):
            z_shifts.setdefault((s.z_report_id, str(s.machine_id)), []).append(s)

    machine_names = {mid: m.name for mid, m in machines.items()}
    rows: List[Dict[str, Any]] = []
    z_out: List[Dict[str, Any]] = []
    for z in sorted(zs.values(), key=lambda z: (utc(z.closed_at) or utc(z.created_at), str(z.id))):
        sections = {str(s.get("machineId")): s for s in (z.per_machine or []) if isinstance(s, dict)}
        label = z_label(z)
        tills_here = [mid for (zid, mid) in z_shifts if zid == z.id]
        z_out.append({
            "id": str(z.id),
            "label": label,
            "origin": "till" if z.origin == ZOrigin.TILL else "shop",
            "number": z.z_number,
            "businessDate": z.business_date.isoformat() if z.business_date else None,
            "closedAt": iso(z.closed_at),
            "periodStart": iso(z.period_start),
            "periodEnd": iso(z.period_end),
            "tills": [machine_names[m] for m in tills_here if m in machine_names],
            "otherTills": [
                s.get("machineName") or s.get("machineCode") or "—"
                for mid, s in sections.items() if mid not in machines
            ],
            "lateDocuments": int(z.late_documents or 0),
            "amendedDocuments": int(z.amended_documents or 0),
        })
        for mid in tills_here:
            shift_ids = {str(s.id) for s in z_shifts[(z.id, mid)]}
            inside = [d for d in docs if d.shift_id in shift_ids and d.machine_id == mid]
            outside = _load_docs(
                db,
                db.query(Transaction).filter(
                    Transaction.shift_id.in_([_uuid(i) for i in shift_ids]),
                    Transaction.machine_id == machines[mid].id,
                    Transaction.status.in_(SALE_STATUSES),
                    or_(Transaction.created_at < starts, Transaction.created_at >= ends),
                ),
            )
            f_in, f_out = figures(inside), figures(outside)
            section = sections.get(mid)
            row: Dict[str, Any] = {
                "zReportId": str(z.id),
                "label": label,
                "machineId": mid,
                "machineName": machine_names.get(mid, "—"),
                "inWindow": figures_out(f_in),
                "outsideWindow": figures_out(f_out),
                "coversOutside": f_out["count"] > 0,
                "outsideNet": money(f_out["net"]),
                "lateDocuments": int(z.late_documents or 0),
                "amendedDocuments": int(z.amended_documents or 0),
                "z": None,
                "diff": None,
                "diffText": [],
            }
            if section is None:
                row["status"] = "legacy"
            else:
                f_z = _section_figures(section)
                diff = {k: f_z[k] - f_in[k] - f_out[k] for k in FIGURE_KEYS}
                row["z"] = figures_out(f_z)
                row["diff"] = figures_out(diff)
                off = [k for k in _COMPARED if abs(diff[k]) > (0 if k == "count" else CENT)]
                row["diffText"] = [(FIGURE_LABELS[k], money(diff[k])) for k in off if k != "count"]
                if "count" in off:
                    row["diffText"].append((FIGURE_LABELS["count"], float(diff["count"])))
                row["status"] = "mismatch" if off else "match"
            rows.append(row)

    tills_out = []
    for mid, machine in machines.items():
        mine = [d for d in docs if d.machine_id == mid]
        pending = [
            d for d in mine
            if d.shift_id is None or shifts.get(d.shift_id) is None or shifts[d.shift_id].z_report_id is None
        ]
        in_z = [d for d in mine if d not in pending]
        tills_out.append({
            "machineId": mid,
            "name": machine.name,
            "eventNet": money(sum((d.net for d in mine), ZERO)),
            "inZ": {"count": len(in_z), "net": money(sum((d.net for d in in_z), ZERO))},
            "pendingZ": {"count": len(pending), "net": money(sum((d.net for d in pending), ZERO))},
            "zLabels": [r["label"] for r in rows if r["machineId"] == mid],
        })

    if any(r["status"] == "mismatch" for r in rows):
        overall = "mismatch"
    elif any(t["pendingZ"]["count"] for t in tills_out):
        overall = "pending"
    elif rows:
        overall = "match"
    else:
        overall = "none"
    return {"status": overall, "zReports": z_out, "rows": rows, "tills": tills_out}


def _matched_by_batch(db: Session, batch_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, Tuple[int, Decimal]]:
    """Per batch: the card legs marked to it (any time) — count and signed amount."""
    if not batch_ids:
        return {}
    signed = case((refund_condition(), -TransactionPayment.amount), else_=TransactionPayment.amount)
    rows = (
        db.query(TransactionPayment.transmission_id, func.count(TransactionPayment.id), func.coalesce(func.sum(signed), 0))
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(TransactionPayment.transmission_id.in_(list(batch_ids)))
        .group_by(TransactionPayment.transmission_id)
        .all()
    )
    return {r[0]: (int(r[1]), dec(r[2])) for r in rows}


def _legs_between(db: Session, machine: POSMachine, after: Optional[datetime], until: datetime) -> Tuple[int, Decimal]:
    """The till's card legs of counted documents in (after, until] — count, signed amount."""
    signed = case((refund_condition(), -TransactionPayment.amount), else_=TransactionPayment.amount)
    q = (
        db.query(func.count(TransactionPayment.id), func.coalesce(func.sum(signed), 0))
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(
            Transaction.machine_id == machine.id,
            TransactionPayment.method == "card",
            Transaction.status.in_(SALE_STATUSES),
            Transaction.created_at <= until,
        )
    )
    if after is not None:
        q = q.filter(Transaction.created_at > after)
    count, amount = q.one()
    return int(count or 0), dec(amount)


def reconcile_transmissions(
    db: Session,
    event: ReportEvent,
    machines: Dict[str, POSMachine],
    docs: Sequence[Doc],
    now: datetime,
    tz,
) -> Dict[str, Any]:
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    horizon = min(now, ends + TRANSMISSION_LOOKAHEAD)
    tills_out: List[Dict[str, Any]] = []
    any_mismatch = any_pending = any_rows = False

    for mid, machine in machines.items():
        tracking = utc(machine.transmission_tracking_started_at)
        card = [
            (d, amount, leg) for d in docs if d.machine_id == mid
            for bucket, _raw, amount, leg in d.legs if bucket == "card"
        ]
        transmitted = [(d, a, l) for d, a, l in card if l is not None and l.transmission_id is not None]
        untransmitted = [
            (d, a, l) for d, a, l in card
            if l is not None and l.transmission_id is None and l.terminal_uid
            and tracking is not None and d.at >= tracking
        ]
        done = {id(x[2]) for x in transmitted} | {id(x[2]) for x in untransmitted}
        untracked = [x for x in card if x[2] is None or id(x[2]) not in done]

        in_window: Dict[Any, List[Decimal]] = {}
        for _d, amount, leg in transmitted:
            in_window.setdefault(leg.transmission_id, []).append(amount)
        batch_rows: Dict[Any, CardTransmission] = {}
        if in_window:
            for b in db.query(CardTransmission).filter(CardTransmission.id.in_(list(in_window))).all():
                batch_rows[b.id] = b
        for b in (
            db.query(CardTransmission)
            .filter(
                CardTransmission.machine_id == machine.id,
                CardTransmission.started_at >= starts,
                CardTransmission.started_at <= horizon,
            )
            .all()
        ):
            batch_rows[b.id] = b
        matched = _matched_by_batch(db, list(batch_rows))

        batches = []
        for b in sorted(batch_rows.values(), key=lambda b: utc(b.started_at)):
            legs_here = in_window.get(b.id, [])
            level = "transaction" if (b.terminal_transaction_count or 0) > 0 else "amounts"
            entry: Dict[str, Any] = {
                "id": str(b.id),
                "batchNumber": b.batch_number,
                "status": b.status,
                "trigger": b.trigger,
                "startedAt": iso(b.started_at),
                "startedAtText": utc(b.started_at).astimezone(tz).strftime("%d/%m %H:%M"),
                "finishedAt": iso(b.finished_at),
                "transactionCount": b.transaction_count,
                "amount": money(b.amount) if b.amount is not None else None,
                "legsInWindow": len(legs_here),
                "amountInWindow": money(sum(legs_here, ZERO)),
                "level": level,
                "legsCompared": None,
                "amountCompared": None,
                "compare": None,
                "message": b.status_message or b.error,
            }
            if b.status == TransmissionStatus.SUCCESS:
                if level == "transaction":
                    count, amount = matched.get(b.id, (0, ZERO))
                else:
                    prev = (
                        db.query(CardTransmission.started_at)
                        .filter(
                            CardTransmission.machine_id == machine.id,
                            CardTransmission.status == TransmissionStatus.SUCCESS,
                            CardTransmission.started_at < b.started_at,
                        )
                        .order_by(CardTransmission.started_at.desc())
                        .first()
                    )
                    after = utc(prev[0]) if prev else tracking
                    count, amount = _legs_between(db, machine, after, utc(b.started_at))
                entry["legsCompared"] = count
                entry["amountCompared"] = money(amount)
                if b.transaction_count is None and b.amount is None:
                    entry["compare"] = "n/a"
                else:
                    off = (b.transaction_count is not None and b.transaction_count != count) or (
                        b.amount is not None and abs(dec(b.amount) - amount) > CENT
                    )
                    entry["compare"] = "mismatch" if off else "match"
                    any_mismatch = any_mismatch or off
            else:
                any_mismatch = True
            batches.append(entry)

        any_pending = any_pending or bool(untransmitted)
        any_rows = any_rows or bool(card) or bool(batches)
        reported = machine.transmission_reported_at is not None

        def block(rows) -> Dict[str, Any]:
            return {"count": len(rows), "amount": money(sum((a for _d, a, _l in rows), ZERO))}

        un = block(untransmitted)
        un["oldestAt"] = iso(min((d.at for d, _a, _l in untransmitted), default=None))
        tills_out.append({
            "machineId": mid,
            "name": machine.name,
            "trackingStartedAt": iso(tracking),
            "cardLegs": block(card),
            "transmitted": block(transmitted),
            "untransmitted": un,
            "untracked": block(untracked),
            "batches": batches,
            "tillPending": {
                "count": machine.transmission_pending_count if reported else None,
                "amount": money(machine.transmission_pending_amount) if reported and machine.transmission_pending_amount is not None else None,
                "reportedAt": iso(machine.transmission_reported_at),
            },
        })

    overall = "mismatch" if any_mismatch else "pending" if any_pending else "match" if any_rows else "none"
    return {"status": overall, "tills": tills_out}
