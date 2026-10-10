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

A "Hide" is a block (app/services/sold_out.py, specs/item-blocks-targets.md): the list holds every
hand block in force of the shop that reaches its kiosks, a new hide is a shop-level kiosks-only
"חסום" that hides, and extend / remove act on any of them by its id.
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
from app.models.sold_out import SoldOutMark
from app.models.shop import Shop
from app.models.user import User
from app.routers.item_blocks import DurationIn, ExtendIn, _end
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

    ids = [r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.shop_id == shop_id).all()]
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
    narrow = _narrowing(db, current_user)
    if narrow is not None:
        kiosks = [k for k in kiosks if _machine_covered(db, narrow, k.get("machineId"))]
    shop_ids = {k["shopId"] for k in kiosks if k.get("shopId")}
    if shop_id is not None:
        # A shop with no kiosk yet still shows its quick hides — once the user is known to reach it.
        shop = db.get(Shop, shop_id)
        if shop is None:
            raise HTTPException(status_code=404, detail="Shop not found")
        kiosk_control.check_shop_scope(db, current_user, shop, active_tenant_id)
        shop_ids.add(str(shop_id))
    now = _now()
    hides = svc.active_hides(db, [uuid.UUID(s) for s in shop_ids], now)
    if narrow is not None:
        from app.routers.item_blocks import _covers

        hides = [h for h in hides if _covers(db, narrow, h.scope, h.scope_id)]
    out = svc.hides_out(db, hides, now)
    db.commit()
    return {"kiosks": kiosks, "hides": out, "serverTime": now.isoformat()}


@router.put("/{machine_id}/banner")
def put_banner(
    machine_id: uuid.UUID,
    body: BannerIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine, device = _kiosk_checked(db, current_user, machine_id, active_tenant_id)
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
    machine, device = _kiosk_checked(db, current_user, machine_id, active_tenant_id)
    svc.set_banner(device, None, None, None)
    db.commit()
    _wake_shop_kiosks(db, machine.shop_id)
    return kiosk_control.summary(db, device)


def _narrowing(db: Session, user: User):
    """A manager of points of sale's areas / devices (app/services/stock_scope.py), or None."""
    from app.services import stock_scope

    scope = stock_scope.scope_of(db, user)
    return scope if scope.narrowed else None


def _machine_covered(db: Session, narrow, machine_id) -> bool:
    from app.models.pos_machine import POSMachine
    from app.services import stock_locations as SL

    machine = db.get(POSMachine, uuid.UUID(str(machine_id))) if machine_id else None
    return machine is not None and narrow.covers_path(SL.path_of_machine(db, machine))


def _kiosk_checked(db: Session, user: User, machine_id, tenant_id):
    """The kiosk, in the user's scope — a manager of points of sale: one of their devices."""
    machine, device = kiosk_control.kiosk_for_dashboard(db, user, machine_id, tenant_id)
    narrow = _narrowing(db, user)
    if narrow is not None and not _machine_covered(db, narrow, machine.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")
    return machine, device


def _shop_checked(db: Session, user: User, shop_id, tenant_id) -> Shop:
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    # A quick hide is shop-wide (every kiosk of the shop): not a manager of points of sale's.
    if _narrowing(db, user) is not None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")
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
    return {**svc.hide_out(db, row, now), "rolled": end.rolled}


def _hide_or_404(db: Session, user: User, hide_id: uuid.UUID, tenant_id) -> SoldOutMark:
    """A block of a shop, in the user's scope (a manager of points of sale: one of theirs)."""
    from app.routers.item_blocks import _check_mark

    row = db.get(SoldOutMark, hide_id)
    if row is None or str(row.tenant_id) != str(tenant_id) or row.shop_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="hide_not_found")
    _check_mark(db, user, row, tenant_id)
    return row


@router.post("/live/hides/{hide_id}/extend")
def extend_hide(
    hide_id: uuid.UUID,
    body: ExtendIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services import sold_out

    row = _hide_or_404(db, current_user, hide_id, active_tenant_id)
    now = _now()
    sold_out.extend(db, row, body.minutes, now=now)
    db.commit()
    _wake_shop_kiosks(db, row.shop_id)
    return svc.hide_out(db, row, now)


@router.delete("/live/hides/{hide_id}")
def delete_hide(
    hide_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    row = _hide_or_404(db, current_user, hide_id, active_tenant_id)
    now = _now()
    svc.show(db, row, user=current_user, now=now)
    db.commit()
    _wake_shop_kiosks(db, row.shop_id)
    return svc.hide_out(db, row, now)
