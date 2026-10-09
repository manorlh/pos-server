"""
Where every document is filed — under the till that issued it, in a shift, counted exactly
once (docs/SHIFTS_API.md §1.2c-bis, §1.2d).

The owner (2026-10-07): "כרגע אין הרשאות, כולם יכולים לעשות הכל. כל מסמך שבוצע במכשירים חייב
לעלות לענן ולהיות חלק מהזד והאיקס/משמרת וכל מה שמשתמע." A document that lands with no shift,
or in another till's shift, is in no X and no Z — a fiscal gap even though it "landed". So:

**1. The issuing machine.** A device re-paired as a *new* machine (an ordinary pairing code,
not a replacement code) still delivers what it issued as its previous machine — its outbox
survives the re-pairing. The cloud links the two at pairing (`record_repair_link`: the same
device serial; `predecessor_machine_id`). A document the device delivers is the
predecessor's when it names a shift of the predecessor, or when it was issued before this
pairing (its `createdAt` is before the machine was paired, by more than the clock slack) and
after the predecessor's. It is filed under that machine — its tenant, shop, register number,
shift — with `pushed_by_machine_id` saying who delivered it. Nothing else is: a shift of an
unlinked till is never a reason to file a document under that till.

**2. The shift.** In this order:
* the shift the document names, when it is the issuing machine's (as always);
* a shift the cloud has not seen yet: created open from the document when nothing else of
  the till is open (as always) — otherwise the document waits (below), named shift kept;
* no shift, or another till's shift: the issuing machine's shift whose period covers the
  document's issue time (`covering_shift`);
* else the issuing machine's **"documents waiting for a shift"** bucket (`waiting_shift`):
  a closed, cloud-built shift of the till that no Z has taken. The till's next Z — a cloud
  run, a till Z (online or offline), support's Z, the main till's local shop Z (its late
  part) — takes it like any other shift and lists it in its own section
  ("מסמכים שהמתינו למשמרת"). A document waiting for a named shift is moved into that shift
  the moment the shift reaches the cloud (`adopt_waiting_documents`), unless a Z has
  already taken the bucket — then it is counted there, once.

**3. Same number, different id** (`numbering_holder`, §1.2d): stored too, flagged.

**The container: the Z kind of the till when the document was issued** (the owner,
2026-10-07: "הכוונה לאן שהוא צריך — אם למשמרת של הקופה, לזד עצמאי"). A till in the shop Z
(`z_mode = cloud`): its shift, then the shop's next Z. A till that makes its own Z (`z_mode =
till` — per-till, or independent): its own Z run. The till's mode over time is kept
(`pos_machines.z_mode_history`, `mode_at`), and a switch needs a clean break (no open shift,
no closed shift waiting for a Z — `z_mode_policy`, `independent_till`), so a till's own
shift is always of one mode. What the cloud builds — a waiting bucket, a carry shift of late
documents — is stamped with the mode the documents were issued under (`zMode`) and taken only
by a Z of that kind (`taken_by`): a till Z never takes a shop-Z document, and a shop Z takes
the shop-Z documents of a till that has since gone its own way (`shop_leftovers`). A till that
has *joined* the shop Z has no run of its own any more: its earlier per-till documents still
arriving go into the shop Z, in their own section (the only Z it has — as for a dead till
brought into the shop Z, §2.9).
"""
from __future__ import annotations

import logging
import types
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.transaction import Transaction

logger = logging.getLogger(__name__)

#: `shifts.reconstruction_basis.kind` of a till's "documents waiting for a shift" bucket.
WAITING_KIND = "awaiting_shift"
#: Who "opened" and "closed" the bucket, as the shift lists show it.
WAITING_BY = "מסמכים שהמתינו למשמרת"
#: Clock slack: a document issued this close to a pairing is this pairing's.
PAIRING_SKEW = timedelta(minutes=10)
#: Slack around a shift's close when a document's time is matched to it.
COVER_SLACK = timedelta(minutes=2)
#: How far back the predecessor chain is followed.
CHAIN_MAX = 5

#: Ingest notes of this module (`transactions.ingest_notes[].code`).
FILED_UNDER_ISSUING_TILL = "filed_under_issuing_till"
FILED_BY_TIME = "filed_by_time"
WAITING_FOR_SHIFT = "waiting_for_shift"
NUMBERING_CONFLICT = "numbering_conflict"

