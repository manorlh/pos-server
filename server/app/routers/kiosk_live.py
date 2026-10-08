"""
"שליטה מרחוק בקיוסקים" — the live panel's kiosk actions (app/services/kiosk_live.py). Pause /
resume stay `POST /kiosks/{id}/commands` (app/routers/kiosks.py).

Dashboard (sections `kiosks` or `device_control`; the machine admins' scope):

GET    /kiosks/live                     ?companyId=&shopId= → {kiosks: [KioskSummary], hides: [Hide]}
PUT    /kiosks/{machine_id}/banner      {message, duration} → KioskSummary
DELETE /kiosks/{machine_id}/banner      → KioskSummary
POST   /kiosks/live/hides               {shopId, kind, itemId, duration, note?} → Hide
POST   /kiosks/live/hides/{id}/extend   {minutes} → Hide
DELETE /kiosks/live/hides/{id}          → Hide ("הצג שוב")
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.kiosk_live import KioskQuickHide
from app.models.shop import Shop
from app.models.user import User
from app.routers.item_blocks import DurationIn, ExtendIn, _end
from app.services import block_durations
from app.services import kiosk_control
from app.services import kiosk_live as svc

router = APIRouter(prefix="/kiosks", tags=["kiosks"])


class BannerIn(BaseModel):
    message: str = Field(..., min_length=1, max_length=300)
    duration: DurationIn = Field(default_factory=DurationIn)


class HideIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    shop_id: uuid.UUID = Field(..., alias="shopId")
    kind: Literal["product", "category"]
    item_id: uuid.UUID = Field(..., alias="itemId")
    duration: DurationIn = Field(default_factory=DurationIn)
    note: Optional[str] = Field(None, max_length=200)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _wake_shop_kiosks(db: Session, shop_id) -> None:
    """The kiosks pull their config at once (a settings wake-up, as a menu edit does)."""
    from app.models.kiosk import KioskDevice
    from app.services import kiosk_menu

    ids = [r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.shop_id == shop_id).all()]
    try:
        kiosk_menu.wake_kiosks(db.get(Shop, shop_id).tenant_id, [str(i) for i in ids])
    except Exception:  # noqa: BLE001 - their next kiosk sync takes it anyway
        pass


@router.get("/live")
def live_panel(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    kiosks = kiosk_control.list_kiosks(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id)
    shop_ids = {k["shopId"] for k in kiosks if k.get("shopId")}
    if shop_id is not None:
        shop_ids.add(str(shop_id))
    hides = svc.active_hides(db, [uuid.UUID(s) for s in shop_ids])
    db.commit()
    now = _now()
    return {"kiosks": kiosks, "hides": [svc.hide_out(h, now) for h in hides], "serverTime": now.isoformat()}


@router.put("/{machine_id}/banner")
def put_banner(
    machine_id: uuid.UUID,
    body: BannerIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine, device = kiosk_control.kiosk_for_dashboard(db, current_user, machine_id, active_tenant_id)
    now = _now()
    end = _end(db, active_tenant_id, machine.shop_id, body.duration, now)
    svc.set_banner(device, body.message, end.until, kiosk_control.user_name(current_user), now)
    db.commit()
    _wake_shop_kiosks(db, machine.shop_id)
    return kiosk_control.summary(db, device)


@router.delete("/{machine_id}/banner")
def delete_banner(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine, device = kiosk_control.kiosk_for_dashboard(db, current_user, machine_id, active_tenant_id)
    svc.set_banner(device, None, None, None)
    db.commit()
    _wake_shop_kiosks(db, machine.shop_id)
    return kiosk_control.summary(db, device)


def _shop_checked(db: Session, user: User, shop_id, tenant_id) -> Shop:
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    return shop


@router.post("/live/hides", status_code=status.HTTP_201_CREATED)
def create_hide(
    body: HideIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shop = _shop_checked(db, current_user, body.shop_id, active_tenant_id)
    now = _now()
    end = _end(db, active_tenant_id, shop.id, body.duration, now)
    row = svc.hide(
        db, tenant_id=shop.tenant_id, shop_id=shop.id, kind=body.kind, item_id=body.item_id,
        until=end.until, note=body.note, user=current_user, now=now,
    )
    db.commit()
    _wake_shop_kiosks(db, shop.id)
    return {**svc.hide_out(row, now), "rolled": end.rolled}


def _hide_or_404(db: Session, user: User, hide_id: uuid.UUID, tenant_id) -> KioskQuickHide:
    row = db.get(KioskQuickHide, hide_id)
    if row is None or str(row.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="hide_not_found")
    _shop_checked(db, user, row.shop_id, tenant_id)
    return row


@router.post("/live/hides/{hide_id}/extend")
def extend_hide(
    hide_id: uuid.UUID,
    body: ExtendIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    row = _hide_or_404(db, current_user, hide_id, active_tenant_id)
    now = _now()
    try:
        until = row.until if row.until is None or row.until.tzinfo else row.until.replace(tzinfo=timezone.utc)
        row.until = block_durations.extend(until, now, body.minutes)
    except block_durations.DurationRefused as refused:
        raise HTTPException(status_code=422, detail={"code": refused.code, "message": refused.message}) from refused
    row.updated_at = now
    db.commit()
    _wake_shop_kiosks(db, row.shop_id)
    return svc.hide_out(row, now)


@router.delete("/live/hides/{hide_id}")
def delete_hide(
    hide_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    row = _hide_or_404(db, current_user, hide_id, active_tenant_id)
    svc.show(db, row, user=current_user)
    db.commit()
    _wake_shop_kiosks(db, row.shop_id)
    return svc.hide_out(row)
