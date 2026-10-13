"""
"העברת שרת מקומי" and "סגירת משמרת מהענן" (app/services/local_server_switch.py,
P:/specs/local-server-switch.md §8).

GET  /shops/{shop_id}/local-server                      → the wizard: the server now (last heard,
                                                          open shift, pending documents), the tills
                                                          that may take it, what the caller may do,
                                                          the latest switches and "X שינויים מהשרת
                                                          הקודם"
POST /shops/{shop_id}/local-server/switch               {targetMachineId, closeOldShift?, countedCash?,
                                                          force?, releaseShopZ?} — the super admin, or
                                                          a user granted "העברת שרת מקומי"
POST /shops/{shop_id}/local-server/former-host-changes/ack  {ids?} — "סמן כנבדק"
GET  /machines/{machine_id}/shifts/close-from-cloud     → the till's state for the dialog
POST /machines/{machine_id}/shifts/close-from-cloud     {countedCash?, reason?} — a till not heard
                                                          for 5 minutes; the existing remote close's
                                                          people (409 `till_online` otherwise)

"שרת מקומי ייעודי" (app/services/local_server_device.py, local_server_failover.py;
P:/specs/dedicated-local-server.md §11):

GET  /shops/{shop_id}/local-server/failover             → "גיבוי אוטומטי לשרת המקומי": the setting (off
                                                          by default), the target, what it would do now
PUT  /shops/{shop_id}/local-server/failover             {enabled, targetMachineId?, minutes?} — the
                                                          super admin, or "העברת שרת מקומי"; audited
GET  /machines/{machine_id}/local-server                → the device page's "שרת מקומי" card
POST /machines/{machine_id}/local-server/commands       {action, params?, confirm?} — restart_app,
                                                          upload_logs, print_test_page,
                                                          clear_print_queue (with `confirm`)
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from typing import List, Optional

from typing import Any, Dict

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_machine_admin, get_current_user
from app.models.user import User
from app.services import local_server_switch as LSS

router = APIRouter(tags=["local-server"])


class SwitchIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    target_machine_id: uuid.UUID = Field(..., alias="targetMachineId")
    #: "לסגור את המשמרת הפתוחה בקופה X מהענן?" — the old server's, in the same step.
    close_old_shift: bool = Field(False, alias="closeOldShift")
    #: A drawer someone counted by hand (with `closeOldShift`); absent / null — not counted.
    counted_cash: Optional[Decimal] = Field(None, alias="countedCash", ge=0, le=10_000_000)
    #: "כפה העברה": the cloud still hears the old server — two servers may result.
    force: bool = False
    #: "העבר את הפקת ה-Z עכשיו" in the same step (the super admin's).
    release_shop_z: bool = Field(False, alias="releaseShopZ")


class FailoverIn(BaseModel):
    """"גיבוי אוטומטי לשרת המקומי": off by default — on only when sent so, with a target."""

    model_config = ConfigDict(populate_by_name=True)

    enabled: bool = False
    target_machine_id: Optional[uuid.UUID] = Field(None, alias="targetMachineId")
    #: Minutes the cloud must not hear the server before it moves it (2–60; default 3).
    minutes: Optional[int] = None


class ServerCommandIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    action: str = Field(..., max_length=32)
    params: Optional[Dict[str, Any]] = None
    #: "ניקוי תור תקוע" deletes print jobs not printed: sent only once the user confirmed.
    confirm: bool = False


class AckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ids: Optional[List[str]] = Field(None, max_length=500)


class CloseFromCloudIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    counted_cash: Optional[Decimal] = Field(None, alias="countedCash", ge=0, le=10_000_000)
    reason: Optional[str] = Field(None, max_length=300)


def _shop(db: Session, shop_id: uuid.UUID, user: User, tenant_id):
    # The main till card's own access: the shop's managers (and the super admin).
    from app.routers.main_till import _shop as card_shop

    return card_shop(db, shop_id, user, tenant_id)


@router.get("/shops/{shop_id}/local-server")
def get_local_server(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    out = LSS.state(db, shop, current_user)
    db.commit()  # the shop Z producer's pin, if reading pinned it
    return out


@router.post("/shops/{shop_id}/local-server/switch")
def post_local_server_switch(
    shop_id: uuid.UUID,
    body: SwitchIn,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The full move of the local server (§8): `mainTill`, `tablesHostTill`, `printHostTill` and
    `shopZMasterTill`, the notice to every till, the audit. 409 `host_online` while the cloud
    hears the old server, unless `force`.
    """
    from app.services import tables as T
    from app.services import till_parameters as TP

    shop = _shop(db, shop_id, current_user, active_tenant_id)
    # One move of the shop's server at a time — never beside the automatic failover (§11.7).
    with LSS.switch_lock(db, shop.id, wait=True):
        db.expire(shop)  # what a move that held the lock committed, never a stale copy
        try:
            out = LSS.switch(
                db, current_user, shop, body.target_machine_id,
                close_old_shift=body.close_old_shift,
                counted_cash=body.counted_cash,
                force=body.force,
                release_shop_z=body.release_shop_z,
            )
        except Exception:
            db.rollback()
            raise
        targets = TP.notify_targets_for_scope(db, "shop", shop.id)
        db.commit()
    # Every till re-reads its parameters and printers, and pulls the tables' new host.
    background_tasks.add_task(TP.publish_parameters_notify, targets)
    T.tables_changed(db, shop.id, tenant_id=shop.tenant_id)
    return {**out, "state": LSS.state(db, shop, current_user)}