#: Why a document waits, in words (`reconstruction_basis.reasons` keys).
WAIT_REASONS = {
    "unknown_shift_while_open": "המשמרת שהמסמך נושא עוד לא הגיעה לענן בזמן שמשמרת אחרת של הקופה פתוחה",
    "unknown_shifts": "המסמכים נושאים כמה משמרות שעוד לא הגיעו לענן",
    "no_covering_shift": "אין לקופה משמרת שמכסה את מועד הפקת המסמך",
    "predecessor_unknown_shift": "המשמרת של הקופה הקודמת שהמסמך נושא לא הגיעה לענן",
}


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if not isinstance(moment, datetime):
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


#: `z_mode` values: the shop's Z, or the till's own (per-till / independent).
MODE_SHOP = "cloud"
MODE_TILL = "till"
#: Each container in words (the reconciliation's).
CONTAINER_LABELS = {
    MODE_SHOP: "משמרת של הקופה ← Z סניפי",
    MODE_TILL: "Z עצמאי של הקופה (Z לכל קופה / קופה עצמאית)",
}


def _parse(moment: Any) -> Optional[datetime]:
    if isinstance(moment, datetime):
        return _aware(moment)
    try:
        return _aware(datetime.fromisoformat(str(moment)))
    except (TypeError, ValueError):
        return None


def mode_at(machine: Optional[POSMachine], moment: Optional[datetime]) -> str:
    """The till's Z mode at `moment` (`z_mode_history`); its mode now when nothing says otherwise."""
    if machine is None:
        return MODE_SHOP
    current = MODE_TILL if getattr(machine, "z_mode", None) == MODE_TILL else MODE_SHOP
    at = _aware(moment)
    history = sorted(
        (e for e in (getattr(machine, "z_mode_history", None) or []) if isinstance(e, dict) and _parse(e.get("at"))),
        key=lambda e: _parse(e.get("at")),
    )
    if at is None or not history:
        return current
    mode = history[0].get("from") or current
    for entry in history:
        if _parse(entry["at"]) <= at:
            mode = entry.get("to") or mode
        else:
            break
    return MODE_TILL if mode == MODE_TILL else MODE_SHOP


def container_mode(shift: Optional[Shift]) -> Optional[str]:
    """The Z kind a cloud-built shift's documents were issued under (`zMode`), or None."""
    basis = getattr(shift, "reconstruction_basis", None) if shift is not None else None
    if not isinstance(basis, dict) or basis.get("kind") not in (WAITING_KIND, "late_documents"):
        return None
    mode = basis.get("zMode")
    return mode if mode in (MODE_SHOP, MODE_TILL) else None


def taken_by(shift: Shift, kind: str) -> bool:
    """
    Whether a Z of `kind` ("till" — the till's own; "cloud" — the shop's) takes this shift.
    A till's own shifts: always (a switch needs a clean break). A cloud-built one: a till Z
    only when its documents were issued in a till-Z period; a shop Z otherwise — and also
    a till-Z period's of a till that has joined the shop Z since (it has no run of its own).
    """
    mode = container_mode(shift)
    if mode is None:
        return True
    return mode == MODE_TILL if kind == MODE_TILL else True


def shop_leftovers(
    db: Session, shop_id: Any, *, exclude: Sequence[Any] = (), lock: bool = False,
) -> List[Tuple[POSMachine, List[Shift]]]:
    """
    Shop-Z documents of tills that make their own Z now: cloud-built shifts (a waiting
    bucket, late documents) of this shop issued under the shop Z, no Z has taken — the
    shop's next Z takes them, a section per till.
    """
    q = (
        db.query(Shift)
        .join(POSMachine, POSMachine.id == Shift.machine_id)
        .filter(
            Shift.shop_id == shop_id,
            Shift.z_report_id.is_(None),
            Shift.status == ShiftStatus.CLOSED,
            Shift.reconstruction_basis.isnot(None),
            POSMachine.z_mode == MODE_TILL,
        )
    )
    if exclude:
        q = q.filter(~Shift.machine_id.in_(list(exclude)))
    if lock:
        q = q.with_for_update().populate_existing()
    by_machine: Dict[Any, List[Shift]] = {}
    for shift in q.all():
        if container_mode(shift) == MODE_SHOP:
            by_machine.setdefault(shift.machine_id, []).append(shift)
    out = []
    for machine_id, shifts in by_machine.items():
        machine = db.get(POSMachine, machine_id)
        if machine is not None:
            out.append((machine, sorted(shifts, key=lambda s: _aware(s.opened_at) or datetime.min.replace(tzinfo=timezone.utc))))
    return out


