"""
"שליטה מרחוק בקופות וקיוסקים" — app/services/device_commands.py.

Dashboard (section `device_control`; the machine admins' scope, app/services/kiosk_control.py):

GET  /device-commands/devices   ?companyId=&shopId=&machineIds= → the panel's rows (online, lock, commands)
POST /device-commands           {action, message?, machineIds? | shopId? | groupId?} → [Command]
GET  /device-commands           ?machineId=&shopId=&limit= → the audit, newest first
POST /device-commands/{id}/cancel

Remote close / Z (REMOTE_TILL_Z_ENABLED; app/services/remote_till_z.py):

GET  /device-commands/features
GET  /device-commands/{machine_id}/close-preview      → a till's close / Z preview
POST /device-commands/close                           {machineId, totalsKey}
GET  /device-commands/shop-close-preview ?shopId=     → "סגירת יום סניפית": by the shop's configuration
POST /device-commands/shop-close                      {shopId, totalsKey, confirmOpenTills?, confirmCloudData?} → the Z run
GET  /device-commands/shop-close/{run_id}             → its progress (builds the Z when every till is ready)
POST /device-commands/shop-close/{run_id}/proceed     {excludeMachineIds} — the existing "build without"
POST /device-commands/shop-close/{run_id}/cancel
POST /device-commands/shop-close/{run_id}/force       {excludeMachineIds, reason} — a super admin only

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
from app.middleware.auth import (
    FISCAL_SYNC_PATH,
    get_active_tenant_id,
    get_current_machine_admin,
    get_current_user,
    get_pos_machine_for_sync_path,
)
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
        if not device_groups.available():
            raise HTTPException(status_code=422, detail={"code": "groups_unavailable", "message": "קבוצות מכשירים עדיין לא זמינות"})
        # This tenant's group (app/services/device_groups.py); each member is still checked below.
        group = device_groups.group(db, group_id, tenant_id)
        if group is None:
            raise HTTPException(status_code=404, detail={"code": "group_not_found", "message": "הקבוצה לא נמצאה"})
        q = q.filter(POSMachine.id.in_(list(group.get("machineIds") or [])))
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


# ── "סגירת משמרת / הפקת Z מרחוק" (app/services/remote_till_z.py, REMOTE_TILL_Z_ENABLED) ──


class RemoteCloseIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(..., alias="machineId")
    #: The preview's `totalsKey` the manager confirmed: a sale since then refuses (409).
    totals_key: str = Field(..., alias="totalsKey", min_length=1, max_length=64)


def _remote_z_machine(db: Session, user: User, tenant_id, machine_id) -> POSMachine:
    """The till for a remote close / Z: the shift admins' roles and scope (as the machines page's
    close and Z), a manager of points of sale's own devices, and the Z section at edit."""
    from app.routers.machines import machine_for_shift_admin
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS

    # The machine admins' roles, whatever a profile grants (the route's dependency says so too).
    get_current_machine_admin(user)
    machine = machine_for_shift_admin(db, machine_id, user, tenant_id)
    _check_covered(db, _narrowing(db, user), machine)
    if not DA.effective_access(db, user).allows("z", DS.EDIT):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "section_forbidden", "section": "z", "level": DS.EDIT})
    return machine


@router.get("/features")
def get_features(current_user: User = Depends(get_current_user)):
    """What of remote control is on: `remoteTillZ` (REMOTE_TILL_Z_ENABLED, off by default)."""
    from app.services import remote_till_z

    return {"remoteTillZ": remote_till_z.enabled()}


@router.get("/{machine_id}/close-preview")
def get_close_preview(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What the manager confirms before a remote close / Z: what the till will do, and its current totals."""
    from app.services import remote_till_z

    remote_till_z.require_enabled()
    machine = _remote_z_machine(db, current_user, active_tenant_id, machine_id)
    out = remote_till_z.preview(db, machine)
    db.commit()  # requests expired on the way
    return out


@router.post("/close", status_code=status.HTTP_201_CREATED)
def post_remote_close(
    body: RemoteCloseIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The confirmed remote close / Z: the till's existing flow, at rest only, never forced."""
    from app.services import remote_till_z

    remote_till_z.require_enabled()
    machine = _remote_z_machine(db, current_user, active_tenant_id, body.machine_id)
    try:
        out = remote_till_z.request(db, current_user, machine, totals_key=body.totals_key)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    return out


class ShopCloseIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shop_id: uuid.UUID = Field(..., alias="shopId")
    #: The shop preview's `totalsKey` the manager confirmed: any sale since refuses (409).
    totals_key: str = Field(..., alias="totalsKey", min_length=1, max_length=64)
    #: The wizard's own confirmations, passed on as they are (`shopZOpenTills`, cloud data).
    confirm_open_tills: bool = Field(False, alias="confirmOpenTills")
    confirm_cloud_data: bool = Field(False, alias="confirmCloudData")


class ShopCloseProceedIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    exclude_machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="excludeMachineIds", max_length=500)


