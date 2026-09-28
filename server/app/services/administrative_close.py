"""
Closing a shift whose till can no longer close it (dead-till recovery).

A shift is normally closed by its till: only the till knows what it rang up, and the
cloud accepts the close once it holds every document. A till that dies mid-shift leaves
a shift nobody can close, and the till is then stuck with it open forever — and a Z can
take none of its shifts, because a Z never contains a till's close that is still open.

This closes that shift from the documents the cloud already holds, and says so:

* `reconstructed = True` on the shift, so no reader mistakes its X for one the till
  produced and printed;
* `unattended = True` and `counted_cash` / `discrepancy` NULL — nobody counted a drawer,
  and every consumer that withholds a variance for an uncounted shift (the Z's cash
  summary among them) does so here without being taught a new rule;
* `reconstruction_basis` records what it was built from: how many documents, when the
  till was last heard from, and the backlog it last reported.

After that the shift is an ordinary candidate for the shop's next Z. This module files
no Z itself — before shifts it did, which is why it used to be the reconstructed *Z*.

What it cannot do is invent the documents that never arrived; "in practice the cloud has
everything" is not "always", which is exactly why the basis is recorded, not asserted.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.user import User
from app.services.machine_status import is_online
from app.services.shift_totals import compute_totals

#: How long a till must have been silent before its shift can be closed from the cloud.
#:
#: Guards against closing the shift of a till that is merely between heartbeats and still
#: serving customers — the cashier would be selling into a shift the cloud thinks has
#: ended. Two hours is far beyond any network blip and well inside a shift.
SILENT_BEFORE_CLOSE = timedelta(hours=2)


def check_can_close_administratively(
    machine: POSMachine, shift: Shift, *, force: bool, now: Optional[datetime] = None
) -> None:
    """Raise if this shift must not be closed from the cloud. Called before any write."""
    if shift.status != ShiftStatus.OPEN:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="shift_not_open")
    if is_online(machine.last_heartbeat_at, now=now) and not force:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "terminal_is_online — it can close its own shift. Use a Z run with the "
                "open shift included, or pass force if the terminal is known to be unusable."
            ),
        )
    reference = now or datetime.now(timezone.utc)
    last = machine.last_heartbeat_at
    if last is not None and not force:
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if reference - last < SILENT_BEFORE_CLOSE:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "terminal_recently_seen — wait for it to be silent for "
                    f"{int(SILENT_BEFORE_CLOSE.total_seconds() // 3600)}h, or pass force."
                ),
            )


def close_shift_administratively(
    db: Session,
    machine: POSMachine,
    shift: Shift,
    user: User,
    *,
    force: bool = False,
    note: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Tuple[Shift, bool]:
    """
    Close `shift` with an X built from the cloud's documents. Returns `(shift, created)`.

    Idempotent: a shift that is already closed is returned untouched with `created`
    False, so a double click cannot rewrite a close.
    """
    if shift.status == ShiftStatus.CLOSED:
        return shift, False

    check_can_close_administratively(machine, shift, force=force, now=now)

    reference = now or datetime.now(timezone.utc)
    totals = compute_totals(db, [shift.id])

    opening = shift.opening_cash or Decimal("0")
    expected = opening + totals.total_cash + totals.total_cash_tips

    who = user.username or user.email or str(user.id)
    basis = {
        "documentsOnCloud": totals.transactions_count,
        "lastHeartbeatAt": (
            machine.last_heartbeat_at.isoformat() if machine.last_heartbeat_at else None
        ),
        # What the till last said it still held — the honest measure of how much this
        # reconstruction might be missing. Null means it never reported.
        # Same reading as the status light: undelivered sales, else the whole outbox
        # for a till predating that split.
        "lastReportedPendingDocuments": (
            machine.pending_documents
            if machine.pending_documents is not None
            else machine.pending_count
        ),
        "lastReportedPendingAt": (
            machine.pending_count_at.isoformat() if machine.pending_count_at else None
        ),
        "forced": bool(force),
        "note": note,
        "reconstructedAt": reference.isoformat(),
        "reconstructedBy": who,
    }

    for column, value in totals.as_x().items():
        setattr(shift, column, value)
    shift.status = ShiftStatus.CLOSED
    shift.closed_at = reference
    shift.close_accepted_at = reference
    shift.closed_by = who
    shift.expected_cash = expected
    # Nobody opened a drawer. Unknown, not `expected` — that would assert a variance of
    # zero that no one verified.
    shift.counted_cash = None
    shift.discrepancy = None
    shift.unattended = True
    shift.reconstructed = True
    shift.reconstructed_by = who
    shift.reconstruction_basis = basis
    if getattr(machine, "reported_open_shift_id", None) == shift.id:
        # The heartbeat claim is stale from this moment, exactly as on a till's close.
        machine.reported_open_shift_id = None
        machine.reported_open_shift_opened_at = None
    db.flush()
    # A Z run or close request waiting for this shift must not wait for a till that is dead.
    from app.services.remote_close import on_shift_close_accepted

    on_shift_close_accepted(db, machine, shift)
    return shift, True
