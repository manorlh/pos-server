"""
No Z with missing documents (docs/SHIFTS_API.md §2.6-bis).

The owner: every document a till issued is in its shift, its X and its Z. A cloud Z is built
from the documents the cloud holds — so a Z built while documents it should contain are
*known* to be missing files a Z without them, and the gap reaches the open-format export.
The cloud knows a document is missing when:

* **the close counted more** — a shift the Z takes was closed with the till's own count of
  its documents (`till.transactionsCount`), and the cloud holds fewer in it. Checked
  whatever the close listed: a close with an empty `transactionIds` used to skip every
  check, and its X was filed as empty;
* **a number is missing** — among the till's documents of a series, a number between the
  last one it held before the Z's first and the Z's last is held by no document of the till
  (any status: a cancelled document used its number). A number held in another series
  counts as held (an older till numbered every type on one counter);
* **the till said so** — with no shift of the till open (in the cloud or by its own
  report) and the Z taking its newest closed shift: documents it reported unsent
  (`pendingDocuments`) that have not arrived since that report, and numbers up to its
  reported counter that the cloud holds none of;
* **the cloud refused one** — a refusal of that till's document still open
  (`document_refusals`), issued within the Z's period.

Such a Z waits (`waiting_documents` on the till's item of the run, with why), is tried again
on every poll of the run and whenever a document of that till lands, and keeps its number:
no other cloud Z of the shop is started while one waits for documents (409
`z_waiting_for_documents`). `confirmCloudData` does not pass it. The ways on: the till
delivers them; the operator builds the Z without that till (its shifts wait for the next
Z, which waits the same way); or, for a till that will never come back, support's Z from
the cloud (§4.6 of docs/SPEC_OFFLINE_TILL_Z.md), which records the gaps.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Set

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.transaction import Transaction

#: The item code of a run waiting for documents the cloud knows are missing.
WAITING_DOCUMENTS = "waiting_documents"
#: The 409 detail of a cloud Z started while another of the shop waits for documents.
Z_WAITING_FOR_DOCUMENTS = "z_waiting_for_documents"
#: Numbers listed in a reason (the rest are counted).
NUMBERS_SHOWN = 20
#: The widest number span looked at (a corrupt number must not make the check spin).
SPAN_MAX = 5000
#: A run of more missing numbers than this is a jump of the till's counter (a reinstall,
#: another numbering), not documents in its outbox: shown by the reconciliation's
#: document-number check, never a reason for a Z to wait.
GAP_RUN_MAX = 100


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _int(value: Any) -> Optional[int]:
    try:
        return None if value is None or isinstance(value, bool) else int(float(value))
    except (TypeError, ValueError):
        return None


def _spans(numbers: Sequence[int]) -> str:
    ordered = sorted(set(numbers))
    out: List[str] = []
    start = prev = None
    for n in ordered + [None]:  # type: ignore[list-item]
        if start is None:
            start = prev = n
            continue
        if n is not None and n == prev + 1:
            prev = n
            continue
        out.append(str(start) if start == prev else f"{start}–{prev}")
        start = prev = n
    shown = out[:NUMBERS_SHOWN]
    return ", ".join(shown) + (" …" if len(out) > NUMBERS_SHOWN else "")


def _numeric(number: Optional[str]) -> Optional[int]:
    text = (number or "").strip()
    return int(text) if text.isdigit() and len(text) <= 18 else None


def _till_label(machine: POSMachine) -> str:
    number = (machine.pos_number or "").strip()
    return f"קופה {number}" if number else (machine.name or "הקופה")


def missing_for_z(
    db: Session, machine: POSMachine, shifts: Sequence[Shift], *, takes_newest: bool = True,
) -> Dict[str, Any]:
    """
    What the cloud knows is missing from a Z of `machine` over `shifts` (oldest first):
    `{"missing": n, "reasons": [{"code", "count", "text", …}]}` — `missing` 0 when nothing is
    known to be. `takes_newest`: the Z takes the till's newest closed shift (the till's own
    reports are read only then).
    """
    from app.services.document_filing import is_cloud_built
    from app.services.document_prefix import document_series_of
    from app.services.shift_totals import compute_totals

    reasons: List[Dict[str, Any]] = []
    own = [s for s in shifts if not is_cloud_built(s)]

    # 1. The till's count at the close of each shift, against what the cloud holds in it.
    for shift in own:
        claimed = _int((shift.till_totals or {}).get("transactionsCount")) if isinstance(shift.till_totals, dict) else None
        if claimed is None:
            continue
        held = compute_totals(db, [shift.id]).transactions_count
        if claimed > held:
            reasons.append({
                "code": "close_count",
                "count": claimed - held,
                "shiftId": str(shift.id),
                "sequenceNumber": shift.sequence_number,
                "till": claimed,
                "cloud": held,
                "text": (
                    f"משמרת {shift.sequence_number or ''} נסגרה בקופה עם {claimed} מסמכים — בענן {held}".replace("  ", " ")
                ),
            })

    # 2. Number gaps, per series, from the number held before the Z's first to its last.
    shift_ids = {s.id for s in shifts}
    rows = (
        db.query(Transaction.transaction_number, Transaction.document_type, Transaction.refund_of_transaction_id,
                 Transaction.shift_id)
        .filter(Transaction.machine_id == machine.id)
        .all()
    )
    held_any: Set[int] = set()
    held_by_series: Dict[int, Set[int]] = {}
    in_z: Dict[int, List[int]] = {}
    for number, doc_type, refund_of, shift_id in rows:
        n = _numeric(number)
        if n is None:
            continue
        series = int(document_series_of(doc_type, refund_of))
        held_any.add(n)
        held_by_series.setdefault(series, set()).add(n)
        if shift_id in shift_ids:
            in_z.setdefault(series, []).append(n)
    gap_numbers: List[int] = []
    for series, numbers in in_z.items():
        lo, hi = min(numbers), max(numbers)
        below = [n for n in held_by_series.get(series, ()) if n < lo]
        start = (max(below) + 1) if below else lo
        if hi - start > SPAN_MAX:
            start = hi - SPAN_MAX
        absent = [n for n in range(start, hi + 1) if n not in held_by_series[series] and n not in held_any]
        run: List[int] = []
        for n in absent + [None]:  # type: ignore[list-item]
            if n is not None and (not run or n == run[-1] + 1):
                run.append(n)
                continue
            if run and len(run) <= GAP_RUN_MAX:
                gap_numbers += run
            run = [n] if n is not None else []
    gap_numbers = sorted(set(gap_numbers))
    if gap_numbers:
        reasons.append({
            "code": "number_gap",
            "count": len(gap_numbers),
            "numbers": _spans(gap_numbers),
            "text": f"חסרים מספרי מסמכים: {_spans(gap_numbers)}",
        })

    # 3. What the till itself reported, when every shift of it is closed and this Z takes
    #    its newest one (otherwise the unsent documents may be a later shift's).
    from app.services.shifts import find_open_shift

    reported_open = getattr(machine, "reported_open_shift_id", None)
    reported_open_live = (
        reported_open is not None
        and db.query(Shift.id).filter(Shift.id == reported_open, Shift.status == ShiftStatus.CLOSED).first() is None
    )
    if takes_newest and find_open_shift(db, machine.id) is None and not reported_open_live:
        pending = _int(getattr(machine, "pending_documents", None))
        since = _aware(getattr(machine, "pending_count_at", None))
        if pending and pending > 0:
            q = db.query(Transaction.id).filter(Transaction.machine_id == machine.id)
            if since is not None:
                q = q.filter(Transaction.server_received_at > since)
            arrived = q.count()
            if pending > arrived:
                reasons.append({
                    "code": "reported_unsent",
                    "count": pending - arrived,
                    "reported": pending,
                    "arrivedSince": arrived,
                    "reportedAt": since.isoformat() if since else None,
                    "text": f"הקופה דיווחה על {pending} מסמכים שטרם נשלחו; הגיעו מאז {arrived}",
                })
        counters = getattr(machine, "reported_document_counters", None)
        if isinstance(counters, dict) and held_any:
            top = max((v for v in (_int(x) for x in counters.values()) if v is not None), default=None)
            highest = max(held_any)
            if top is not None and top > highest and top - highest <= SPAN_MAX:
                ahead = list(range(highest + 1, top + 1))
                reasons.append({
                    "code": "counter_ahead",
                    "count": len(ahead),
                    "numbers": _spans(ahead),
                    "text": f"מונה המסמכים שהקופה דיווחה ({top}) גבוה מהמסמך האחרון בענן ({highest})",
                })

    # 4. The cloud's own refusals of this till's documents, issued within the Z's period.
    try:
        from app.models.document_refusal import DocumentRefusal

        if own:
            start = min(_aware(s.opened_at) for s in own if s.opened_at is not None) if any(s.opened_at for s in own) else None
            end = max((_aware(s.closed_at) or _aware(s.close_accepted_at) for s in own), default=None)
            q = db.query(DocumentRefusal.id).filter(
                DocumentRefusal.machine_id == machine.id, DocumentRefusal.landed_at.is_(None),
            )
            if start is not None:
                q = q.filter(DocumentRefusal.issued_at >= start - timedelta(minutes=10))
            if end is not None:
                q = q.filter(DocumentRefusal.issued_at <= end + timedelta(minutes=10))
            refused = q.count()
            if refused:
                reasons.append({
                    "code": "refused",
                    "count": refused,
                    "text": f"{refused} מסמכים של הקופה נדחו בענן ועוד לא נקלטו",
                })
    except Exception:  # noqa: BLE001 - an explanation must never fail the Z path
        pass

    # Overlapping evidence of the same documents is not added up: the largest is the floor.
    missing = max((int(r["count"]) for r in reasons), default=0)
    return {"missing": missing, "reasons": reasons}


def message(machine: POSMachine, found: Dict[str, Any]) -> str:
    """The run's words for a till it waits for (shown on the run and in the reconciliation)."""
    parts = "; ".join(r["text"] for r in found.get("reasons") or [])
    return (
        f"ממתין למסמכים מ{_till_label(machine)}: לפחות {found.get('missing')} מסמכים שהענן יודע שחסרים — {parts}. "
        "ה-Z ייבנה מעצמו כשיגיעו; אפשר גם לבנות בלי הקופה (המשמרות שלה יחכו ל-Z הבא) או, לקופה שלא תחזור, Z מהענן ע״י התמיכה."
    )
