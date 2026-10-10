"""
"מסך לקוח" (app/services/customer_display.py, P:/specs/customer-display.md).

The dashboard:
  GET  /customer-display/settings/{level}/{entity_id}   a layer: its own fields, what it inherits
  PUT  /customer-display/settings/{level}/{entity_id}   {"settings": {...} | null}
  GET  /customer-display/displays?shopId=               the shop's customer displays and its tills
  PUT  /customer-display/displays/{machine_id}/till      {"tillMachineId": "…" | null}

The devices (machine token):
  GET  /sync/{m}/customer-display                        the resolved configuration (ETag / 304)
  PUT  /sync/{m}/customer-display/state                  a till's screen state, to the relay
  GET  /sync/{m}/customer-display/state?after=           a display's till's state (204: nothing newer)
  PUT  /sync/{m}/customer-display/lan                    where the till's LAN server listens
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    FISCAL_SYNC_PATH,
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_machine_admin,
    get_current_user,
    get_pos_machine_for_sync_path,
)
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.services import customer_display as CD

logger = logging.getLogger(__name__)

router = APIRouter(tags=["customer-display"])
till_router = APIRouter(prefix="/sync", tags=["customer-display"])

NOTIFY_REASON = "customer_display_updated"


def _refuse(exc: CD.CustomerDisplayError, code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=code, detail=exc.body())


def _shop(db: Session, shop_id: Any, active_tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    return shop


def _company_of(db: Session, shop: Optional[Shop]) -> Optional[Company]:
    return db.query(Company).filter(Company.id == shop.company_id).first() if shop is not None else None


def _entity_and_parents(db: Session, level: str, entity_id: str, user: User, active_tenant_id, *, write: bool):
    """The entity a level names, checked for the caller, and its parents least specific first."""
    from app.routers import settings as S
    from app.routers.companies import _check_company_access
    from app.routers.shops import _check_shop_access
    from app.services.areas import get_area

    if level == "company":
        company = db.query(Company).filter(Company.id == entity_id).first()
        if company is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        ensure_same_tenant(company.tenant_id, active_tenant_id)
        _check_company_access(user, company, db)
        if write:
            S._check_company_settings_write(user, company, db)
        return company, []
    if level == "shop":
        shop = _shop(db, entity_id, active_tenant_id)
        _check_shop_access(user, shop, db)
        if write:
            S._check_shop_settings_write(user, shop, db)
        return shop, [("company", _company_of(db, shop))]
    if level == "area":
        area = get_area(db, entity_id)
        if area is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Area not found")
        ensure_same_tenant(area.tenant_id, active_tenant_id)
        shop = _shop(db, area.shop_id, active_tenant_id)
        _check_shop_access(user, shop, db)
        if write:
            S._check_shop_settings_write(user, shop, db)
        return area, [("company", _company_of(db, shop)), ("shop", shop)]
    if level == "machine":
        if write:
            user = get_current_machine_admin(user)
        machine = S._machine_for_read(db, entity_id, user, active_tenant_id)
        area, shop, company, _tenant = S._machine_parents(db, machine)
        return machine, [("company", company), ("shop", shop), ("area", area)]
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown level")


def _notify(db: Session, level: str, entity: Any) -> None:
    """The devices a layer reaches pull their configuration again (the settings notify)."""
    from app.services import settings_notify as N

    try:
        if level == "company":
            N.notify_machines_for_company_settings(db, str(entity.id), reason=NOTIFY_REASON)
        elif level == "shop":
            N.notify_machines_for_shop_settings(db, str(entity.id), reason=NOTIFY_REASON)
        elif level == "area":
            N.notify_machines_for_area_settings(db, str(entity.id), reason=NOTIFY_REASON)
        else:
            N.notify_machine_settings(db, entity, reason=NOTIFY_REASON)
    except Exception as exc:  # noqa: BLE001 - a notify never fails a saved write; devices poll anyway
        logger.warning("customer display notify failed: %s", exc)


# ── The dashboard ────────────────────────────────────────────────────────────


@router.get("/customer-display/settings/{level}/{entity_id}")
def get_layer(
    level: str,
    entity_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    entity, parents = _entity_and_parents(db, level, entity_id, current_user, active_tenant_id, write=False)
    return CD.layer_view(level, entity, parents)


@router.put("/customer-display/settings/{level}/{entity_id}")
def put_layer(
    level: str,
    entity_id: str,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Replace the layer's `customerDisplay` with `settings` (only the fields this layer sets; the
    rest inherit). `null` / {} clears the layer. A display device's mirrored till is checked:
    an active till of its own shop.
    """
    entity, parents = _entity_and_parents(db, level, entity_id, current_user, active_tenant_id, write=True)
    try:
        layer = CD.clean_layer(body.get("settings") if isinstance(body, dict) else None, level=level)
        if layer and layer.get(CD.MIRROR_KEY):
            CD.check_till_for_display(db, getattr(entity, "shop_id", None), layer[CD.MIRROR_KEY])
    except CD.CustomerDisplayError as exc:
        raise _refuse(exc)
    before_till = CD.mirrored_till_id(entity) if level == "machine" else None
    CD.write_layer(entity, level, layer)
    db.commit()
    db.refresh(entity)
    _notify(db, level, entity)
    if level == "machine" and CD.is_display_device(entity):
        _notify_tills(db, {before_till, CD.mirrored_till_id(entity)})
    return CD.layer_view(level, entity, parents)


