"""
"שליטה מרחוק בקופות וקיוסקים" — app/services/device_commands.py.

Dashboard (section `device_control`; the machine admins' scope, app/services/kiosk_control.py):

GET  /device-commands/devices   ?companyId=&shopId=&machineIds= → the panel's rows (online, lock, commands)
POST /device-commands           {action, message?, machineIds? | shopId? | groupId?} → [Command]
GET  /device-commands           ?machineId=&shopId=&limit= → the audit, newest first
POST /device-commands/{id}/cancel

Till (`get_pos_machine_for_sync_path`):

GET  /sync/{machine_id}/device-commands                → {state, commands} (pending → delivered)
POST /sync/{machine_id}/device-commands/{id}/ack       {status: done|refused|failed, detail?}
POST /sync/{machine_id}/device-commands/unlocked       {posUserId?, posUserName?} — a manager code released the lock
"""
from __future__ import annotations

import uuid
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import FISCAL_SYNC_PATH, get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path
from app.models.device_command import DEVICE_ACTIONS, DeviceCommand
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.services import device_commands as svc
from app.services import device_groups
from app.services import kiosk_control

router = APIRouter(prefix="/device-commands", tags=["device-commands"])
till_router = APIRouter(prefix="/sync", tags=["device-commands"])


class CommandIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    action: Literal["lock", "unlock", "sync_now", "refresh_catalog", "sign_out", "restart_app", "install_update"]
    message: Optional[str] = Field(None, max_length=300)
    machine_ids: Optional[List[uuid.UUID]] = Field(None, alias="machineIds", max_length=500)
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    group_id: Optional[uuid.UUID] = Field(None, alias="groupId")


class AckIn(BaseModel):
    status: Literal["done", "refused", "failed"]
    detail: Optional[str] = Field(None, max_length=300)


class UnlockedIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    pos_user_id: Optional[str] = Field(None, alias="posUserId")
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)
    #: The lock the till released (its `lockedAt`): a newer lock is never released by an old report.
    locked_at: Optional[str] = Field(None, alias="lockedAt", max_length=64)


def _devices(db: Session, user: User, tenant_id, *, machine_ids=None, shop_id=None, company_id=None, group_id=None) -> List[POSMachine]:
    """The active devices named (ids, a shop, a company or a group), each checked against the user's scope."""
    kiosk_control.require_kiosk_role(user)
    q = db.query(POSMachine).filter(POSMachine.tenant_id == tenant_id, POSMachine.is_active.is_(True))
    if machine_ids:
        q = q.filter(POSMachine.id.in_(list(machine_ids)))
    elif group_id is not None:
        group = device_groups.group(db, group_id)
        if group is None:
            raise HTTPException(status_code=422, detail={"code": "groups_unavailable", "message": "קבוצות מכשירים עדיין לא זמינות"})
        q = q.filter(POSMachine.id.in_(list(group.get("machineIds") or [])))  # pragma: no cover - wired at merge
    elif shop_id is not None:
        q = q.filter(POSMachine.shop_id == shop_id)
    elif company_id is not None:
        q = q.join(Shop, Shop.id == POSMachine.shop_id).filter(Shop.company_id == company_id)
    else:
        q = kiosk_control._scoped_machine_query(db, user, tenant_id)
    machines = [m for m in q.order_by(POSMachine.shop_id, POSMachine.pos_number, POSMachine.name).all()
                if getattr(m, "is_fiscal", True) is not False and m.shop_id is not None]
    narrow = _narrowing(db, user)
    allowed = []
    for m in machines:
        try:
            kiosk_control.check_machine_scope(db, user, m, tenant_id)
            _check_covered(db, narrow, m)
        except HTTPException:
            if machine_ids:
                raise
            continue
        allowed.append(m)
    return allowed


def _narrowing(db: Session, user: User):
    """A manager of points of sale's areas / devices (app/services/stock_scope.py), or None."""
    from app.services import stock_scope

    scope = stock_scope.scope_of(db, user)
    return scope if scope.narrowed else None


def _check_covered(db: Session, narrow, machine: POSMachine) -> None:
    """403 when a manager of points of sale names a device outside theirs."""
    from app.services import stock_locations as SL

    if narrow is not None and not narrow.covers_path(SL.path_of_machine(db, machine)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")


@router.get("/devices")
def list_devices(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machines = _devices(
        db, current_user, active_tenant_id, machine_ids=machine_ids, shop_id=shop_id, company_id=company_id,
    )
    out = svc.devices_status(db, machines)
    db.commit()  # expired commands settled on the way
    return out


@router.post("", status_code=status.HTTP_201_CREATED)
def create_commands(
    body: CommandIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machines = _devices(
        db, current_user, active_tenant_id, machine_ids=body.machine_ids, shop_id=body.shop_id, group_id=body.group_id,
    )
    if not machines:
        raise HTTPException(status_code=422, detail={"code": "no_devices", "message": "לא נמצאו מכשירים"})
    rows = svc.create(db, machines, body.action, message=body.message, user=current_user)
    db.commit()
    svc.wake(machines)
    return [svc.command_out(r) for r in rows]


@router.get("")
def list_commands(
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machines = _devices(
        db, current_user, active_tenant_id, machine_ids=[machine_id] if machine_id else None, shop_id=shop_id,
    )
    ids = [m.id for m in machines]
    if not ids:
        return []
    svc.expire_old(db)
    rows = (
        db.query(DeviceCommand)
        .filter(DeviceCommand.machine_id.in_(ids))
        .order_by(DeviceCommand.created_at.desc(), DeviceCommand.id.desc())
        .limit(limit)
        .all()
    )
    db.commit()
    return [svc.command_out(r) for r in rows]


@router.post("/{command_id}/cancel")
def cancel_command(
    command_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    row = db.get(DeviceCommand, command_id)
    if row is None or str(row.tenant_id) != str(active_tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="command_not_found")
    machine = db.get(POSMachine, row.machine_id)
    kiosk_control.check_machine_scope(db, current_user, machine, active_tenant_id)
    _check_covered(db, _narrowing(db, current_user), machine)
    svc.cancel(db, row)
    db.commit()
    return svc.command_out(row)


# ── The till ─────────────────────────────────────────────────────────────────


@till_router.get("/{machine_id}/device-commands")
def till_pull(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    out = svc.pull(db, machine)
    db.commit()
    return out


@till_router.post("/{machine_id}/device-commands/unlocked", dependencies=FISCAL_SYNC_PATH)
def till_unlocked(
    machine_id: str,
    body: UnlockedIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """A manager code on the till released its lock (checked on the till against its roster)."""
    row = svc.unlock_from_till(db, machine, manager_name=body.pos_user_name, locked_at=body.locked_at)
    db.commit()
    return {"state": svc.state_out(svc.state_of(db, machine.id)), "command": svc.command_out(row) if row is not None else None}


@till_router.post("/{machine_id}/device-commands/{command_id}/ack", dependencies=FISCAL_SYNC_PATH)
def till_ack(
    machine_id: str,
    command_id: str,
    body: AckIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    row = svc.ack(db, machine, command_id, body.status, body.detail)
    db.commit()
    return svc.command_out(row)


__all__ = ["router", "till_router", "DEVICE_ACTIONS"]
