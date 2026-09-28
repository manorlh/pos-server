"""
Shifts (משמרות): how a till's shifts reach the cloud and how one is closed.

The till opens and closes shifts on its own, offline too, and its outbox delivers them
strictly in order: open(N) → documents(N) → close(N) → open(N+1) → documents(N+1). The
cloud's job is to record that faithfully and to refuse anything that would put a
document in the wrong shift:

* **Identity is the shift's own id.** A document names its shift; the server never
  "adopts" whatever shift happens to be open. The adopt fallback is exactly what would
  put shift N+1's sales into shift N when N's close was still queued behind them. An
  unknown shift id while another shift of the till is open is a retryable conflict.
* **A shift is closed only with every document present.** The close lists the shift's
  documents; any not on the cloud yet (or held under another shift) sends the till
  back to push them, the same loop the till Z used.
* **The X is recomputed here** from those documents. The till's own figures are kept
  for audit and compared, never trusted — a Z is built from what the cloud holds.
* **A shift is one till's.** A shift id the cloud holds for another till (a till
  re-paired as a new machine while its shift was open) is never used for this one: its
  documents are stored as orphans, its open and close are 403
  `shift_belongs_to_another_machine`, its heartbeat claim is dropped, and an X or Z
  counts only the documents of the shift's own till.
* **Closing a shift creates no Z.** See `app.services.z_runs`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.schemas.shift import (
    LastClosedShift,
    ShiftCloseIn,
    ShiftOpenIn,
    ShiftOut,
    ShiftTotalsOut,
)
from app.services.shift_totals import compute_totals, till_totals_mismatch

logger = logging.getLogger(__name__)


class ShiftConflict(Exception):
    """
    Documents name a shift the cloud cannot accept yet.

    Raised when a document's shift is unknown while another shift of the till is open —
    the previous shift's close has not arrived. Nothing of the batch is written; the till
    retries once the close (and the new shift's open) have been delivered.
    """

    def __init__(self, open_shift_id: Optional[uuid.UUID], unknown_shift_ids: Sequence[uuid.UUID]):
        super().__init__("another_shift_open")
        self.open_shift_id = open_shift_id
        self.unknown_shift_ids = list(unknown_shift_ids)

    def body(self) -> dict:
        return {
            "detail": "another_shift_open",
            "openShiftId": str(self.open_shift_id) if self.open_shift_id else None,
            "unknownShiftIds": [str(i) for i in self.unknown_shift_ids],
        }


class ShiftUnknown(Exception):
    """A close for a shift the cloud has never seen, carrying nothing to create it from."""


#: The 403 detail for an open or close naming another till's shift. The till relies on
#: exactly this string (a till re-paired as a new machine while its shift was open).
SHIFT_BELONGS_TO_ANOTHER_MACHINE = "shift_belongs_to_another_machine"


# ── Lookups ───────────────────────────────────────────────────────────────────


def find_open_shift(db: Session, machine_id: uuid.UUID) -> Optional[Shift]:
    """The till's open shift, if the cloud knows of one."""
    return (
        db.query(Shift)
        .filter(Shift.machine_id == machine_id, Shift.status == ShiftStatus.OPEN)
        .order_by(Shift.opened_at.desc())
        .first()
    )


def is_foreign_shift(db: Session, machine: POSMachine, shift_id: Optional[uuid.UUID]) -> bool:
    """
    `shift_id` is a shift the cloud holds for a *different* till.

    A shift id is the till's own and unique, so this only happens when a physical till is
    re-paired as a new machine while a shift was open: in the cloud that shift stays the
    old machine's. It is never this machine's shift — not for its documents, its close,
    its open or its heartbeat.
    """
    if shift_id is None:
        return False
    row = db.query(Shift.machine_id).filter(Shift.id == shift_id).first()
    return row is not None and str(row[0]) != str(machine.id)


def refuse_foreign_shift(db: Session, machine: POSMachine, shift_id: Optional[uuid.UUID]) -> None:
    """403 `shift_belongs_to_another_machine` for another till's shift; else nothing."""
    if is_foreign_shift(db, machine, shift_id):
        logger.warning(
            "machine %s named shift %s, which belongs to another machine", machine.id, shift_id
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=SHIFT_BELONGS_TO_ANOTHER_MACHINE
        )


def lock_shift(db: Session, shift_id: uuid.UUID) -> Optional[Shift]:
    """The shift, re-read under a row lock (the Z builder takes the same lock)."""
    return (
        db.query(Shift)
        .filter(Shift.id == shift_id)
        .with_for_update()
        .populate_existing()
        .first()
    )


def shift_exists(db: Session, shift_id: Optional[uuid.UUID]) -> bool:
    if shift_id is None:
        return False
    return db.query(Shift.id).filter(Shift.id == shift_id).first() is not None


def link_claimed_shift(db: Session, shift: Shift) -> None:
    """
    A shift a remote close only knew as the till's claim has reached the cloud.

    A Z run item or a close request may have been created for a shift the cloud had
    not seen (the till reports its open shift on the heartbeat before the open event
    is delivered). The claim is kept in `claimed_shift_id`, a column without a foreign
    key; now that the shift exists, the keyed column is filled in too.
    """
    from app.models.shift_close_request import ShiftCloseRequest
    from app.models.z_run import ZRunItem

    db.query(ZRunItem).filter(
        ZRunItem.claimed_shift_id == shift.id,
        ZRunItem.machine_id == shift.machine_id,
        ZRunItem.close_shift_id.is_(None),
    ).update({ZRunItem.close_shift_id: shift.id}, synchronize_session="fetch")
    db.query(ShiftCloseRequest).filter(
        ShiftCloseRequest.claimed_shift_id == shift.id,
        ShiftCloseRequest.machine_id == shift.machine_id,
        ShiftCloseRequest.shift_id.is_(None),
    ).update({ShiftCloseRequest.shift_id: shift.id}, synchronize_session="fetch")


def open_shifts_for_machines(db: Session, machine_ids: List[uuid.UUID]) -> dict:
    if not machine_ids:
        return {}
    out: dict = {}
    for shift in (
        db.query(Shift)
        .filter(Shift.machine_id.in_(machine_ids), Shift.status == ShiftStatus.OPEN)
        .all()
    ):
        existing = out.get(shift.machine_id)
        if existing is None or shift.opened_at > existing.opened_at:
            out[shift.machine_id] = shift
    return out


def z_reported_through_sequence(db: Session, machine_id: uuid.UUID) -> Optional[int]:
    """
    The highest shift sequence of this till that is in a Z, or None.

    Drives the till's purge. Safe as a watermark because a Z takes a till's shifts
    oldest first with no gaps: every closed shift at or below it is in a Z too.
    """
    value = (
        db.query(func.max(Shift.sequence_number))
        .filter(Shift.machine_id == machine_id, Shift.z_report_id.isnot(None))
        .scalar()
    )
    return int(value) if value is not None else None


def last_closed_shift(db: Session, machine_id: uuid.UUID) -> LastClosedShift:
    shift = (
        db.query(Shift)
        .filter(Shift.machine_id == machine_id, Shift.status == ShiftStatus.CLOSED)
        .order_by(Shift.closed_at.desc().nullslast(), Shift.opened_at.desc())
        .first()
    )
    if shift is None:
        return LastClosedShift()
    return LastClosedShift(
        shift_id=shift.id,
        sequence_number=shift.sequence_number,
        business_date=shift.business_date,
        closed_at=shift.closed_at,
        counted_cash=shift.counted_cash,
        expected_cash=shift.expected_cash,
        reconstructed=bool(shift.reconstructed),
    )


# ── Documents → shift ─────────────────────────────────────────────────────────


def _new_shift(
    machine: POSMachine,
    *,
    shift_id: Optional[uuid.UUID],
    business_date: Optional[date],
    opened_at: Optional[datetime],
    status_: ShiftStatus = ShiftStatus.OPEN,
    **extra,
) -> Shift:
    return Shift(
        id=shift_id or uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        business_date=business_date or datetime.now(timezone.utc).date(),
        opened_at=opened_at or datetime.now(timezone.utc),
        status=status_,
        **extra,
    )


def precheck_document_shifts(db: Session, machine: POSMachine, shift_ids: Iterable[Optional[uuid.UUID]]) -> None:
    """
    Refuse a batch up front if it names a shift the cloud cannot accept yet.

    Checked before anything is written so a refused batch leaves no trace. Several
    unknown shifts in one batch are refused too: only one of them could be opened, and
    which is not something to guess.
    """
    wanted = {sid for sid in shift_ids if sid is not None}
    if not wanted:
        return
    # Known to the cloud, whichever till's: another till's shift is not a conflict — the
    # document is taken as an orphan (see `resolve_shift_for_document`).
    known = {
        row[0]
        for row in db.query(Shift.id).filter(Shift.id.in_(list(wanted))).all()
    }
    unknown = sorted(wanted - known, key=str)
    if not unknown:
        return
    open_shift = find_open_shift(db, machine.id)
    if open_shift is not None or len(unknown) > 1:
        raise ShiftConflict(open_shift.id if open_shift else None, unknown)


def resolve_shift_for_document(
    db: Session,
    machine: POSMachine,
    *,
    shift_id: Optional[uuid.UUID],
    business_date: Optional[date],
    opened_at: Optional[datetime] = None,
) -> Optional[Shift]:
    """
    The shift a document belongs to — **by its id only**.

    * known id of this till → that shift, whatever its status;
    * known id of **another** till → **None**, an orphan, exactly as if no id were sent.
      That happens when a till is re-paired as a new machine while its shift was open:
      in the cloud the shift stays the old machine's, and taking the document into it
      would put this till's sale into another till's X and Z. Accepted rather than
      refused, so the till's outbox is not jammed; logged, and counted as an orphan.
    * unknown id, nothing open → that shift, created open (the sale beat the open event);
    * unknown id while another shift is open → `ShiftConflict`, never adoption;
    * no id → **None**: the document is stored with no shift (an orphan). Never a
      guessed shift: joining the open one is adoption again, and creating one made a
      phantom with a random id that blocked the till's next real open (one open shift
      per till) and every Z of the till (no sequence, so it sorts first).
    """
    if shift_id is None:
        return None
    shift = db.query(Shift).filter(Shift.id == shift_id).first()
    if shift is not None:
        if str(shift.machine_id) != str(machine.id):
            logger.warning(
                "machine %s pushed a document naming shift %s of machine %s; stored with no shift",
                machine.id, shift_id, shift.machine_id,
            )
            return None
        return shift
    open_shift = find_open_shift(db, machine.id)
    if open_shift is not None:
        raise ShiftConflict(open_shift.id, [shift_id])

    shift = _new_shift(
        machine, shift_id=shift_id, business_date=business_date, opened_at=opened_at
    )
    db.add(shift)
    try:
        db.flush()
    except IntegrityError:
        # Lost a race with a concurrent open: the one-open index is the arbiter. The
        # caller's savepoint is rolled back and the batch refused as a conflict — the
        # till retries and then finds the shift by id.
        raise ShiftConflict(None, [shift_id])
    link_claimed_shift(db, shift)
    return shift


def orphan_documents_by_machine(db: Session, machine_ids: List[uuid.UUID]) -> dict:
    """
    Per till: documents in no shift of their own till. Visible, never guessed.

    Stored with no shift (they named none, or another till's), and also any held under
    another till's shift — before that was refused a document could land there, and it
    is in no X or Z of either till (`compute_totals` counts a shift's own till only).
    """
    if not machine_ids:
        return {}
    rows = (
        db.query(Transaction.machine_id, func.count(Transaction.id))
        .outerjoin(Shift, Shift.id == Transaction.shift_id)
        .filter(
            Transaction.machine_id.in_(list(machine_ids)),
            or_(Transaction.shift_id.is_(None), Shift.machine_id != Transaction.machine_id),
        )
        .group_by(Transaction.machine_id)
        .all()
    )
    return {r[0]: int(r[1]) for r in rows}


def note_documents_after_close(
    db: Session,
    touched: dict,
    *,
    machine_id: Optional[uuid.UUID] = None,
    now: Optional[datetime] = None,
) -> None:
    """
    Documents were written into (or out of) shifts that are already closed.

    `touched` maps shift id → how many of the written documents were *new* to the cloud.
    For each closed shift:

    * not in a Z yet — its X is recomputed from the documents (and compared with the
      till's again), and new ones are counted in `late_documents`. The next Z takes them.
    * already in a Z — the documents are stored all the same (a fiscal document is never
      dropped) but the Z's figures are frozen, so the shift and the Z are both flagged
      with the count: the dashboard shows "document arrived after Z".

    Open shifts are skipped: that is the ordinary case, and the close computes their X.
    So is any shift of a till other than `machine_id` (the pushing till): its X counts
    only its own till's documents, so nothing this push did can change it.

    Each shift is read under `FOR UPDATE`, fresh (`populate_existing`): a Z being built
    over it holds that lock, so this waits for the Z and then sees that the shift is in
    it — rather than recomputing the X of a shift a Z has just frozen, from a copy of
    the row this session read before the Z committed.
    """
    for shift_id, new_count in touched.items():
        if shift_id is None:
            continue
        shift = lock_shift(db, shift_id)
        if shift is None or shift.status != ShiftStatus.CLOSED:
            continue
        if machine_id is not None and str(shift.machine_id) != str(machine_id):
            continue
        if new_count:
            shift.late_documents = int(shift.late_documents or 0) + new_count
        if shift.z_report_id is None:
            totals = compute_totals(db, [shift.id])
            for column, value in totals.as_x().items():
                setattr(shift, column, value)
            shift.totals_mismatch = till_totals_mismatch(shift.till_totals, totals)
        elif new_count:
            z = db.query(ZReport).filter(ZReport.id == shift.z_report_id).first()
            if z is not None:
                z.late_documents = int(z.late_documents or 0) + new_count
            logger.warning(
                "%s document(s) arrived for shift %s after Z %s was built",
                new_count, shift.id, shift.z_report_id,
            )
    db.flush()


def recent_shift_zs(
    db: Session, machine_id: uuid.UUID, *, now: Optional[datetime] = None, days: int = 30, limit: int = 50
) -> List[dict]:
    """
    This till's shifts taken by a Z in the last `days`, newest Z first, as the till needs
    them to print a Z number on a reprint: `[{shiftId, zReportId, zNumber}]`.
    """
    now = now or datetime.now(timezone.utc)
    rows = (
        db.query(Shift.id, ZReport.id, ZReport.shop_sequence_number)
        .join(ZReport, ZReport.id == Shift.z_report_id)
        .filter(Shift.machine_id == machine_id, ZReport.closed_at >= now - timedelta(days=days))
        .order_by(ZReport.closed_at.desc(), Shift.sequence_number.desc())
        .limit(limit)
        .all()
    )
    return [
        {"shiftId": str(sid), "zReportId": str(zid), "zNumber": number}
        for sid, zid, number in rows
    ]


# ── Open ──────────────────────────────────────────────────────────────────────


def report_shift_open(db: Session, machine: POSMachine, data: ShiftOpenIn) -> Shift:
    """
    Record a shift the till has opened. Idempotent by id.

    Known and open: the till's own account corrects what a sale may have inferred.
    Known and closed: untouched — a late open event must not resurrect a closed shift.
    Another shift open: 409 with its id.
    """
    refuse_foreign_shift(db, machine, data.id)
    existing = db.query(Shift).filter(Shift.id == data.id).first()
    if existing is not None:
        if existing.status == ShiftStatus.OPEN:
            existing.opened_at = data.opened_at
            if data.opening_cash is not None:
                existing.opening_cash = data.opening_cash
            if data.opened_by_name:
                existing.opened_by = data.opened_by_name
            if data.opened_by_user_id:
                existing.opened_by_pos_user_id = data.opened_by_user_id
            if data.sequence_number is not None:
                existing.sequence_number = data.sequence_number
            db.add(existing)
            db.flush()
        return existing

    clash = find_open_shift(db, machine.id)
    if clash is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"another_shift_open:{clash.id}",
        )

    shift = _new_shift(
        machine,
        shift_id=data.id,
        business_date=data.business_date,
        opened_at=data.opened_at,
        sequence_number=data.sequence_number,
        opening_cash=data.opening_cash,
        opened_by=data.opened_by_name,
        opened_by_pos_user_id=data.opened_by_user_id,
    )
    db.add(shift)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        clash = find_open_shift(db, machine.id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"another_shift_open:{clash.id}" if clash else "another_shift_open",
        )
    link_claimed_shift(db, shift)
    return shift


