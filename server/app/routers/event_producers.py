"""
"עמדת מפיק" — the owner's side, on the event (app/services/report_events/producer.py).

Dashboard (Clerk/user JWT + X-Tenant-Id). The event's managing roles over its shop, like
editing the event (`crud.load_event(write=True)`: super admin, distributor, company manager,
shop manager); reading the tab follows the same rule — it lists the producers' e-mails. The
voucher batches (names, customers, production prices) are shown and linked only with the prepaid
vouchers' section (view / edit).

GET    /report-events/{id}/producers               → invited producers, the settings, the batches
POST   /report-events/{id}/producers               → invite {email, name?, sendInvite?}
DELETE /report-events/{id}/producers/{grantId}     → revoke (kept in the list as revoked)
PUT    /report-events/{id}/producer-settings       → {settlementEnabled, batchIds, productionPrices}
"""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User
from app.services.report_events import crud as C
from app.services.report_events import producer as PR
from app.services.report_events import production as PROD

router = APIRouter(prefix="/report-events", tags=["report-events"])


def _http(exc: PR.ProducerError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail={"code": exc.code, "message": exc.message})


def _invite_url() -> str:
    from app.config import get_settings

    s = get_settings()
    base = (getattr(s, "exception_alerts_link_base_url", "") or "").strip() or s.pairing_mobile_app_base_url
    return f"{base.rstrip('/')}/dashboard/producer"


@router.get("/{event_id}/producers")
def get_event_producers(event_id: uuid.UUID, current_user: User = Depends(get_current_user),
                        active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    event = C.load_event(db, current_user, active_tenant_id, event_id, write=True)
    return {**PR.owner_view(db, event, current_user), "inviteUrl": _invite_url()}


@router.post("/{event_id}/producers", status_code=status.HTTP_201_CREATED)
def invite_event_producer(
    event_id: uuid.UUID,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    event = C.load_event(db, current_user, active_tenant_id, event_id, write=True)
    try:
        grant, user, created = PR.invite(db, current_user, event, email=str(body.get("email") or ""), name=body.get("name"))
    except PR.ProducerError as exc:
        raise _http(exc) from None
    db.commit()
    invitation = "not_requested"
    if body.get("sendInvite") is True:
        invitation = PR.send_clerk_invitation(user.email, _invite_url())
    return {
        "grantId": str(grant.id),
        "userId": str(user.id),
        "email": user.email,
        "created": created,
        "inviteUrl": _invite_url(),
        "invitation": invitation,
        **PR.owner_view(db, event, current_user),
    }


@router.delete("/{event_id}/producers/{grant_id}")
def revoke_event_producer(event_id: uuid.UUID, grant_id: uuid.UUID, current_user: User = Depends(get_current_user),
                          active_tenant_id=Depends(get_active_tenant_id), db: Session = Depends(get_db)):
    event = C.load_event(db, current_user, active_tenant_id, event_id, write=True)
    try:
        PR.revoke(db, current_user, event, grant_id)
    except PR.ProducerError as exc:
        raise _http(exc) from None
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{event_id}/producer-settings")
def put_producer_settings(
    event_id: uuid.UUID,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    event = C.load_event(db, current_user, active_tenant_id, event_id, write=True)
    if not PR.may_edit_batches(db, current_user):
        # Linking batches and their prices is the prepaid vouchers' section; the switch is the event's.
        body = {k: v for k, v in (body or {}).items() if k == "settlementEnabled"}
    try:
        event.producer_settings = PROD.clean_settings(event, db, body)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": str(exc)}) from None
    db.commit()
    db.refresh(event)
    return PR.owner_view(db, event, current_user)
