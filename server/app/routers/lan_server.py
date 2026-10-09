"""
The shop's local network on the dashboard (docs/SPEC_LAN_MODE.md §3–4, app/services/lan_server.py).

GET /machines/{machine_id}/lan-server   → "לא משמש כשרת מקומי" for one device: the flag, why
                                          (`set` / `kds_screen`), whether it is suggested
                                          (a kiosk / a handheld) and was ever chosen
PUT /machines/{machine_id}/lan-server   → `{excluded, forceProducerSwitch?}` — the machine
                                          page's switch; the super admin's alone; 409
                                          `lan_server_excluded_main_till` for the main till
PUT /shops/{shop_id}/local-network      → `{enabled, forceProducerSwitch?}` — "רשת מקומית":
                                          needs a main till (409 `local_network_requires_main_till`),
                                          and moves the shop Z production only through the
                                          producer's guard (409 `shop_z_producer_busy`)

Refusals are `{detail: {code, message}}`. The shop's tills are told (their parameters change).
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import lan_server as LS
from app.services import printers as K
from app.services import till_parameters as TP

router = APIRouter(tags=["lan-server"])


class LanServerIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    excluded: bool
    force_producer_switch: bool = Field(False, alias="forceProducerSwitch")


class LocalNetworkIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    enabled: bool
    force_producer_switch: bool = Field(False, alias="forceProducerSwitch")


def _machine(db: Session, machine_id: uuid.UUID, user: User, tenant_id) -> POSMachine:
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, tenant_id)
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    if shop is not None:
        # The shop's managers read it (like the shop's main till card); only the super admin changes it.
        K.check_read(db, user, shop)
    elif user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return machine


def _machine_out(db: Session, machine: POSMachine, user: User) -> dict:
    from app.services.main_till import main_till_of_shop

    state = LS.card_rows(db, [machine])[str(machine.id)]
    main = main_till_of_shop(db, machine.shop_id) if machine.shop_id is not None else None
    return {
        "machineId": str(machine.id),
        **state,
        "isMainTill": main is not None and main.id == machine.id,
        # A display device is outside the LAN group altogether; an independent till too.
        "applies": bool(getattr(machine, "is_fiscal", True)) and not bool(getattr(machine, "independent_till", False)),
        "canEdit": user.role == UserRole.SUPER_ADMIN,
    }


@router.get("/machines/{machine_id}/lan-server")
def get_machine_lan_server(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine = _machine(db, machine_id, current_user, active_tenant_id)
    out = _machine_out(db, machine, current_user)
    db.commit()  # the built-in parameters, if reading created them
    return out


@router.put("/machines/{machine_id}/lan-server")
def put_machine_lan_server(
    machine_id: uuid.UUID,
    body: LanServerIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine = _machine(db, machine_id, current_user, active_tenant_id)
    try:
        LS.set_excluded(db, current_user, machine, body.excluded, force_producer_switch=body.force_producer_switch)
    except HTTPException:
        db.rollback()
        raise
    out = _machine_out(db, machine, current_user)
    targets = TP.notify_targets_for_scope(db, "shop", machine.shop_id) if machine.shop_id else []
    db.commit()
    # Its host parameters change, and the shop's hosts may move: every till of the shop pulls.
    background_tasks.add_task(TP.publish_parameters_notify, targets)
    return out


@router.put("/shops/{shop_id}/local-network")
def put_local_network(
    shop_id: uuid.UUID,
    body: LocalNetworkIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.routers.main_till import _out, _shop

    shop = _shop(db, shop_id, current_user, active_tenant_id)
    try:
        LS.set_local_network(db, current_user, shop, body.enabled, force_producer_switch=body.force_producer_switch)
    except HTTPException:
        db.rollback()
        raise
    out = _out(db, shop, current_user)
    targets = TP.notify_targets_for_scope(db, "shop", shop.id)
    db.commit()
    # The main till learns it produces the shop Z (or no longer) from its next history pull.
    background_tasks.add_task(TP.publish_parameters_notify, targets)
    return out
