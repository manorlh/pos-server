"""
The till-facing half of a remote shift close: ack, handover, and completion.

One seam between the till endpoints (sync router, heartbeat) and the Z runs that
orchestrate remote closes, so the till contract (docs/SHIFTS_API.md §1.4, §1.6, §1.7)
does not depend on how the orchestration is stored.
"""
from __future__ import annotations

import uuid
from typing import List, Optional, Set

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift
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
    z_runs.on_shift_close_accepted(db, machine, shift)


def take_pending_close_shift(db: Session, machine: POSMachine) -> Optional[dict]:
    return z_runs.take_pending_close_shift(db, machine)


def close_shift_pending_machine_ids(db: Session, machine_ids: List[uuid.UUID]) -> Set[uuid.UUID]:
    return z_runs.close_shift_pending_machine_ids(db, machine_ids)
