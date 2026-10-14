"""
"מסופונים — מצב לא מקוון" — every card terminal of a shop to the deferred mode and back
(P:/specs/nayax-deferred-all.md §8, §9; app/services/deferred_control.py).

Dashboard (section `terminals_offline`; the super admin, a company manager over the shop, the shop's
manager — a manager of some of its points of sale sees and switches their own tills only):

GET  /shops/{shop_id}/deferred-terminals             → {settings, controllers, canSwitch, open, tills: [...]}
POST /shops/{shop_id}/deferred-terminals/switch      {on, machineIds?} (absent: every till included)
                                                     → {batchId, created: [{machineId, commandId}],
                                                        skipped: [{machineId, reason}]}
PUT  /shops/{shop_id}/deferred-terminals/controllers {machineId, on} — "קופה מנהלת מצב לא מקוון" on the
                                                     device page: the till in / out of the SHOP's own
                                                     `deferredControlTills` → the shop's view
GET  /machines/{machine_id}/deferred-settings        → the device page's card: isController, and the till's
                                                     own `deferredAutoOn*` (own / inherited / effective)
PUT  /machines/{machine_id}/deferred-settings        {values: {key: value | null}} (sections devices or
                                                     terminals_offline at edit)

Till (machine token, like the other /sync routes):

GET  /sync/{machine_id}/deferred-control             → {controller, settings, controllers, tills, serverTime}
                                                     (§8.4, §8.6: every till gets the shop's other controllers)

A till event `deferred_mode_on` with `source: "auto"`, `trigger: "auto_on"` of a till whose
`deferredAutoOnAll` is on switches the shop's other tills through the cloud (app/routers/exceptions.py,
`deferred_control.on_till_event`).

The commands are device commands (`terminal_offline`); their rows are the audit — who asked, when,
what each till did (app/services/device_commands.py).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user, get_pos_machine_for_sync_path
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import deferred_control as DCtl
from app.services import device_commands as DC

router = APIRouter(tags=["deferred-terminals"])
till_router = APIRouter(prefix="/sync", tags=["deferred-terminals"])

#: Who switches a shop's terminals from the dashboard (§9 "ההרשאה בדשבורד": the super admin, a company
#: manager and a shop manager) — each within their own shops.
ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER})


class SwitchIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    on: bool
    #: The tills to switch; absent: every till of the shop that is included (§8.2).
    machine_ids: Optional[List[uuid.UUID]] = Field(None, alias="machineIds", max_length=500)


class ControllerIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(..., alias="machineId")
    on: bool


def _forbidden(code: str = "forbidden") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": code, "message": "אין הרשאה"})


def _shop(db: Session, user: User, tenant_id, shop_id: uuid.UUID) -> Shop:
    """The shop, for one of `ROLES` who covers it (the remote control's own shop rule)."""
    from app.services.company_hierarchy import user_covers_shop

    if getattr(user, "role", None) not in ROLES:
        raise _forbidden()
    shop = db.get(Shop, shop_id)
    if shop is None or (tenant_id is not None and str(shop.tenant_id) != str(tenant_id)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "shop_not_found"})
    if user.role == UserRole.SUPER_ADMIN:
        return shop
    if user.role == UserRole.COMPANY_MANAGER and user_covers_shop(db, user, shop):
        return shop
    if user.role == UserRole.SHOP_MANAGER and str(shop.id) == str(user.shop_id):
        return shop
    raise _forbidden()


def _tills(db: Session, user: User, shop: Shop) -> List[POSMachine]:
    """The shop's tills and kiosks this user may control: a manager of some points of sale, theirs only."""
    from app.routers.device_commands import _check_covered, _narrowing

    narrow = _narrowing(db, user)
    out = []
    for m in DCtl.shop_tills(db, shop.id):
        try:
            _check_covered(db, narrow, m)
        except HTTPException:
            continue
        out.append(m)
    return out


def _can_edit(db: Session, user: User) -> bool:
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS

    return DA.effective_access(db, user).allows(DCtl.SECTION, DS.EDIT)


