"""
The till-facing half of a remote shift close: ack, handover, and completion.

One seam between the till endpoints (sync router, heartbeat) and whatever orchestrates
remote closes, so the till contract (docs/SHIFTS_API.md §1.4, §1.6, §1.7) does not move
when the orchestration does.
"""
from __future__ import annotations

import uuid
from typing import List, Optional, Set

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.services import close_day


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
    item = close_day.apply_close_day_ack(
        db,
        machine,
        request_id=request_id,
        phase=phase,
        shift_id=shift_id,
        error_code=error_code,
        error_message=error_message,
    )
    return item.status.value if hasattr(item.status, "value") else str(item.status)


def on_shift_close_accepted(db: Session, machine: POSMachine, shift: Shift) -> None:
    """The cloud now holds every document of `shift` and has closed it."""
    close_day.complete_close_request_for_shift(db, machine.id, shift)


def take_pending_close_shift(db: Session, machine: POSMachine) -> Optional[dict]:
    """The instruction to hand this till on its heartbeat, as `{requestId, shiftId}`."""
    item = close_day.take_pending_close_day_for_machine(db, machine)
    if item is None:
        return None
    return {
        "requestId": str(item.id),
        "shiftId": str(item.shift_id) if item.shift_id else None,
    }


def close_shift_pending_machine_ids(db: Session, machine_ids: List[uuid.UUID]) -> Set[uuid.UUID]:
    return close_day.get_pending_close_day_machine_ids(db, machine_ids)