def _remote_z_shop(db: Session, user: User, tenant_id, shop_id) -> Shop:
    """The shop for "סגירת יום סניפית": the Z wizard's own shop access and distributor rule, the Z
    section at edit — and the whole shop: a manager of some of its points of sale only is refused."""
    from app.routers.z_runs import _check_tills, _shop_for
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS
    from app.services import z_runs as ZR

    get_current_machine_admin(user)
    shop = _shop_for(db, shop_id, user, tenant_id)
    if _narrowing(db, user) is not None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "code": "shop_close_needs_whole_shop",
            "message": "סגירת יום סניפית — למנהל הסניף כולו בלבד",
        })
    if not DA.effective_access(db, user).allows("z", DS.EDIT):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "section_forbidden", "section": "z", "level": DS.EDIT})
    _check_tills(db, user, ZR.shop_tills(db, shop.id), tenant_id)
    return shop


def _shop_close_run(db: Session, user: User, tenant_id, run_id: uuid.UUID):
    from app.routers.z_runs import _run_or_404

    run = _run_or_404(db, run_id, user, tenant_id)
    _remote_z_shop(db, user, tenant_id, run.shop_id)
    return run


@router.get("/shop-close-preview")
def get_shop_close_preview(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"סגירת יום סניפית": where the shop Z is produced, every device by its configuration, the
    totals, the next shop Z number, the run under way and which actions are allowed (why not)."""
    from app.services import remote_till_z
    from app.services import z_runs as ZR

    remote_till_z.require_enabled()
    shop = _remote_z_shop(db, current_user, active_tenant_id, shop_id)
    # As the wizard's progress read: expired runs swept, a run whose tills are all ready built.
    ZR.expire_overdue_runs(db)
    current = remote_till_z.current_run(db, shop.id)
    if current is not None:
        ZR.finalise_if_ready(db, current)
    out = remote_till_z.shop_preview(db, shop, user=current_user)
    db.commit()
    return out


@router.post("/shop-close", status_code=status.HTTP_201_CREATED)
def post_shop_close(
    body: ShopCloseIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The confirmed day close: the shop's existing Z run, every till closing at rest only."""
    from fastapi.responses import JSONResponse

    from app.services import remote_till_z
    from app.services import z_runs as ZR

    remote_till_z.require_enabled()
    shop = _remote_z_shop(db, current_user, active_tenant_id, body.shop_id)
    try:
        out = remote_till_z.shop_request(
            db, current_user, active_tenant_id, shop,
            totals_key=body.totals_key,
            confirm_open_tills=body.confirm_open_tills,
            confirm_cloud_data=body.confirm_cloud_data,
        )
    except HTTPException:
        db.rollback()
        raise
    if isinstance(out, JSONResponse):
        db.rollback()
        return out
    db.commit()
    db.refresh(out)
    return ZR.run_to_out(db, out)


@router.get("/shop-close/{run_id}")
def get_shop_close(
    run_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The day close's progress, per till in the owner's words; the Z built once every till is ready."""
    from app.services import remote_till_z
    from app.services import z_runs as ZR

    remote_till_z.require_enabled()
    run = _shop_close_run(db, current_user, active_tenant_id, run_id)
    changed = ZR.expire_overdue_runs(db)
    changed = ZR.finalise_if_ready(db, run) or changed
    if changed:
        db.commit()
        db.refresh(run)
    return remote_till_z.run_progress(db, run, user=current_user)


@router.post("/shop-close/{run_id}/proceed")
def post_shop_close_proceed(
    run_id: uuid.UUID,
    body: ShopCloseProceedIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Build without the listed tills — the existing `proceed_without`, with all its refusals
    (local mode needs every till; `shopZOpenTills`); their shifts wait for the next Z."""
    from app.services import remote_till_z
    from app.services import z_runs as ZR

    remote_till_z.require_enabled()
    run = _shop_close_run(db, current_user, active_tenant_id, run_id)
    ZR.proceed_without(db, run, body.exclude_machine_ids, deferred_by=remote_till_z.who(current_user))
    db.commit()
    db.refresh(run)
    return remote_till_z.run_progress(db, run, user=current_user)


class ShopCloseForceIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    exclude_machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="excludeMachineIds", max_length=500)
    reason: str = Field(..., max_length=300)


@router.post("/shop-close/{run_id}/force")
def post_shop_close_force(
    run_id: uuid.UUID,
    body: ShopCloseForceIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Support's force past "חסימת Z כשיש משמרות פתוחות": a super admin, a typed reason (z_shift_guard)."""
    from app.services import remote_till_z
    from app.services import z_shift_guard

    remote_till_z.require_enabled()
    run = _shop_close_run(db, current_user, active_tenant_id, run_id)
    z_shift_guard.force_without(db, run, current_user, body.exclude_machine_ids, body.reason)
    db.commit()
    db.refresh(run)
    return remote_till_z.run_progress(db, run, user=current_user)


@router.post("/shop-close/{run_id}/cancel")
def post_shop_close_cancel(
    run_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Cancel while waiting — the existing cancel: tills not yet closed are no longer asked to."""
    from app.services import remote_till_z
    from app.services import z_runs as ZR

    remote_till_z.require_enabled()
    run = _shop_close_run(db, current_user, active_tenant_id, run_id)
    ZR.cancel_run(db, run, cancelled_by=remote_till_z.who(current_user))
    db.commit()
    db.refresh(run)
    return remote_till_z.run_progress(db, run, user=current_user)


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