# ── Close ─────────────────────────────────────────────────────────────────────


def check_close_preconditions(
    db: Session, machine: POSMachine, shift_id: uuid.UUID, transaction_ids: Sequence[uuid.UUID]
) -> Tuple[List[uuid.UUID], List[uuid.UUID]]:
    """
    (missing, stale) among the documents the till says make up this shift.

    *missing*: not on the cloud for this till. *stale*: on the cloud but held under a
    different shift (or none) that is not already in a Z — re-pushing the document,
    which carries this shift's id, moves it. A document already inside another Z stays
    where it is and is not reported: moving it would change a filed Z.
    """
    if not transaction_ids:
        return [], []
    rows = (
        db.query(Transaction.id, Transaction.shift_id, Shift.z_report_id)
        .outerjoin(Shift, Shift.id == Transaction.shift_id)
        .filter(
            Transaction.machine_id == machine.id,
            Transaction.id.in_(list(transaction_ids)),
        )
        .all()
    )
    present = {r[0]: (r[1], r[2]) for r in rows}
    missing = [tx_id for tx_id in transaction_ids if tx_id not in present]
    stale = [
        tx_id
        for tx_id in transaction_ids
        if tx_id in present
        and present[tx_id][0] != shift_id
        and present[tx_id][1] is None
    ]
    return missing, stale