def _label(machine: Optional[POSMachine]) -> str:
    number = (getattr(machine, "pos_number", None) or "").strip() if machine is not None else ""
    return f"קופה {number}" if number else ((getattr(machine, "name", None) or "הקופה") if machine is not None else "הקופה")


# ── The waiting bucket ───────────────────────────────────────────────────────


def waiting_basis(shift: Optional[Shift]) -> Dict[str, Any]:
    basis = getattr(shift, "reconstruction_basis", None) if shift is not None else None
    return basis if isinstance(basis, dict) and basis.get("kind") == WAITING_KIND else {}


def is_waiting(shift: Optional[Shift]) -> bool:
    return bool(waiting_basis(shift))


def is_cloud_built(shift: Optional[Shift]) -> bool:
    """A shift the cloud made itself — a carry shift or a waiting bucket — not one a till opened."""
    basis = getattr(shift, "reconstruction_basis", None) if shift is not None else None
    return isinstance(basis, dict) and basis.get("kind") in (WAITING_KIND, "late_documents")


def waiting_label(machine: Optional[POSMachine]) -> str:
    return f"מסמכים שהמתינו למשמרת ({_label(machine)}) — נכללים ב-Z הבא של הקופה"


def _open_bucket(db: Session, machine: POSMachine, mode: str) -> Optional[Shift]:
    rows = (
        db.query(Shift)
        .filter(
            Shift.machine_id == machine.id,
            Shift.z_report_id.is_(None),
            Shift.status == ShiftStatus.CLOSED,
            Shift.reconstruction_basis.isnot(None),
        )
        .all()
    )
    for row in rows:
        if is_waiting(row) and str(row.shop_id) == str(machine.shop_id) and (container_mode(row) or mode) == mode:
            return row
    return None


def waiting_shift(
    db: Session, machine: POSMachine, *, business_date: Optional[date], issued_at: Optional[datetime],
    reason: str, now: Optional[datetime] = None,
) -> Shift:
    """
    The till's "documents waiting for a shift" bucket no Z has taken (created when there is
    none): closed and accepted, so the till's next Z of the kind the document was issued
    under takes it (`zMode`, `taken_by`); `sequence_number` none, so it sorts first among
    the shifts that Z takes. One bucket per till and Z kind.
    """
    now = now or datetime.now(timezone.utc)
    issued = _aware(issued_at) or now
    mode = mode_at(machine, issued)
    bucket = _open_bucket(db, machine, mode)
    if bucket is None:
        bucket = Shift(
            id=uuid.uuid4(),
            tenant_id=machine.tenant_id,
            machine_id=machine.id,
            shop_id=machine.shop_id,
            area_id=getattr(machine, "area_id", None),
            business_date=business_date or issued.date(),
            sequence_number=None,
            opened_at=issued,
            closed_at=issued,
            close_accepted_at=now,
            status=ShiftStatus.CLOSED,
            unattended=True,
            reconstructed=True,
            reconstructed_by=WAITING_BY,
            opened_by=WAITING_BY,
            closed_by=WAITING_BY,
            reconstruction_basis={
                "kind": WAITING_KIND,
                "zMode": mode,
                "posNumber": getattr(machine, "pos_number", None),
                "label": waiting_label(machine),
                "createdAt": now.isoformat(),
                "reasons": {},
            },
        )
        db.add(bucket)
        db.flush()
    basis = dict(waiting_basis(bucket))
    reasons = dict(basis.get("reasons") or {})
    reasons[reason] = int(reasons.get(reason) or 0) + 1
    basis["reasons"] = reasons
    bucket.reconstruction_basis = basis
    # The bucket's period spans the documents in it (a Z's period reads it).
    if _aware(bucket.opened_at) is None or issued < _aware(bucket.opened_at):
        bucket.opened_at = issued
    if _aware(bucket.closed_at) is None or issued > _aware(bucket.closed_at):
        bucket.closed_at = issued
    return bucket


