"""
"תצורת עבודה למכשיר" on the dashboard (app/services/work_config.py, docs/SPEC_DEVICE_WORK_CONFIG.md).

GET /machines/{machine_id}/work-config → the device's effective configuration: each value with
                                         where it comes from ("נקבע במכשיר" / "לפי הסניף / החברה"),
                                         the presets of its role (available, or why not), the one
                                         it matches now, "לפי הסניף", and how the plan it was
                                         added with went
PUT /machines/{machine_id}/work-config → `{preset?, tablesMode?, lanServerExcluded?, link?,
                                         enableLocalNetwork?, receiptPrinter?, workflowTargets?,
                                         forceProducerSwitch?}` — one transaction through the
                                         services that own each value; a refusal is the service's
                                         own body (`detail`, Hebrew `message`) and `step`
GET /shops/{shop_id}/work-config?role=&platform= → the same for a device still to pair there
                                         (the add-device dialog's step "תצורת עבודה")

Reading is for the shop's managers (the printers page's people); the Z, the LAN roles and the
tables are the super admin's alone, the printing a manager's. The shop's tills are told.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.schemas.work_config import WorkConfigPutIn
from app.services import printers as K
from app.services import till_parameters as TP
from app.services import work_config as WC

router = APIRouter(tags=["work-config"])


def _machine(db: Session, machine_id: uuid.UUID, user: User, tenant_id) -> POSMachine:
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, tenant_id)
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    if shop is not None:
        K.check_read(db, user, shop)
    elif user.role != UserRole.SUPER_ADMIN and not (
        user.role == UserRole.DISTRIBUTOR and machine.distributor_id == user.id
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return machine


def _machine_out(db: Session, machine: POSMachine, user: User) -> dict:
    out = WC.view(db, user, WC.context_for_machine(db, machine))
    out["pairing"] = WC.pairing_outcome(db, machine)
    return out


@router.get("/machines/{machine_id}/work-config")
def get_machine_work_config(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine = _machine(db, machine_id, current_user, active_tenant_id)
    out = _machine_out(db, machine, current_user)
    db.commit()  # the built-in parameters, if reading created them
    return out


@router.put("/machines/{machine_id}/work-config")
def put_machine_work_config(
    machine_id: uuid.UUID,
    body: WorkConfigPutIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine = _machine(db, machine_id, current_user, active_tenant_id)
    try:
        changed = WC.apply(
            db, current_user, machine, body.plan(), force_producer_switch=body.force_producer_switch,
        )
    except WC.WorkConfigRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    targets = WC.notify_targets(db, machine) if changed else []
    out = _machine_out(db, machine, current_user)
    out["changes"] = changed
    db.commit()
    # One `settings` signal per till of the shop: each pulls its parameters, mode and hosts.
    if targets:
        background_tasks.add_task(TP.publish_parameters_notify, targets)
    return out


@router.get("/shops/{shop_id}/work-config")
def get_shop_work_config(
    shop_id: uuid.UUID,
    role: Optional[str] = Query("till", pattern="^(till|kiosk|kds|order_status_board)$"),
    platform: Optional[str] = Query("android", pattern="^(android|windows|web)$"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The add-device dialog's step: what a new device of this role gets in this shop, and the presets."""
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    if shop.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    K.check_read(db, current_user, shop)
    out = WC.view(db, current_user, WC.context_for_new(db, shop, role, platform))
    out["pairing"] = None
    db.commit()
    return out
