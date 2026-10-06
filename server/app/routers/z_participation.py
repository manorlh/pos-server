"""
"קופות בזד הסניפי" on a shop page — which tills take part in the shop Z and which are
independent ("קופה עצמאית", docs/SPEC_INDEPENDENT_TILL.md, app/services/independent_till.py),
and the shop's main till among the participants.

GET /shops/{shop_id}/z-participation → every till of the shop with its role
                                       (`shop_z` | `independent` | `own_z`), the main till,
                                       the shop's local mode
PUT /shops/{shop_id}/z-participation → `{participants?, independent?, mainTillId?}` — the
                                       super admin's alone, all or nothing; a refusal names
                                       the till and says why in Hebrew (`message`)

The shop's tills are told (their parameters change: the host flags, `tablesMode`).

And, for a shop in local mode (docs/SPEC_INDEPENDENT_TILL.md §8.9), the dashboard's request
to the main till for the shop Z — it never starts one itself there:

GET/POST/DELETE /shops/{shop_id}/local-shop-z-request
"""
from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_machine_admin,
    get_current_user,
)
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import independent_till as IT
from app.services import local_shop_z as LZ
from app.services import printers as K
from app.services import till_parameters as TP
from app.services.till_z import TillZRefused

router = APIRouter(tags=["z-participation"])


class ZParticipationIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: These tills join the shop Z ("Z סניפי").
    participants: List[uuid.UUID] = Field(default_factory=list)
    #: These tills become independent ("קופה עצמאית").
    independent: List[uuid.UUID] = Field(default_factory=list)
    #: Absent: the main till stays; null: none; a till: it (a participant after the save).
    main_till_id: Optional[uuid.UUID] = Field(None, alias="mainTillId")
    #: The super admin moves the shop's Z production although its producer may still hold
    #: shop Zs the cloud does not (docs/SPEC_INDEPENDENT_TILL.md §8.10).
    force_producer_switch: bool = Field(False, alias="forceProducerSwitch")


class ConflictResolveIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    note: Optional[str] = Field(None, max_length=500)


def _shop(db: Session, shop_id: uuid.UUID, user: User, tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    if shop.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    K.check_read(db, user, shop)
    return shop


@router.get("/shops/{shop_id}/z-participation")
def get_z_participation(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    out = IT.shop_state(db, shop, current_user)
    db.commit()  # the built-in parameters, if reading created them
    return out


@router.get("/shops/{shop_id}/shop-z-producer")
def get_shop_z_producer(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Who produces the shop's Zs, a handover waiting, and the conflicts for support (§8.10–8.11)."""
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    out = LZ.producer_state(db, shop)
    db.commit()
    return out


@router.post("/shops/{shop_id}/shop-z-producer/handover")
def post_shop_z_producer_handover(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "העבר את הפקת ה-Z עכשיו" — the super admin's alone: the production moves to the
    configured producer at once, although the main till holding it may still have shop Zs
    the cloud does not (it died). Recorded; any such Z that turns up later is a conflict.
    """
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    LZ.handover_now(db, current_user, shop)
    out = LZ.producer_state(db, shop)
    db.commit()
    return out


@router.post("/shops/{shop_id}/shop-z-conflicts/{z_id}/resolve")
def post_resolve_shop_z_conflict(
    shop_id: uuid.UUID,
    z_id: uuid.UUID,
    body: ConflictResolveIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Support settled a shop Z the cloud could not file as printed (the super admin's): it
    stops blocking the main till, which keeps that Z as printed. Its number is not changed.
    """
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    try:
        LZ.resolve_conflict(db, current_user, shop, z_id, note=body.note)
    except LZ.LocalShopZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    out = LZ.producer_state(db, shop)
    db.commit()
    return out


@router.get("/shops/{shop_id}/local-shop-z-request")
def get_local_shop_z_request(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """In local mode: the dashboard's request to the main till for the shop Z, and how it went."""
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    out = LZ.request_state(db, shop)
    db.commit()
    return out


@router.post("/shops/{shop_id}/local-shop-z-request", status_code=status.HTTP_201_CREATED)
def post_local_shop_z_request(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "בקש מהקופה הראשית": in local mode the dashboard asks the main till for the shop Z (it
    never starts one itself). The main till gets it on its next heartbeat, closes every
    participating till over the LAN and produces the Z; a till that blocks it is named here.
    """
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    try:
        LZ.request_from_dashboard(db, current_user, shop)
    except LZ.LocalShopZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    out = LZ.request_state(db, shop)
    db.commit()
    return out


@router.delete("/shops/{shop_id}/local-shop-z-request")
def delete_local_shop_z_request(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    try:
        LZ.cancel_request(db, shop)
    except LZ.LocalShopZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    out = LZ.request_state(db, shop)
    db.commit()
    return out


@router.put("/shops/{shop_id}/z-participation")
def put_z_participation(
    shop_id: uuid.UUID,
    body: ZParticipationIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    kwargs = {}
    if "main_till_id" in body.model_fields_set:
        kwargs["main_till_id"] = body.main_till_id
    try:
        IT.apply_shop(
            db, current_user, shop,
            participants=body.participants, independent=body.independent,
            force_producer_switch=body.force_producer_switch, **kwargs,
        )
    except IT.IndependentSwitchRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    except LZ.LocalShopZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    except TillZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    out = IT.shop_state(db, shop, current_user)
    targets = TP.notify_targets_for_scope(db, "shop", shop.id)
    db.commit()
    # One `settings` signal: each till's next sync pulls its parameters, mode and printers.
    background_tasks.add_task(TP.publish_parameters_notify, targets)
    return out