def refresh_bucket(db: Session, bucket: Optional[Shift]) -> None:
    """Recompute a bucket's X from the documents in it; an emptied bucket no Z took is removed."""
    if bucket is None or not is_waiting(bucket) or bucket.z_report_id is not None:
        return
    from app.services.shift_totals import compute_totals

    db.flush()
    left = db.query(Transaction.id).filter(Transaction.shift_id == bucket.id).count()
    if not left:
        db.delete(bucket)
        db.flush()
        return
    totals = compute_totals(db, [bucket.id])
    for column, value in totals.as_x().items():
        setattr(bucket, column, value)
    basis = dict(waiting_basis(bucket))
    basis["documents"] = left
    bucket.reconstruction_basis = basis


def adopt_waiting_documents(db: Session, shift: Shift) -> int:
    """
    A shift reached the cloud: the documents that named it and waited for it (in the till's
    bucket no Z has taken, or with no shift at all) move into it. A bucket a Z already took
    keeps them — they are counted in that Z, once. How many moved.
    """
    if shift is None or is_cloud_built(shift):
        return 0
    docs = (
        db.query(Transaction)
        .filter(Transaction.machine_id == shift.machine_id, Transaction.claimed_shift_id == shift.id)
        .all()
    )
    buckets: Dict[Any, Shift] = {}
    moved = 0
    for doc in docs:
        if doc.shift_id == shift.id:
            continue
        current = db.get(Shift, doc.shift_id) if doc.shift_id is not None else None
        if current is not None and (not is_waiting(current) or current.z_report_id is not None):
            continue
        if current is not None:
            buckets[current.id] = current
        doc.shift_id = shift.id
        doc.ingest_notes = [n for n in (doc.ingest_notes or []) if n.get("code") != WAITING_FOR_SHIFT] or None
        moved += 1
    if not moved:
        return 0
    db.flush()
    for bucket in buckets.values():
        refresh_bucket(db, bucket)
    if shift.status == ShiftStatus.CLOSED and shift.z_report_id is None:
        from app.services.shift_totals import compute_totals, till_totals_mismatch

        totals = compute_totals(db, [shift.id])
        for column, value in totals.as_x().items():
            setattr(shift, column, value)
        shift.totals_mismatch = till_totals_mismatch(shift.till_totals, totals)
    logger.warning("%s waiting document(s) moved into shift %s of machine %s", moved, shift.id, shift.machine_id)
    db.flush()
    return moved


def waiting_documents(db: Session, machine_ids: Sequence[Any]) -> Dict[Any, Dict[str, Any]]:
    """Per till: its documents in a waiting bucket no Z has taken yet — {count, buckets}."""
    if not machine_ids:
        return {}
    out: Dict[Any, Dict[str, Any]] = {}
    rows = (
        db.query(Shift)
        .filter(
            Shift.machine_id.in_(list(machine_ids)),
            Shift.z_report_id.is_(None),
            Shift.reconstruction_basis.isnot(None),
        )
        .all()
    )
    for shift in rows:
        if not is_waiting(shift):
            continue
        count = db.query(Transaction.id).filter(Transaction.shift_id == shift.id).count()
        entry = out.setdefault(shift.machine_id, {"count": 0, "shiftIds": []})
        entry["count"] += count
        entry["shiftIds"].append(str(shift.id))
    return out


def _money(value) -> Optional[str]:
    return None if value is None else str(Decimal(value).quantize(Decimal("0.01")))


def section_of(shift: Shift) -> Dict[str, Any]:
    """One waiting bucket as a Z lists it: its title, why its documents waited, counts and totals."""
    basis = waiting_basis(shift)
    return {
        "shiftId": str(shift.id),
        "machineId": str(shift.machine_id),
        "posNumber": basis.get("posNumber"),
        "label": basis.get("label") or WAITING_BY,
        "zMode": basis.get("zMode"),
        "container": CONTAINER_LABELS.get(basis.get("zMode")),
        "reasons": {k: {"count": v, "text": WAIT_REASONS.get(k, k)} for k, v in (basis.get("reasons") or {}).items()},
        "documents": shift.transactions_count or 0,
        "firstDocumentNumber": shift.first_transaction_number,
        "lastDocumentNumber": shift.last_transaction_number,
        "totalSales": _money(shift.total_sales),
        "totalRefunds": _money(shift.total_refunds),
        "totalCash": _money(shift.total_cash),
        "totalCard": _money(shift.total_card),
        "vatTotal": _money(shift.vat_total),
    }