@router.post("/shops/{shop_id}/local-server/former-host-changes/ack")
def post_former_host_changes_ack(
    shop_id: uuid.UUID,
    body: Optional[AckIn] = None,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"סמן כנבדק" on the old server's changes the cloud did not apply (gap 1)."""
    shop = _shop(db, shop_id, current_user, active_tenant_id)
    n = LSS.acknowledge_changes(shop, current_user, (body.ids if body is not None else None))
    db.commit()
    return {"acknowledged": n, "formerHostChanges": LSS.former_host_changes_out(shop)}


@router.get("/shops/{shop_id}/local-server/failover")
def get_local_server_failover(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"גיבוי אוטומטי לשרת המקומי": the setting, its target, and what the cloud would do now."""
    from app.services import local_server_failover as LSF

    shop = _shop(db, shop_id, current_user, active_tenant_id)
    return LSF.view(db, shop, current_user)


@router.put("/shops/{shop_id}/local-server/failover")
def put_local_server_failover(
    shop_id: uuid.UUID,
    body: FailoverIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Change it — the super admin, or a user granted "העברת שרת מקומי" (403 otherwise). Off by
    default; on needs a target of the shop that may take the server; every change is audited.
    """
    from app.services import local_server_failover as LSF

    shop = _shop(db, shop_id, current_user, active_tenant_id)
    with LSS.switch_lock(db, shop.id, wait=True):
        db.expire(shop)
        try:
            out = LSF.update(
                db, current_user, shop,
                enabled=body.enabled, target_machine_id=body.target_machine_id, minutes=body.minutes,
            )
        except Exception:
            db.rollback()
            raise
        db.commit()
    return out


def _server(db: Session, machine_id: uuid.UUID, user: User, tenant_id):
    """A local server the user may control (the device commands' people and scope)."""
    from app.models.pos_machine import POSMachine
    from app.services import kiosk_control
    from app.services.local_server_device import is_local_server

    kiosk_control.require_kiosk_role(user)
    machine = db.get(POSMachine, machine_id)
    if machine is None or (tenant_id is not None and str(machine.tenant_id) != str(tenant_id)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    kiosk_control.check_machine_scope(db, user, machine, tenant_id)
    if not is_local_server(machine):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_a_local_server", "message": "המכשיר אינו שרת מקומי."},
        )
    return machine


@router.get("/machines/{machine_id}/local-server")
def get_machine_local_server(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The device page's "שרת מקומי" card: what it serves, its tills, orders, print queue, printers, lag."""
    from app.services import local_server_device as LSD

    machine = _server(db, machine_id, current_user, active_tenant_id)
    return LSD.card(db, machine, current_user)


@router.post("/machines/{machine_id}/local-server/commands", status_code=status.HTTP_201_CREATED)
def post_machine_local_server_command(
    machine_id: uuid.UUID,
    body: ServerCommandIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    A remote command to the server (§11.5): restart the service, send logs, a test page on one
    printer, clear a stuck queue (only with `confirm`). Queued like every device command; the
    server answers on its own (`GET /device-commands/status`).
    """
    from app.services import device_commands as DC
    from app.services import local_server_device as LSD

    machine = _server(db, machine_id, current_user, active_tenant_id)
    try:
        row = LSD.command(db, current_user, machine, body.action, body.params, confirm=body.confirm)
    except Exception:
        db.rollback()
        raise
    out = DC.command_out(row)
    db.commit()
    DC.wake([machine])
    return out


def _machine(db: Session, machine_id: uuid.UUID, user: User, tenant_id):
    """The existing remote shift close's people (§7.3): machine admins, the till's shift-admin scope."""
    from app.routers.machines import machine_for_shift_admin

    get_current_machine_admin(user)
    return machine_for_shift_admin(db, machine_id, user, tenant_id)


@router.get("/machines/{machine_id}/shifts/close-from-cloud")
def get_close_from_cloud(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine = _machine(db, machine_id, current_user, active_tenant_id)
    return {
        **LSS.till_state(db, machine),
        "closeFromCloudAfterSeconds": int(LSS.CLOSE_FROM_CLOUD_AFTER.total_seconds()),
        "label": LSS.CLOUD_CLOSE_LABEL,
    }


@router.post("/machines/{machine_id}/shifts/close-from-cloud")
def post_close_from_cloud(
    machine_id: uuid.UUID,
    body: Optional[CloseFromCloudIn] = None,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "סגירת משמרת מהענן": the till's open shift closed from the cloud's documents, no Z — only
    for a till the cloud has not heard for 5 minutes (409 `till_online`: the ordinary remote
    close, `POST /machines/{id}/close-shift`, is for a till that answers).
    """
    machine = _machine(db, machine_id, current_user, active_tenant_id)
    options = body or CloseFromCloudIn()
    try:
        out = LSS.close_from_cloud(db, current_user, machine, counted_cash=options.counted_cash, reason=options.reason)
    except Exception:
        db.rollback()
        raise
    db.commit()
    return out
