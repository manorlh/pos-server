"""
"מכשירי תשלום" — a shop's card terminals for tills without one of their own
(app/services/payment_devices.py).

Dashboard (user JWT). Reading: whoever may read the shop; writing: whoever may write the
shop's settings (`_check_shop_settings_write` — the same people as its payment integration):

GET    /shops/{shop_id}/payment-devices    → `{devices, machines, multiPaymentDevices, …}`: the
                                             devices (the secret only as `{set}`), the shop's
                                             non-kiosk tills with `hasBuiltinTerminal` and how
                                             each picks a device now (`choice`), the shop's own
                                             switch / mode / fixed device / group
POST   /shops/{shop_id}/payment-devices    → create (201)
PUT    /payment-devices/{id}               → change the fields sent
DELETE /payment-devices/{id}               → delete (204); every `fixedPaymentDeviceId` and
                                             `paymentDeviceGroup` naming it (shop, areas, tills)
                                             is cleared in the same transaction
GET    /machines/{machine_id}/payment-devices → its shop's devices (none for a kiosk), its
                                             hardware (the till's settings dialog)

Till (machine JWT only):

PUT    /sync/{machine_id}/payment-devices/{device_id}/host → an Agamento LAN handheld of the
                                             till's shop found at a new address (its read-only
                                             sweep) — `relink_device_host`: `config.host` (and
                                             port) only; `{deviceId, host, port, previousHost,
                                             reason, terminalMatches, unchanged}`; refusals as
                                             `PUT /sync/{m}/pinpad-host`: `{detail: code, message}`

Every write moves the shop's settings stamp and tells the shop's tills to pull (Ably
`settings`, reason `payment_devices_updated`). The till's side is in the settings sync
(`paymentDevices`, `paymentDeviceSecrets`, the mode / fixed device / group) and in the SynqPay
pairing (`paymentDeviceId`).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    FISCAL_MACHINE_TOKEN,
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.routers.machines import _machine_for_read
from app.routers.settings import _check_shop_settings_write
from app.routers.shops import _check_shop_access
from app.schemas.payment_devices import PaymentDeviceHostIn, PaymentDeviceIn
from app.services import payment_devices as PD

router = APIRouter(tags=["payment-devices"])


def _shop(db: Session, shop_id: Any, active_tenant_id) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)
    return shop


def _device_and_shop(db: Session, device_id: Any, user: User, active_tenant_id):
    device = PD.get_device(db, device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment device not found")
    shop = _shop(db, device.shop_id, active_tenant_id)
    _check_shop_settings_write(user, shop, db)
    return device, shop


def _can_edit(user: User, shop: Shop, db: Session) -> bool:
    try:
        _check_shop_settings_write(user, shop, db)
    except HTTPException:
        return False
    return True


def _commit(db: Session) -> None:
    """Commit; the unique nickname index answers a race the service's check missed."""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise PD.PaymentDeviceError("nickname_taken", field="nickname", status_code=status.HTTP_409_CONFLICT)


@router.get("/shops/{shop_id}/payment-devices")
def list_payment_devices(
    shop_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    shop = _shop(db, shop_id, active_tenant_id)
    _check_shop_access(current_user, shop, db)
    return PD.dashboard_page(db, shop, can_edit=_can_edit(current_user, shop, db))


@router.post("/shops/{shop_id}/payment-devices", status_code=status.HTTP_201_CREATED)
def create_payment_device(
    shop_id: uuid.UUID,
    body: PaymentDeviceIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    shop = _shop(db, shop_id, active_tenant_id)
    _check_shop_settings_write(current_user, shop, db)
    device = PD.create_device(db, shop, body, user_id=getattr(current_user, "id", None))
    _commit(db)
    PD.notify_shop(db, shop.id)
    db.refresh(device)
    return PD.device_out(db, device)


@router.put("/payment-devices/{device_id}")
def update_payment_device(
    device_id: uuid.UUID,
    body: PaymentDeviceIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    device, shop = _device_and_shop(db, device_id, current_user, active_tenant_id)
    PD.update_device(db, shop, device, body, user_id=getattr(current_user, "id", None))
    _commit(db)
    PD.notify_shop(db, shop.id)
    db.refresh(device)
    return PD.device_out(db, device)


@router.delete("/payment-devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_payment_device(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
) -> Response:
    device, shop = _device_and_shop(db, device_id, current_user, active_tenant_id)
    PD.delete_device(db, shop, device)
    db.commit()
    PD.notify_shop(db, shop.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/machines/{machine_id}/payment-devices")
def machine_payment_devices(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    machine = _machine_for_read(db, machine_id, current_user, active_tenant_id)
    return PD.machine_page(db, machine)


@router.put("/sync/{machine_id}/payment-devices/{device_id}/host", dependencies=FISCAL_MACHINE_TOKEN)
def machine_set_payment_device_host(
    machine_id: str,
    device_id: str,
    body: PaymentDeviceHostIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    An Agamento LAN handheld that moved (DHCP): the till writes the device's new address with its
    machine token alone, as `PUT /sync/{m}/pinpad-host` does for its own pinpad. Only a device of
    its shop, only `agamento_lan`, only a private IPv4 address, and a move the till made by itself
    only to the same terminal. Audited as the till event `payment_device_host_set`.
    `404 payment_device_not_found` · `409 payment_device_not_agamento_lan | payment_device_kiosk |
    terminal_mismatch` · `422 host_invalid | host_not_private | port_invalid | reason_invalid |
    terminal_number_required`, each `{detail: code, message}`.
    """
    if not machine.shop_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Machine must be assigned to a shop")
    try:
        out = PD.relink_device_host(
            db, machine, device_id,
            host=body.host, port=body.port, reason=body.reason or "relocated",
            terminal_number=body.terminal_number, serial=body.serial,
            previous_host=body.previous_host, mac=body.mac,
        )
    except PD.DeviceRelinkRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content={"detail": refused.code, "message": refused.message})
    db.commit()
    if not out["unchanged"]:
        PD.notify_shop(db, machine.shop_id)
    return out