def note_on_z(z, shifts: Iterable[Shift]) -> None:
    """The Z the builder is making takes waiting buckets: listed in their own section."""
    buckets = [s for s in shifts if is_waiting(s)]
    if buckets:
        z.header = {**(z.header or {}), "documentsAwaitingShift": [section_of(s) for s in buckets]}


# ── The covering shift ───────────────────────────────────────────────────────


def covering_shift(db: Session, machine_id: Any, moment: Optional[datetime]) -> Optional[Shift]:
    """
    The till's own shift whose period covers `moment`: opened at or before it, and closed
    at or after it (with a little slack) or still open. Never a cloud-built shift.
    """
    at = _aware(moment)
    if at is None or machine_id is None:
        return None
    candidates = (
        db.query(Shift)
        .filter(Shift.machine_id == machine_id, Shift.opened_at <= at + COVER_SLACK)
        .order_by(Shift.opened_at.desc())
        .limit(10)
        .all()
    )
    for shift in candidates:
        if is_cloud_built(shift):
            continue
        if shift.status == ShiftStatus.OPEN:
            return shift
        closed = _aware(shift.closed_at) or _aware(shift.close_accepted_at)
        if closed is not None and closed + COVER_SLACK >= at:
            return shift
    return None


# ── The issuing machine ──────────────────────────────────────────────────────


def predecessor_chain(db: Session, machine: POSMachine) -> List[POSMachine]:
    """The machines this device was before, newest first (`predecessor_machine_id`)."""
    out: List[POSMachine] = []
    seen = {machine.id}
    current = machine
    while len(out) < CHAIN_MAX:
        pid = getattr(current, "predecessor_machine_id", None)
        if not isinstance(pid, uuid.UUID) or pid in seen:
            break
        previous = db.get(POSMachine, pid)
        if previous is None:
            break
        out.append(previous)
        seen.add(previous.id)
        current = previous
    return out


def issuing_machine(
    db: Session, pusher: POSMachine, *, shift_id: Optional[uuid.UUID], created_at: Optional[datetime],
) -> Tuple[POSMachine, Optional[str]]:
    """
    (the machine that issued the document, why) — `pusher` itself unless the document is
    its predecessor's (rule 1 in the module doc): it names a shift of a predecessor
    ("named_shift"), or it was issued before this pairing and after the predecessor's
    ("issued_before_repair").
    """
    chain = predecessor_chain(db, pusher)
    if not chain:
        return pusher, None
    if shift_id is not None:
        row = db.query(Shift.machine_id).filter(Shift.id == shift_id).first()
        if row is not None:
            if str(row[0]) == str(pusher.id):
                return pusher, None
            for previous in chain:
                if str(previous.id) == str(row[0]):
                    return previous, "named_shift"
    issued = _aware(created_at)
    paired = _aware(getattr(pusher, "created_at", None))
    if issued is None or paired is None or issued >= paired - PAIRING_SKEW:
        return pusher, None
    for previous in chain:
        since = _aware(getattr(previous, "created_at", None))
        if since is None or issued >= since - PAIRING_SKEW:
            return previous, "issued_before_repair"
    return pusher, None


def filed_under_note(issuer: POSMachine, pusher: POSMachine) -> dict:
    return {
        "code": FILED_UNDER_ISSUING_TILL,
        "text": (
            f"המסמך הונפק ב{_label(issuer)} לפני שהמכשיר שויך מחדש כ{_label(pusher)} — "
            "נקלט תחת הקופה שהנפיקה אותו (העסק, הסניף והמשמרת שלה)"
        ),
        "issuerMachineId": str(issuer.id),
        "pushedByMachineId": str(pusher.id),
    }


# ── The link, recorded when a device is re-paired as a new machine ───────────


def _serial(device_info: Any, machine: POSMachine) -> Optional[str]:
    from app.services.machine_health import serial_from_device_info

    serial = serial_from_device_info(device_info) if isinstance(device_info, dict) else None
    serial = (serial or getattr(machine, "serial_number", None) or "").strip()
    return serial or None