def _notify_tills(db: Session, till_ids) -> None:
    """A display was bound or unbound: its tills start or stop serving it."""
    from app.services import settings_notify as N

    for tid in {t for t in till_ids if t}:
        till = db.get(POSMachine, uuid.UUID(str(tid)))
        if till is not None:
            try:
                N.notify_machine_settings(db, till, reason=NOTIFY_REASON)
            except Exception as exc:  # noqa: BLE001
                logger.warning("customer display notify failed: %s", exc)


@router.get("/customer-display/displays")
def list_displays(
    shop_id: str = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The shop's customer displays, each with the till it mirrors, and the tills to choose from."""
    from app.routers.shops import _check_shop_access

    shop = _shop(db, shop_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    tills = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True), POSMachine.is_fiscal.is_(True))
        .all()
    )
    by_id = {str(t.id): t for t in tills}
    displays = CD.displays_of_shop(db, shop.id)
    return {
        "shopId": str(shop.id),
        "displays": [CD.display_row(db, d, by_id) for d in sorted(displays, key=lambda m: m.name or "")],
        "tills": [
            {"machineId": str(t.id), "name": CD.machine_label(t)}
            for t in sorted(tills, key=lambda m: (int(m.pos_number) if (m.pos_number or "").isdigit() else 0, m.name or ""))
        ],
    }


@router.put("/customer-display/displays/{machine_id}/till")
def bind_display(
    machine_id: str,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Which till a paired customer display mirrors (`null`: none — it shows the idle screen)."""
    display, parents = _entity_and_parents(db, "machine", machine_id, current_user, active_tenant_id, write=True)
    if not CD.is_display_device(display):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_a_customer_display", "message": "המכשיר אינו מסך לקוח מצומד."},
        )
    till_id = body.get("tillMachineId") if isinstance(body, dict) else None
    try:
        if till_id:
            till = CD.check_till_for_display(db, display.shop_id, till_id)
            till_id = str(till.id)
    except CD.CustomerDisplayError as exc:
        raise _refuse(exc)
    before = CD.mirrored_till_id(display)
    layer = CD.layer_of(display.settings)
    layer.pop(CD.DEVICE_FLAG, None)
    if till_id:
        layer[CD.MIRROR_KEY] = till_id
    else:
        layer.pop(CD.MIRROR_KEY, None)
    # write_layer keeps the device flag; an explicit unbind must not be refilled from the old value.
    settings = dict(display.settings or {})
    settings[CD.SETTINGS_KEY] = {**layer, CD.DEVICE_FLAG: True}
    display.settings = settings
    from app.services.settings_merge import utc_now

    display.settings_updated_at = utc_now()
    db.commit()
    db.refresh(display)
    _notify(db, "machine", display)
    _notify_tills(db, {before, till_id})
    tills = {till_id: db.get(POSMachine, uuid.UUID(till_id))} if till_id else {}
    return CD.display_row(db, display, tills)


# ── The devices ──────────────────────────────────────────────────────────────


@till_router.get("/{machine_id}/customer-display")
def get_device_config(
    machine_id: str,
    request: Request,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    This device's customer display: the resolved settings, the shop's branding, the media to
    keep on its disk, and its part (a till: its LAN token and whether a paired display mirrors
    it; a display: the till it mirrors and where). A bare 304 when it holds the same (ETag).
    """
    payload = CD.device_payload(db, machine)
    etag = CD.etag_of(payload)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    return JSONResponse(content=json.loads(json.dumps(payload, default=str)), headers={"ETag": etag})


@till_router.put("/{machine_id}/customer-display/state", dependencies=FISCAL_SYNC_PATH)
def put_till_state(
    machine_id: str,
    body: Dict[str, Any] = Body(...),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """The till's screen state for its paired displays that read through the cloud: `{"state": {...}}`."""
    try:
        seq = CD.put_state(db, machine, body.get("state") if isinstance(body, dict) else None)
    except CD.CustomerDisplayError as exc:
        raise _refuse(exc)
    db.commit()
    return {"seq": seq}


@till_router.get("/{machine_id}/customer-display/state")
def get_display_state(
    machine_id: str,
    after: Optional[int] = Query(None, ge=-1),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    A paired display's view of its till: `{seq, state, updatedAt, stale}`, or 204 when there is
    nothing newer than `after`. Only for a customer-display device; a display bound to no till
    reads idle.
    """
    if not CD.is_display_device(machine):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_a_customer_display", "message": "המכשיר אינו מסך לקוח מצומד."},
        )
    till_id = CD.mirrored_till_id(machine)
    if till_id:
        try:
            CD.check_till_for_display(db, machine.shop_id, till_id)
        except CD.CustomerDisplayError:
            till_id = None
    if not till_id:
        if after is not None and after >= 0:
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        return {"seq": 0, "state": CD.idle_state(), "updatedAt": None, "stale": True}
    out = CD.get_state(db, till_id, after)
    if out is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return out


@till_router.put("/{machine_id}/customer-display/lan", dependencies=FISCAL_SYNC_PATH)
def put_till_lan(
    machine_id: str,
    body: Dict[str, Any] = Body(...),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """Where the till's LAN server listens, for its paired displays (`kitchen_print_hosts`, as the print server's)."""
    from app.models.printers import DEFAULT_LAN_PORT
    from app.services.printers import report_print_host

    address = body.get("lanAddress") if isinstance(body, dict) else None
    port = body.get("port") if isinstance(body, dict) else None
    if address is not None and (not isinstance(address, str) or len(address) > 64 or not address.strip()):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="lanAddress")
    if port is None:
        port = DEFAULT_LAN_PORT
    if isinstance(port, bool) or not isinstance(port, int) or not (1 <= port <= 65535):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="port")
    out = report_print_host(db, machine, address.strip() if address else None, port)
    db.commit()
    return out
