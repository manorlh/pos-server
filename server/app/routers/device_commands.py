"""
"שליטה מרחוק בקופות וקיוסקים" — app/services/device_commands.py.

Dashboard (section `device_control`; the machine admins' scope, app/services/kiosk_control.py):

GET  /device-commands/devices   ?companyId=&shopId=&machineIds= → the panel's rows (online, lock, commands)
POST /device-commands           {action, message?, params?, machineIds? | shopId? | groupId?} → [Command]
                                (`upload_logs` "בקש לוגים": params {minutes 15–1440}; its own
                                endpoint for whoever reads logs is POST /device-logs/requests)
                                (fire-and-forget; header Idempotency-Key: a retry never sends twice)
GET  /device-commands/status    ?ids= → {items: [Command]} — the background status read
GET  /device-commands           ?machineId=&shopId=&limit= → the audit, newest first
POST /device-commands/{id}/cancel

Till (`get_pos_machine_for_sync_path`):

GET  /sync/{machine_id}/device-commands                → {state, commands} (pending → delivered)
POST /sync/{machine_id}/device-commands/{id}/ack       {status: done|refused|failed, detail?, log_id?}
POST /sync/{machine_id}/device-commands/unlocked       {posUserId?, posUserName?} — a manager code released the lock
"""
from __future__ import annotations

import uuid
from typing import Annotated, Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import FISCAL_SYNC_PATH, get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path
from app.models.device_command import DEVICE_ACTIONS, DeviceCommand
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.services import command_idempotency as idem
from app.services import device_commands as svc
from app.services import device_groups
from app.services import kiosk_control

router = APIRouter(prefix="/device-commands", tags=["device-commands"])
till_router = APIRouter(prefix="/sync", tags=["device-commands"])


class CommandIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    action: Literal[
        "lock", "unlock", "sync_now", "refresh_catalog", "sign_out", "restart_app", "install_update", "upload_logs",
    ]
    message: Optional[str] = Field(None, max_length=300)
    machine_ids: Optional[List[uuid.UUID]] = Field(None, alias="machineIds", max_length=500)
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    group_id: Optional[uuid.UUID] = Field(None, alias="groupId")
    #: The action's parameters: `upload_logs` → {"minutes": 15–1440} (default 120). Others: none.
    params: Optional[Dict[str, Any]] = None

    @model_validator(mode="after")
    def _action_params(self):
        from app.services import device_logs

        self.params = device_logs.request_params(self.params) if self.action == "upload_logs" else None
        return self


class AckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["done", "refused", "failed"]
    detail: Optional[str] = Field(None, max_length=300)
    #: "בקש לוגים": the upload that answered it (`POST /sync/{m}/device-logs`), as {"log_id": …}.
    log_id: Optional[uuid.UUID] = Field(None, validation_alias=AliasChoices("log_id", "logId"))
    result: Optional[Dict[str, Any]] = None

    def result_out(self) -> Optional[Dict[str, Any]]:
        log_id = self.log_id
        if log_id is None and isinstance(self.result, dict) and self.result.get("log_id"):
            try:
                log_id = uuid.UUID(str(self.result["log_id"]))
            except (TypeError, ValueError):
                log_id = None
        return {"log_id": str(log_id)} if log_id is not None else None


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
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
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
    response: Response = None,
    idempotency_key: Annotated[Optional[str], Header(alias=idem.KEY_HEADER)] = None,
):
    """
    Fire-and-forget: queues one command per device and returns at once (status `pending`,
    "נשלח"); the device answers later (`GET /device-commands/status`). `Idempotency-Key`: a retry
    gets the same commands back, never a second one (app/services/command_idempotency.py).
    """
    machines = _devices(
        db, current_user, active_tenant_id, machine_ids=body.machine_ids, shop_id=body.shop_id, group_id=body.group_id,
    )
    if not machines:
        raise HTTPException(status_code=422, detail={"code": "no_devices", "message": "לא נמצאו מכשירים"})
    out, replayed = idem.once(
        db, tenant_id=active_tenant_id, kind="device_command", key=idempotency_key, user=current_user,
        request=body.model_dump(mode="json", by_alias=True),
        run=lambda: [
            svc.command_out(r)
            for r in svc.create(db, machines, body.action, message=body.message, user=current_user, params=body.params)
        ],
        after_commit=lambda _out: svc.wake(machines),
        refresh=lambda first: _reread(db, first),
    )
    if replayed and response is not None:
        response.headers[idem.REPLAY_HEADER] = "true"
    return out


@router.get("/status")
def get_commands_status(
    ids: List[uuid.UUID] = Query(..., max_length=100),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The background status read of "פקודות שנשלחו": these commands as they are now (pending →
    delivered → done / refused / failed / expired / cancelled). Only the user's own scope: a
    command on a device they may not control is left out (never a 403 that names it).
    """
    kiosk_control.require_kiosk_role(current_user)
    now = svc.utc_now()
    rows = (
        db.query(DeviceCommand)
        .filter(DeviceCommand.id.in_(list(ids)), DeviceCommand.tenant_id == active_tenant_id)
        .all()
    )
    narrow = _narrowing(db, current_user)
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_({r.machine_id for r in rows})).all()} if rows else {}
    items = []
    for row in rows:
        machine = machines.get(row.machine_id)
        if machine is None:
            continue
        try:
            kiosk_control.check_machine_scope(db, current_user, machine, active_tenant_id)
            _check_covered(db, narrow, machine)
        except HTTPException:
            continue
        items.append(_as_of(row, now))
    # Read only: nothing is written (a poll never races a device's answer).
    return {"items": items}


def _as_of(row: DeviceCommand, now) -> dict:
    """
    The command as it stands at [now], computed without writing: one past its end reads
    `expired` (`not_answered` when delivered), as `svc.expire_old` would make it.
    """
    out = svc.command_out(row)
    if row.status == "pending" and row.expires_at is not None and svc._aware(row.expires_at) <= now:
        out["status"] = "expired"
    elif (
        row.status == "delivered" and row.delivered_at is not None
        and svc._aware(row.delivered_at) + svc.answer_window(row.action) <= now
    ):
        out["status"] = "expired"
        out["detail"] = out["detail"] or "not_answered"
    return out


def _reread(db: Session, first: list) -> list:
    """A replayed answer: the same commands, re-read by id (their status now)."""
    now = svc.utc_now()
    out = []
    for item in first or []:
        row = db.get(DeviceCommand, uuid.UUID(str(item["id"])))
        out.append(_as_of(row, now) if row is not None else item)
    return out


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
    row = svc.ack(db, machine, command_id, body.status, body.detail, result=body.result_out())
    db.commit()
    return svc.command_out(row)


__all__ = ["router", "till_router", "DEVICE_ACTIONS"]