def find_predecessor(db: Session, machine: POSMachine, device_info: Any = None) -> Optional[POSMachine]:
    """The newest other fiscal machine paired before this one with the same device serial."""
    serial = _serial(device_info, machine)
    if not serial:
        return None
    since = _aware(getattr(machine, "created_at", None)) or datetime.now(timezone.utc)
    rows = (
        db.query(POSMachine)
        .filter(POSMachine.serial_number == serial, POSMachine.id != machine.id)
        .all()
    )
    rows = [
        m for m in rows
        if bool(getattr(m, "is_fiscal", True))
        and (_aware(m.created_at) is None or _aware(m.created_at) < since)
    ]
    rows.sort(key=lambda m: _aware(m.created_at) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return rows[0] if rows else None


def handover_of(db: Session, predecessor: POSMachine, *, now: datetime) -> Dict[str, Any]:
    """
    What the predecessor still owed when the device was re-paired — the clean-break
    conditions of `device_profile.check_clean_break`, read rather than enforced: a pairing
    is how an unpaired device delivers its outbox at all, so it is never refused over them.
    """
    from app.services.shifts import find_open_shift

    open_shift = find_open_shift(db, predecessor.id)
    awaiting = (
        db.query(Shift.id)
        .filter(Shift.machine_id == predecessor.id, Shift.status == ShiftStatus.CLOSED, Shift.z_report_id.is_(None))
        .count()
    )
    return {
        "at": now.isoformat(),
        "predecessorMachineId": str(predecessor.id),
        "predecessorName": predecessor.name,
        "predecessorPosNumber": predecessor.pos_number,
        "predecessorTenantId": str(predecessor.tenant_id) if predecessor.tenant_id else None,
        "predecessorShopId": str(predecessor.shop_id) if predecessor.shop_id else None,
        "openShiftId": str(open_shift.id) if open_shift is not None else None,
        # The till's claim only while it may still be open (not a shift the cloud holds closed).
        "reportedOpenShiftId": (
            str(predecessor.reported_open_shift_id)
            if getattr(predecessor, "reported_open_shift_id", None) and _claim_live(db, predecessor)
            else None
        ),
        "pendingDocuments": getattr(predecessor, "pending_documents", None),
        "pendingCount": getattr(predecessor, "pending_count", None),
        "pendingAt": _aware(getattr(predecessor, "pending_count_at", None)).isoformat()
        if getattr(predecessor, "pending_count_at", None) else None,
        "lastHeartbeatAt": _aware(predecessor.last_heartbeat_at).isoformat() if predecessor.last_heartbeat_at else None,
        "reportedCounters": getattr(predecessor, "reported_document_counters", None),
        "closedShiftsAwaitingZ": awaiting,
        "offlineZsPending": getattr(predecessor, "offline_till_z_pending", None),
        "clean": open_shift is None and not (getattr(predecessor, "pending_documents", None) or 0) and not awaiting,
    }


def record_repair_link(
    db: Session, machine: POSMachine, device_info: Any = None, *, now: Optional[datetime] = None,
) -> Optional[POSMachine]:
    """
    A device redeemed an ordinary pairing code as a new machine: if it was another machine
    before (the same serial), link the two and keep what the old one still owed. The caller
    commits. Never fails the pairing.
    """
    now = now or datetime.now(timezone.utc)
    try:
        previous = find_predecessor(db, machine, device_info)
        if previous is None:
            return None
        machine.predecessor_machine_id = previous.id
        machine.repair_handover = handover_of(db, previous, now=now)
        if not machine.repair_handover["clean"]:
            logger.warning(
                "machine %s is device of machine %s re-paired with work outstanding: %s",
                machine.id, previous.id, machine.repair_handover,
            )
        return previous
    except Exception:  # noqa: BLE001 - the pairing stands whatever happens here
        logger.exception("could not record the re-pair link of machine %s", machine.id)
        return None


# ── Same number, different id (§1.2d) ───────────────────────────────────────


def numbering_holder(
    db: Session, machine_id: Any, series: int, number: Optional[str], exclude_id: Any,
) -> Optional[Transaction]:
    """The document of this till and series that holds `number`, other than `exclude_id`."""
    if not number:
        return None
    holder = (
        db.query(Transaction)
        .filter(
            Transaction.machine_id == machine_id,
            Transaction.document_series == int(series),
            Transaction.transaction_number == number,
            Transaction.number_conflict_of.is_(None),
            Transaction.id != exclude_id,
        )
        .first()
    )
    return holder if isinstance(holder, Transaction) else None


def numbering_note(holder: Transaction, duplicate: bool) -> dict:
    return {
        "code": NUMBERING_CONFLICT,
        "text": (
            f"מספר המסמך {holder.transaction_number} כבר קיים בקופה זו במסמך אחר — שני המסמכים נשמרו. "
            + (
                "זהו עותק כפול של אותו מסמך (אותו מועד ואותו תוכן) — לא נספר בסכומים, נספר פעם אחת דרך המסמך המקורי"
                if duplicate
                else "תוכן המסמך שונה — זו מכירה נפרדת ונספרת; יש לבדוק את מונה המסמכים בקופה"
            )
        ),
        "holderId": str(holder.id),
        "duplicateCopy": bool(duplicate),
    }


# ── Re-filing documents already stored under the pushing machine ─────────────


def refile_document(
    db: Session, doc: Transaction, issuer: POSMachine, pusher: POSMachine, *, now: Optional[datetime] = None,
) -> Optional[Any]:
    """
    Move a stored document of `pusher` under `issuer` (its tenant, shop, register number) and
    into the issuer's shift (the one it names, else the covering one, else the waiting
    bucket). Its approver claim is linked again within the issuer's business, and its notes
    say where it was filed. Returns the shift it now lives in. The caller recomputes X/Z
    bookkeeping (`shifts.note_documents_after_close`) for that shift.
    """
    from app.services.approvals import resolve_document_approver_claim
    from app.services.document_prefix import document_series_of

    now = now or datetime.now(timezone.utc)
    target = None
    if doc.claimed_shift_id is not None:
        named = db.get(Shift, doc.claimed_shift_id)
        if named is not None and str(named.machine_id) == str(issuer.id):
            target = named
    if target is None:
        target = covering_shift(db, issuer.id, doc.created_at)
    if target is None:
        target = waiting_shift(
            db, issuer, business_date=doc.created_at.date() if doc.created_at else None,
            issued_at=doc.created_at, reason="no_covering_shift", now=now,
        )
    old_bucket = db.get(Shift, doc.shift_id) if doc.shift_id is not None else None
    claim = resolve_document_approver_claim(
        db, issuer,
        types.SimpleNamespace(
            approved_by_user_id=doc.claimed_approver_user_id, approved_by_pos_user_id=doc.claimed_approver_pos_user_id,
        ),
    )
    keep = [
        n for n in (doc.ingest_notes or [])
        if n.get("code") not in ("issued_before_pairing", "approver_not_known", "approver_both", WAITING_FOR_SHIFT)
    ]
    notes = keep + list(claim.notes) + [filed_under_note(issuer, pusher)]
    if is_waiting(target):
        notes.append({"code": WAITING_FOR_SHIFT, "text": WAIT_REASONS["no_covering_shift"]})
    holder = numbering_holder(
        db, issuer.id, document_series_of(doc.document_type, doc.refund_of_transaction_id),
        doc.transaction_number, doc.id,
    )
    doc.machine_id = issuer.id
    doc.tenant_id = issuer.tenant_id
    doc.shop_id = issuer.shop_id
    doc.pos_number = issuer.pos_number or issuer.machine_code
    doc.pushed_by_machine_id = pusher.id
    doc.shift_id = target.id
    doc.approved_by_user_id = claim.user_id
    doc.approved_by_pos_user_id = claim.pos_user_id
    if holder is not None:
        doc.number_conflict_of = holder.id
        notes.append(numbering_note(holder, False))
    doc.ingest_notes = notes or None
    # Vouchers it issued are the issuer's too.
    from app.models.issued_voucher import IssuedVoucher

    db.query(IssuedVoucher).filter(IssuedVoucher.transaction_id == doc.id).update(
        {IssuedVoucher.machine_id: issuer.id, IssuedVoucher.tenant_id: issuer.tenant_id, IssuedVoucher.shop_id: issuer.shop_id},
        synchronize_session=False,
    )
    db.flush()
    refresh_bucket(db, old_bucket)
    if is_waiting(target):
        refresh_bucket(db, target)
    return target.id


def _claim_live(db: Session, machine: POSMachine) -> bool:
    from app.services.z_runs import _reported_open_is_live

    return _reported_open_is_live(db, machine)
