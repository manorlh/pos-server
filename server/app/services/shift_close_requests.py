"""
Closing a till's shift remotely without producing a Z (docs/SHIFTS_API.md §2.14).

An operator on the machines page asks a till to close its open shift. The instruction
travels exactly as a Z run's does — the `close-shift` Ably event now, `pendingCloseShift`
on the heartbeat until the till takes it — with this request's id as the `requestId`.
The till cannot tell the two apart and needs no change: its `shift-close/ack` and the
`closeRequestId` of its close are resolved here first, then against the Z runs
(`app.services.remote_close`).

The request completes when the close is **accepted** — every document of the shift on
the cloud — never on an ack. The shift is then an ordinary candidate for the shop's
next Z. A request nobody answers expires after the Z run TTL (36 h).

Interplay with Z runs, both directions safe for the till:

* a Z run already closing this till's shift → the request is refused
  (`z_run_in_progress:<runId>`): the shift is being closed already;
* a request pending when a Z run includes the open shift → allowed. Both name the same
  shift, the till closes it once, and the accepted close resolves both.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shift_close_request import (
    PENDING_CLOSE_REQUEST_STATUSES,
    ShiftCloseRequest,
    ShiftCloseRequestStatus as S,
)
from app.models.user import User
from app.models.z_run import PENDING_ITEM_STATUSES, ZRun, ZRunItem, ZRunStatus
from app.services.close_progress import documents_on_cloud, till_backlog
from app.services.machine_status import is_online
from app.services.shifts import find_open_shift, is_foreign_shift, shift_exists, shift_to_out
from app.services import z_runs

logger = logging.getLogger(__name__)

#: Same lifetime as a Z run's items: a till off overnight still gets it, and a till that
#: comes back days later does not close a shift nobody is waiting on any more.
CLOSE_REQUEST_TTL_HOURS = z_runs.Z_RUN_TTL_HOURS


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def named_shift_id(req: ShiftCloseRequest) -> Optional[uuid.UUID]:
    """The shift asked to close: the cloud's row once it has it, else the till's claim."""
    return req.shift_id or req.claimed_shift_id


def _name_shift(db: Session, req: ShiftCloseRequest, shift_id: Optional[uuid.UUID]) -> None:
    if shift_id is None:
        return
    if shift_exists(db, shift_id):
        req.shift_id = shift_id
    else:
        req.claimed_shift_id = shift_id


def _pending_query(db: Session, machine_id: uuid.UUID):
    return db.query(ShiftCloseRequest).filter(
        ShiftCloseRequest.machine_id == machine_id,
        ShiftCloseRequest.status.in_(PENDING_CLOSE_REQUEST_STATUSES),
    )


# ── Expiry and reconciliation ─────────────────────────────────────────────────


def expire_overdue(db: Session, *, now: Optional[datetime] = None) -> int:
    """Lazy, like the Z runs: called from every read and write path."""
    now = _now(now)
    rows = (
        db.query(ShiftCloseRequest)
        .filter(
            ShiftCloseRequest.status.in_(PENDING_CLOSE_REQUEST_STATUSES),
            ShiftCloseRequest.expires_at < now,
        )
        .all()
    )
    for req in rows:
        req.status = S.EXPIRED
        req.error_code = "expired"
        req.error_message = "The till did not close its shift in time"
        req.failed_at = now
    return len(rows)


def reconcile(db: Session, req: ShiftCloseRequest, *, now: Optional[datetime] = None) -> bool:
    """
    Complete a pending request whose shift the cloud already holds closed.

    The accepted close normally does this itself; this catches a close that reached the
    cloud by another road (an administrative close of a dead till, say). True if changed.
    """
    if req.status not in PENDING_CLOSE_REQUEST_STATUSES or named_shift_id(req) is None:
        return False
    shift = (
        db.query(Shift)
        .filter(Shift.id == named_shift_id(req), Shift.machine_id == req.machine_id)
        .first()
    )
    if shift is None or shift.status != ShiftStatus.CLOSED:
        return False
    req.shift_id = shift.id
    _complete(req, _now(now))
    return True


def _complete(req: ShiftCloseRequest, now: datetime) -> None:
    req.status = S.COMPLETED
    req.completed_at = now
    req.error_code = None
    req.error_message = None


# ── Create / cancel ───────────────────────────────────────────────────────────


def _live_z_item(db: Session, machine_id: uuid.UUID) -> Optional[ZRunItem]:
    return (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id == machine_id,
            ZRunItem.status.in_(PENDING_ITEM_STATUSES),
            ZRun.status == ZRunStatus.WAITING,
        )
        .first()
    )


def request_close(
    db: Session, user: User, machine: POSMachine, *, now: Optional[datetime] = None
) -> Tuple[ShiftCloseRequest, bool]:
    """
    Ask `machine` to close its open shift. Returns `(request, created)`.

    Idempotent while one is pending: a second click returns the first request rather
    than sending the till a second instruction.
    """
    now = _now(now)
    z_runs.expire_overdue_runs(db, now=now)
    expire_overdue(db, now=now)

    if machine.pairing_status != PairingStatus.ASSIGNED or machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")

    item = _live_z_item(db, machine.id)
    if item is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=f"z_run_in_progress:{item.run_id}"
        )

    for existing in _pending_query(db, machine.id).order_by(ShiftCloseRequest.created_at.asc()).all():
        if not reconcile(db, existing, now=now):
            return existing, False

    open_shift = find_open_shift(db, machine.id)
    if open_shift is not None:
        shift_id = open_shift.id
    elif z_runs._reported_open_is_live(db, machine):
        # The till says it has one open that the cloud has not heard of yet.
        shift_id = machine.reported_open_shift_id
    else:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="no_open_shift")

    req = ShiftCloseRequest(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        created_by_user_id=user.id,
        status=S.WAITING_CLOSE,
        expires_at=now + timedelta(hours=CLOSE_REQUEST_TTL_HOURS),
    )
    _name_shift(db, req, shift_id)
    db.add(req)
    db.flush()
    _send(machine, req, user, now)
    return req, True


def _send(machine: POSMachine, req: ShiftCloseRequest, user: User, now: datetime) -> None:
    from app.services.ably_notify import publish_close_shift_notify

    if not machine.tenant_id or not is_online(machine.last_heartbeat_at, now=now):
        # Offline is a delay, not a failure: the heartbeat hands it over on the next beat.
        return
    publish_close_shift_notify(
        str(machine.tenant_id),
        str(machine.id),
        str(req.id),
        str(named_shift_id(req)) if named_shift_id(req) else None,
        z_runs._initiator(user),
    )
    req.sent_at = now


def cancel(db: Session, req: ShiftCloseRequest) -> ShiftCloseRequest:
    """
    Stop offering the instruction. A till that already received it still closes its
    shift — that shift then simply waits for the next Z, as any closed shift does.
    """
    if req.status not in PENDING_CLOSE_REQUEST_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="request_not_pending")
    req.status = S.CANCELLED
    req.error_code = "cancelled"
    db.flush()
    return req


def get_request(db: Session, request_id: uuid.UUID, tenant_id) -> Optional[ShiftCloseRequest]:
    return (
        db.query(ShiftCloseRequest)
        .filter(ShiftCloseRequest.id == request_id, ShiftCloseRequest.tenant_id == tenant_id)
        .first()
    )


# ── Till side ─────────────────────────────────────────────────────────────────


def find_for_till(db: Session, machine: POSMachine, request_id: uuid.UUID) -> Optional[ShiftCloseRequest]:
    return (
        db.query(ShiftCloseRequest)
        .filter(
            ShiftCloseRequest.id == request_id,
            ShiftCloseRequest.machine_id == machine.id,
            ShiftCloseRequest.tenant_id == machine.tenant_id,
        )
        .first()
    )


def apply_ack(
    db: Session,
    machine: POSMachine,
    *,
    request_id: uuid.UUID,
    phase: str,
    shift_id: Optional[uuid.UUID] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Optional[ShiftCloseRequest]:
    """
    The till's ack, if `request_id` is a standalone request of this till; else None
    (the caller then tries the Z runs). Same phases and meaning as a Z run item's.
    """
    req = find_for_till(db, machine, request_id)
    if req is None:
        return None
    now = _now(now)
    if req.status not in PENDING_CLOSE_REQUEST_STATUSES:
        # Cancelled, expired, finished: accepted and changes nothing.
        return req
    if phase in ("received", "deferred"):
        req.status = S.CLOSING
        req.received_at = req.received_at or now
        if phase == "deferred":
            req.error_code = error_code or "deferred"
            req.error_message = error_message
        else:
            req.error_code = None
            req.error_message = None
        if (
            shift_id is not None
            and named_shift_id(req) is None
            and not is_foreign_shift(db, machine, shift_id)
        ):
            _name_shift(db, req, shift_id)
    elif phase == "completed":
        # Informational. The request completes when the close itself is accepted.
        pass
    elif phase == "failed":
        req.status = S.FAILED
        req.error_code = error_code or "failed"
        req.error_message = error_message
        req.failed_at = now
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid phase")
    db.flush()
    return req


def on_shift_close_accepted(
    db: Session, machine: POSMachine, shift: Shift, *, now: Optional[datetime] = None
) -> List[ShiftCloseRequest]:
    """
    Complete every pending request this accepted close answers: the one its
    `closeRequestId` named, any naming this shift, and one that named no shift (the
    cloud had not seen it open). A request naming a *different* shift stays.
    """
    now = _now(now)
    done = []
    for req in _pending_query(db, machine.id).all():
        if (
            (shift.close_request_id is not None and req.id == shift.close_request_id)
            or named_shift_id(req) == shift.id
            or named_shift_id(req) is None
        ):
            req.shift_id = shift.id
            _complete(req, now)
            done.append(req)
    if done:
        db.flush()
    return done


def oldest_pending(db: Session, machine: POSMachine) -> Optional[ShiftCloseRequest]:
    return _pending_query(db, machine.id).order_by(ShiftCloseRequest.created_at.asc()).first()


def pending_machine_ids(db: Session, machine_ids: List[uuid.UUID]) -> Set[uuid.UUID]:
    if not machine_ids:
        return set()
    rows = (
        db.query(ShiftCloseRequest.machine_id)
        .filter(
            ShiftCloseRequest.machine_id.in_(machine_ids),
            ShiftCloseRequest.status.in_(PENDING_CLOSE_REQUEST_STATUSES),
        )
        .all()
    )
    return {r[0] for r in rows}


# ── Out ───────────────────────────────────────────────────────────────────────


def request_to_out(db: Session, req: ShiftCloseRequest, *, now: Optional[datetime] = None) -> dict:
    machine = req.machine or db.query(POSMachine).filter(POSMachine.id == req.machine_id).first()
    pending = req.status in PENDING_CLOSE_REQUEST_STATUSES
    shift_id = named_shift_id(req)
    shift = db.query(Shift).filter(Shift.id == shift_id).first() if shift_id else None
    summary = None
    if shift is not None:
        summary = shift_to_out(
            shift,
            machine_name=machine.name if machine else None,
            shop_name=shift.shop.name if shift.shop is not None else None,
        )
        summary.till_totals = None
        summary.reconstruction_basis = None
    return {
        "id": req.id,
        "machineId": req.machine_id,
        "machineName": machine.name if machine is not None else None,
        "shopId": req.shop_id,
        "shiftId": shift_id,
        "status": req.status,
        "errorCode": req.error_code,
        "errorMessage": req.error_message,
        "createdAt": req.created_at,
        "updatedAt": req.updated_at,
        "expiresAt": req.expires_at,
        "createdByUserId": req.created_by_user_id,
        "sentAt": req.sent_at,
        "receivedAt": req.received_at,
        "completedAt": req.completed_at,
        **till_backlog(machine, now=now),
        # Only while the till still has to act: afterwards the shift's own X says it.
        "documentsOnCloud": (
            documents_on_cloud(db, [shift_id]).get(shift_id) if pending and shift_id else None
        ),
        "shift": summary,
    }