@router.get("/shops/{shop_id}/deferred-terminals")
def get_deferred_terminals(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The shop's tills with their terminal, its mode and the last command; the settings and the controllers."""
    shop = _shop(db, current_user, active_tenant_id, shop_id)
    out = DCtl.shop_view(db, shop, _tills(db, current_user, shop), can_switch=_can_edit(db, current_user))
    db.commit()  # commands past their end settled on the way
    return out


@router.post("/shops/{shop_id}/deferred-terminals/switch")
def post_deferred_switch(
    shop_id: uuid.UUID,
    body: SwitchIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "העבר הכל ללא מקוון" / "החזר הכל למקוון" / one till's switch: one `terminal_offline` per till that is
    included and can take it (one batch, each its own `requestId`), the rest skipped with why. The latest
    wins — a till's open command is cancelled (`superseded`). The tills are woken after the commit.
    """
    shop = _shop(db, current_user, active_tenant_id, shop_id)
    if not _can_edit(db, current_user):
        raise _forbidden("section_forbidden")
    machines = _tills(db, current_user, shop)
    targets, skipped = DCtl.plan_switch(db, shop, machines, machine_ids=body.machine_ids)
    rows = DCtl.create_commands(db, targets, on=body.on, user=current_user) if targets else []
    db.commit()
    if targets:
        DC.wake(targets)
    return {
        "batchId": str(rows[0].batch_id) if rows and rows[0].batch_id else None,
        "on": body.on,
        "created": [{"machineId": str(r.machine_id), "commandId": str(r.id)} for r in rows],
        "skipped": skipped,
    }


@router.put("/shops/{shop_id}/deferred-terminals/controllers")
def put_deferred_controller(
    shop_id: uuid.UUID,
    body: ControllerIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "קופה מנהלת מצב לא מקוון": this till in or out of the shop's own `deferredControlTills` — the list is
    kept at the shop's level, so every till of the shop knows the feature is on. Written with the
    parameters' change log; the shop's tills are told to pull their parameters.
    """
    from app.services import till_parameters as TP

    shop = _shop(db, current_user, active_tenant_id, shop_id)
    if not _can_edit(db, current_user):
        raise _forbidden("section_forbidden")
    machines = _tills(db, current_user, shop)
    machine = next((m for m in machines if m.id == body.machine_id), None)
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "machine_not_found"})
    changed = DCtl.set_controller(db, shop, machine, body.on, user=current_user)
    db.commit()
    if changed:
        TP.publish_parameters_notify(TP.notify_targets_for_scope(db, "shop", shop.id))
    out = DCtl.shop_view(db, shop, machines, can_switch=True)
    db.commit()
    return {**out, "changed": changed}


# ── The device page's card (§10) ─────────────────────────────────────────────


class DeviceValuesIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The till's own values of `deferredAutoOn`, `deferredAutoOnFailures`, `deferredAutoOnSeconds`,
    #: `deferredAutoOnAll` — null clears one (the till inherits again); a key left out is left as it is.
    values: Dict[str, Any] = Field(default_factory=dict)


def _device(db: Session, user: User, tenant_id, machine_id: uuid.UUID) -> POSMachine:
    """A till or kiosk of a shop this user switches (the page's own rule)."""
    machine = db.get(POSMachine, machine_id)
    if machine is None or machine.shop_id is None or (tenant_id is not None and str(machine.tenant_id) != str(tenant_id)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "machine_not_found"})
    shop = _shop(db, user, tenant_id, machine.shop_id)
    if all(m.id != machine.id for m in _tills(db, user, shop)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "machine_not_found"})
    return machine


def _can_edit_device(db: Session, user: User) -> bool:
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS

    access = DA.effective_access(db, user)
    return access.allows("devices", DS.EDIT) or access.allows(DCtl.SECTION, DS.EDIT)


@router.get("/machines/{machine_id}/deferred-settings")
def get_device_deferred_settings(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"מצב לא מקוון" on the device page: "קופה מנהלת" and the till's own auto-on values, with what it inherits."""
    machine = _device(db, current_user, active_tenant_id, machine_id)
    out = DCtl.device_view(
        db, machine, can_edit=_can_edit_device(db, current_user), can_edit_controller=_can_edit(db, current_user),
    )
    db.commit()  # built-in definitions created on the way, if missing
    return out


@router.put("/machines/{machine_id}/deferred-settings")
def put_device_deferred_settings(
    machine_id: uuid.UUID,
    body: DeviceValuesIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The till's own auto-on values (§10), written with the parameters' change log; the till is told."""
    from app.services import till_parameters as TP

    machine = _device(db, current_user, active_tenant_id, machine_id)
    if not _can_edit_device(db, current_user):
        raise _forbidden("section_forbidden")
    try:
        changed = DCtl.set_device_values(db, machine, body.values, user=current_user)
    except TP.TillParameterValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail={"code": "invalid_value", "message": str(exc)}) from exc
    db.commit()
    if changed:
        TP.publish_parameters_notify(TP.notify_targets_for_scope(db, "machine", machine.id))
    out = DCtl.device_view(db, machine, can_edit=True, can_edit_controller=_can_edit(db, current_user))
    return {**out, "changed": changed}


# ── The till ─────────────────────────────────────────────────────────────────


@till_router.get("/{machine_id}/deferred-control")
def till_deferred_control(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """§8.4: whether this till controls, the settings, and the shop's tills with their LAN addresses."""
    return DCtl.control_view(db, machine)


__all__ = ["router", "till_router"]