def _money(value) -> Optional[Decimal]:
    return None if value is None else Decimal(str(value))


def _record_close_request(
    db: Session, machine: POSMachine, shift: Shift, request_id: Optional[uuid.UUID]
) -> None:
    """
    Keep the remote instruction a close answered, in the column for its kind.

    The till sends one `closeRequestId` whichever kind it was — a Z run item or a
    standalone close request — so it is looked up rather than trusted into a foreign
    key: an id that is neither (or another till's) is dropped, not a 500.
    """
    if request_id is None:
        return
    from app.models.shift_close_request import ShiftCloseRequest
    from app.models.z_run import ZRunItem

    if (
        db.query(ShiftCloseRequest.id)
        .filter(ShiftCloseRequest.id == request_id, ShiftCloseRequest.machine_id == machine.id)
        .first()
        is not None
    ):
        shift.close_request_id = request_id
    elif (
        db.query(ZRunItem.id)
        .filter(ZRunItem.id == request_id, ZRunItem.machine_id == machine.id)
        .first()
        is not None
    ):
        shift.close_request_item_id = request_id
    else:
        logger.warning("shift %s closed with an unknown closeRequestId %s", shift.id, request_id)


def apply_shift_close(
    db: Session,
    machine: POSMachine,
    shift_id: uuid.UUID,
    body: ShiftCloseIn,
    *,
    approved_by_user_id: Optional[uuid.UUID] = None,
    approved_by_pos_user_id: Optional[uuid.UUID] = None,
    now: Optional[datetime] = None,
) -> Tuple[Shift, str]:
    """
    Close `shift_id` with the server's X. Returns (shift, "accepted" | "duplicate").

    The caller has already checked the preconditions (every listed document present).
    A shift that is already closed is returned untouched as a duplicate, so a retried
    close cannot rewrite the figures, the count or the approver of the first.
    """
    now = now or datetime.now(timezone.utc)
    refuse_foreign_shift(db, machine, shift_id)
    # Locked, like a late document's note and the Z builder: a close racing a document
    # push must not compute its X from a copy of the row that is already stale.
    shift = lock_shift(db, shift_id)
    if shift is None:
        if body.business_date is None or body.opened_at is None:
            raise ShiftUnknown()
        # Created closed: its open event never arrived, and inserting it open would
        # trip the one-open rule on a till that has already opened its next shift.
        shift = _new_shift(
            machine,
            shift_id=shift_id,
            business_date=body.business_date,
            opened_at=body.opened_at,
            status_=ShiftStatus.CLOSED,
            sequence_number=body.sequence_number,
            opening_cash=body.opening_cash,
            opened_by=body.opened_by_name,
            opened_by_pos_user_id=body.opened_by_user_id,
        )
        db.add(shift)
        db.flush()
        link_claimed_shift(db, shift)
    elif shift.status == ShiftStatus.CLOSED:
        return shift, "duplicate"

    totals = compute_totals(db, [shift.id])
    for column, value in totals.as_x().items():
        setattr(shift, column, value)

    counted = None if body.unattended else _money(body.counted_cash)
    expected = _money(body.expected_cash)
    shift.status = ShiftStatus.CLOSED
    shift.closed_at = body.closed_at
    shift.close_accepted_at = now
    shift.closed_by = body.closed_by_name
    shift.closed_by_pos_user_id = body.closed_by_user_id
    shift.unattended = bool(body.unattended)
    shift.expected_cash = expected
    # Nobody counted on an unattended close: the count and the variance stay unknown,
    # enforced here so a till cannot file "counted = expected, variance 0".
    shift.counted_cash = counted
    shift.discrepancy = (counted - expected) if counted is not None and expected is not None else None
    shift.till_totals = body.till
    shift.totals_mismatch = till_totals_mismatch(body.till, totals)
    _record_close_request(db, machine, shift, body.close_request_id)
    shift.approved_by_user_id = approved_by_user_id
    shift.approved_by_pos_user_id = approved_by_pos_user_id
    if getattr(machine, "reported_open_shift_id", None) == shift.id:
        # Its heartbeat claim is stale from this moment; do not wait a beat to drop it.
        machine.reported_open_shift_id = None
        machine.reported_open_shift_opened_at = None
    if shift.totals_mismatch:
        logger.warning(
            "shift %s closed with a till X that disagrees with the documents till=%s",
            shift.id,
            body.till,
        )
    db.flush()
    return shift, "accepted"


