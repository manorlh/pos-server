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

Every write moves the shop's settings stamp and tells the shop's tills to pull (Ably
`settings`, reason `payment_devices_updated`). The till's side is in the settings sync
(`paymentDevices`, `paymentDeviceSecrets`) and in the SynqPay pairing (`paymentDeviceId`).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.shop import Shop
from app.models.user import User
from app.routers.machines import _machine_for_read
from app.routers.settings import _check_shop_settings_write
from app.routers.shops import _check_shop_access
from app.schemas.payment_devices import PaymentDeviceIn
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
