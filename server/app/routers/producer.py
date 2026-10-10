"""
"עמדת מפיק" — the producer's read-only portal (app/services/report_events/producer.py).

Dashboard token (Clerk) + X-Tenant-Id, role PRODUCER_VIEW (the super admin may look too, to see
what a producer sees). Every route below answers only for an event granted to the caller —
anything else is 404, whether it exists or not. A PRODUCER_VIEW user reaches nothing outside
these routes (app/services/dashboard_access.py).

GET /producer/events                     → my events (newest first)
GET /producer/events/{id}                → the event's sales: totals, by the hour, the items
GET /producer/events/{id}/vouchers       → my production's vouchers redeemed at the event's shop
GET /producer/events/{id}/settlement     → at production price — only when the owner opened it
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User, UserRole
from app.services.report_events import producer as PR

router = APIRouter(prefix="/producer", tags=["producer"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _http(exc: PR.ProducerError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail={"code": exc.code, "message": exc.message})


def _producer(user: User) -> User:
    if user.role not in (UserRole.PRODUCER_VIEW, UserRole.SUPER_ADMIN):
        raise HTTPException(status_code=403, detail={"code": "producer_only", "message": "לעמדת המפיק בלבד"})
    return user


def _event(db: Session, user: User, tenant_id, event_id):
    _producer(user)
    try:
        return PR.granted_event(db, user, tenant_id, event_id)
    except PR.ProducerError as exc:
        raise _http(exc) from None


@router.get("/events")
def list_my_events(current_user: User = Depends(get_current_user), active_tenant_id=Depends(get_active_tenant_id),
                   db: Session = Depends(get_db)):
    _producer(current_user)
    return {"events": PR.my_events(db, current_user, active_tenant_id, _now())}


@router.get("/events/{event_id}")
def get_my_event(event_id: uuid.UUID, current_user: User = Depends(get_current_user),
                 active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    event = _event(db, current_user, active_tenant_id, event_id)
    return PR.summary(db, event, _now())


@router.get("/events/{event_id}/vouchers")
def get_my_event_vouchers(event_id: uuid.UUID, current_user: User = Depends(get_current_user),
                          active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    event = _event(db, current_user, active_tenant_id, event_id)
    return PR.vouchers(db, event, _now())


@router.get("/events/{event_id}/settlement")
def get_my_event_settlement(event_id: uuid.UUID, current_user: User = Depends(get_current_user),
                            active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    event = _event(db, current_user, active_tenant_id, event_id)
    try:
        return PR.settlement(db, event, _now())
    except PR.ProducerError as exc:
        raise _http(exc) from None