# ── Out ───────────────────────────────────────────────────────────────────────


def shift_totals_out(shift: Shift) -> Optional[ShiftTotalsOut]:
    if shift.status != ShiftStatus.CLOSED and shift.total_sales is None:
        return None
    return ShiftTotalsOut(
        total_sales=shift.total_sales,
        gross_sales=shift.gross_sales,
        discounts_total=shift.discounts_total,
        total_refunds=shift.total_refunds,
        total_cash=shift.total_cash,
        total_card=shift.total_card,
        total_tips=shift.total_tips,
        total_cash_tips=shift.total_cash_tips,
        total_card_tips=shift.total_card_tips,
        vat_total=shift.vat_total,
        transactions_count=shift.transactions_count,
        first_transaction_number=shift.first_transaction_number,
        last_transaction_number=shift.last_transaction_number,
    )


def z_number_of(db: Session, shift: Shift) -> Optional[int]:
    if shift.z_report_id is None:
        return None
    z = getattr(shift, "z_report", None)
    if z is None:
        z = db.query(ZReport).filter(ZReport.id == shift.z_report_id).first()
    return z.shop_sequence_number if z is not None else None


def shift_to_out(
    shift: Shift,
    *,
    z_number: Optional[int] = None,
    machine_name: Optional[str] = None,
    shop_name: Optional[str] = None,
    payment_breakdown: Optional[dict] = None,
) -> ShiftOut:
    status_val = shift.status.value if hasattr(shift.status, "value") else shift.status
    return ShiftOut(
        id=shift.id,
        tenant_id=shift.tenant_id,
        machine_id=shift.machine_id,
        shop_id=shift.shop_id,
        business_date=shift.business_date,
        sequence_number=shift.sequence_number,
        status=status_val,
        opened_at=shift.opened_at,
        opening_cash=shift.opening_cash,
        opened_by_user_id=shift.opened_by_pos_user_id,
        opened_by_name=shift.opened_by,
        closed_at=shift.closed_at,
        close_accepted_at=shift.close_accepted_at,
        closed_by_user_id=shift.closed_by_pos_user_id,
        closed_by_name=shift.closed_by,
        unattended=bool(shift.unattended),
        counted_cash=shift.counted_cash,
        expected_cash=shift.expected_cash,
        discrepancy=shift.discrepancy,
        server_totals=shift_totals_out(shift),
        till_totals=shift.till_totals,
        totals_mismatch=bool(shift.totals_mismatch),
        late_documents=int(shift.late_documents or 0),
        reconstructed=bool(shift.reconstructed),
        reconstruction_basis=shift.reconstruction_basis,
        z_report_id=shift.z_report_id,
        z_number=z_number,
        machine_name=machine_name,
        shop_name=shop_name,
        payment_breakdown=payment_breakdown,
    )
