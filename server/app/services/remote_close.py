"""
The till-facing half of a remote shift close: ack, handover, and completion.

One seam between the till endpoints (sync router, heartbeat) and the two things that
ask a till to close its shift — a Z run's item, and a standalone close request from the
machines page (`app.services.shift_close_requests`). The till contract
(docs/SHIFTS_API.md §1.4, §1.6, §1.7) is the same for both and does not depend on how
either is stored: a `requestId` is resolved against the standalone requests first, then
the Z runs.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Optional, Set

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.services import shift_close_requests as close_requests
from app.services import z_runs


def apply_close_shift_ack(
    db: Session,
    machine: POSMachine,
    *,
    request_id: uuid.UUID,
    phase: str,
    shift_id: Optional[uuid.UUID] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> str:
    req = close_requests.apply_ack(
        db,
        machine,
        request_id=request_id,
        phase=phase,
        shift_id=shift_id,
        error_code=error_code,
        error_message=error_message,
    )
    if req is not None:
        db.commit()
        return req.status
    item = z_runs.apply_close_shift_ack(
        db,
        machine,
        request_id=request_id,
        phase=phase,
        shift_id=shift_id,
        error_code=error_code,
        error_message=error_message,
    )
    db.commit()
    return item.status


def on_shift_close_accepted(db: Session, machine: POSMachine, shift: Shift) -> None:
    """The cloud now holds every document of `shift` and has closed it."""
    close_requests.on_shift_close_accepted(db, machine, shift)
    z_runs.on_shift_close_accepted(db, machine, shift)


def take_pending_close_shift(
    db: Session, machine: POSMachine, *, now: Optional[datetime] = None
) -> Optional[dict]:
    """
    The one instruction to hand this till on its heartbeat, as `{requestId, shiftId}`.

    A Z run's comes first: it has a Z waiting on it. When both are pending they name the
    same open shift (a request is refused while a Z run is closing the till), so the
    till closes it once and the accepted close resolves both.
    """
    now = now or datetime.now(timezone.utc)
    handed = z_runs.take_pending_close_shift(db, machine, now=now)
    if handed is not None:
        return handed
    close_requests.expire_overdue(db, now=now)
    req = close_requests.oldest_pending(db, machine)
    if req is None:
        return None
    if req.sent_at is None:
        req.sent_at = now
    named = close_requests.named_shift_id(req)
    return {"requestId": str(req.id), "shiftId": str(named) if named else None}


def close_shift_pending_machine_ids(db: Session, machine_ids: List[uuid.UUID]) -> Set[uuid.UUID]:
    return z_runs.close_shift_pending_machine_ids(
        db, machine_ids
    ) | close_requests.pending_machine_ids(db, machine_ids)
