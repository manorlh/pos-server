"""
Asking a till to transmit its card batch now (docs/SHIFTS_API.md §4.4–§4.5).

Travels the way a remote shift close does: the `transmit` Ably event while the till is
online, `pendingTransmit` on every heartbeat while the request is pending. The till dedupes
by `requestId` and answers with `transmit/ack`; a report (§4.1) that names the request
finishes it too. A request nobody answers expires after 36 h, like the close requests.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.card_transmission import (
    PENDING_TRANSMIT_STATUSES,
    CardTransmission,
    TransmissionStatus,
    TransmitRequest,
    TransmitRequestStatus as S,
)
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.user import User
from app.services import transmissions
from app.services.machine_status import is_online
from app.services.z_runs import Z_RUN_TTL_HOURS, _initiator

#: Same lifetime as a remote close: a till off overnight still gets it.
TRANSMIT_REQUEST_TTL_HOURS = Z_RUN_TTL_HOURS


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def _pending_query(db: Session, machine_id):
    return db.query(TransmitRequest).filter(
        TransmitRequest.machine_id == machine_id,
        TransmitRequest.status.in_(PENDING_TRANSMIT_STATUSES),
    )


def expire_overdue(db: Session, *, now: Optional[datetime] = None) -> int:
    """Lazy: called from every read and write path."""
    now = _now(now)
    rows = (
        db.query(TransmitRequest)
        .filter(
            TransmitRequest.status.in_(PENDING_TRANSMIT_STATUSES),
            TransmitRequest.expires_at < now,
        )
        .all()
    )
    for req in rows:
        req.status = S.EXPIRED
        req.error_code = "expired"
        req.error_message = "The till did not transmit in time"
        req.failed_at = now
    return len(rows)


def request_transmit(
    db: Session, user: User, machine: POSMachine, *, now: Optional[datetime] = None
) -> Tuple[TransmitRequest, bool]:
    """Returns `(request, created)`; the pending one again on a second click."""
    now = _now(now)
    expire_overdue(db, now=now)
    if machine.pairing_status != PairingStatus.ASSIGNED or machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")

    existing = _pending_query(db, machine.id).order_by(TransmitRequest.created_at.asc()).first()
    if existing is not None:
        return existing, False

    req = TransmitRequest(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        created_by_user_id=user.id,
        status=S.WAITING,
        expires_at=now + timedelta(hours=TRANSMIT_REQUEST_TTL_HOURS),
        created_at=now,
        updated_at=now,
    )
    db.add(req)
    db.flush()
    _send(machine, req, user, now)
    return req, True


def _send(machine: POSMachine, req: TransmitRequest, user: User, now: datetime) -> None:
    from app.services.ably_notify import publish_transmit_notify

    if not machine.tenant_id or not is_online(machine.last_heartbeat_at, now=now):
        # Offline is a delay: the heartbeat hands it over on the next beat.
        return
    publish_transmit_notify(str(machine.tenant_id), str(machine.id), str(req.id), _initiator(user))
    req.sent_at = now


def cancel(db: Session, req: TransmitRequest) -> TransmitRequest:
    if req.status not in PENDING_TRANSMIT_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="request_not_pending")
    req.status = S.CANCELLED
    req.error_code = "cancelled"
    db.flush()
    return req


def get_request(db: Session, request_id: uuid.UUID, tenant_id) -> Optional[TransmitRequest]:
    return (
        db.query(TransmitRequest)
        .filter(TransmitRequest.id == request_id, TransmitRequest.tenant_id == tenant_id)
        .first()
    )


# ── Till side ─────────────────────────────────────────────────────────────────


def find_for_till(db: Session, machine: POSMachine, request_id) -> Optional[TransmitRequest]:
    if request_id is None:
        return None
    return (
        db.query(TransmitRequest)
        .filter(
            TransmitRequest.id == request_id,
            TransmitRequest.machine_id == machine.id,
            TransmitRequest.tenant_id == machine.tenant_id,
        )
        .first()
    )


def _complete(req: TransmitRequest, now: datetime, transmission_id) -> None:
    req.status = S.COMPLETED
    req.completed_at = now
    req.error_code = None
    req.error_message = None
    if transmission_id is not None:
        req.transmission_id = transmission_id


def _fail(req: TransmitRequest, now: datetime, code: Optional[str], message: Optional[str], transmission_id) -> None:
    req.status = S.FAILED
    req.failed_at = now
    req.error_code = code or "failed"
    req.error_message = message
    if transmission_id is not None:
        req.transmission_id = transmission_id


def apply_ack(
    db: Session,
    machine: POSMachine,
    *,
    request_id: uuid.UUID,
    phase: str,
    transmission_id: Optional[uuid.UUID] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    now: Optional[datetime] = None,
) -> TransmitRequest:
    now = _now(now)
    req = find_for_till(db, machine, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="transmit_request_not_found")
    expire_overdue(db, now=now)
    if req.status not in PENDING_TRANSMIT_STATUSES:
        return req  # ended: accepted, changes nothing
    if phase in ("received", "deferred"):
        req.status = S.TRANSMITTING
        req.received_at = req.received_at or now
        if phase == "deferred":
            req.error_code = error_code or "deferred"
            req.error_message = error_message
        else:
            req.error_code = None
            req.error_message = None
    elif phase == "completed":
        req.received_at = req.received_at or now
        _complete(req, now, transmission_id)
    elif phase == "failed":
        _fail(req, now, error_code, error_message, transmission_id)
    else:  # pragma: no cover - the schema admits only the four
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid phase")
    db.flush()
    return req


def on_report(db: Session, machine: POSMachine, row: CardTransmission, *, now: Optional[datetime] = None) -> None:
    """A report naming a pending request of this till finishes it (success / failed)."""
    req = find_for_till(db, machine, row.request_id)
    if req is None or req.status not in PENDING_TRANSMIT_STATUSES:
        return
    now = _now(now)
    req.received_at = req.received_at or now
    if row.status == TransmissionStatus.SUCCESS:
        _complete(req, now, row.id)
    elif row.status == TransmissionStatus.FAILED:
        _fail(req, now, "transmission_failed", row.error or row.status_message, row.id)
    else:
        req.transmission_id = row.id
    db.flush()


def take_pending(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[dict]:
    """`{requestId}` for the heartbeat, while a request of this till is pending."""
    now = _now(now)
    expire_overdue(db, now=now)
    req = _pending_query(db, machine.id).order_by(TransmitRequest.created_at.asc()).first()
    if req is None:
        return None
    if req.sent_at is None:
        req.sent_at = now
    return {"requestId": str(req.id)}


def pending_by_machine(db: Session, machine_ids: List[uuid.UUID]) -> Dict[uuid.UUID, uuid.UUID]:
    """Per till with a pending request: the oldest one's id."""
    if not machine_ids:
        return {}
    rows = (
        db.query(TransmitRequest.machine_id, TransmitRequest.id, TransmitRequest.created_at)
        .filter(
            TransmitRequest.machine_id.in_(machine_ids),
            TransmitRequest.status.in_(PENDING_TRANSMIT_STATUSES),
        )
        .order_by(TransmitRequest.created_at.asc())
        .all()
    )
    out: Dict[uuid.UUID, uuid.UUID] = {}
    for machine_id, request_id, _created in rows:
        out.setdefault(machine_id, request_id)
    return out


# ── Out ───────────────────────────────────────────────────────────────────────


def request_to_out(db: Session, req: TransmitRequest, *, now: Optional[datetime] = None) -> dict:
    machine = req.machine or db.query(POSMachine).filter(POSMachine.id == req.machine_id).first()
    row = (
        db.query(CardTransmission).filter(CardTransmission.id == req.transmission_id).first()
        if req.transmission_id
        else None
    )
    return {
        "id": str(req.id),
        "machineId": str(req.machine_id),
        "machineName": machine.name if machine is not None else None,
        "shopId": str(req.shop_id) if req.shop_id else None,
        "status": req.status,
        "errorCode": req.error_code,
        "errorMessage": req.error_message,
        "createdAt": req.created_at,
        "updatedAt": req.updated_at,
        "expiresAt": req.expires_at,
        "createdByUserId": str(req.created_by_user_id),
        "sentAt": req.sent_at,
        "receivedAt": req.received_at,
        "completedAt": req.completed_at,
        "failedAt": req.failed_at,
        "online": is_online(machine.last_heartbeat_at, now=now) if machine is not None else False,
        "transmissionId": str(req.transmission_id) if req.transmission_id else None,
        "transmission": transmissions.transmission_to_out(db, row) if row is not None else None,
    }
