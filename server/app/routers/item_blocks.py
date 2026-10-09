"""
"חסימות ואזל" — blocks on a product for a scope, for a while (app/services/sold_out.py).

Dashboard (section `item_blocks`: view for reads, edit for writes; the roles and org scope of the
machine admins — a super admin, a distributor, a company manager over their companies' shops, a
shop manager over their shop — app/services/kiosk_control.py `check_*_scope`):

GET    /item-blocks                ?companyId=&shopId=&productId=&includeEnded= → [Block]
GET    /item-blocks/targets        ?shopId= → what the scope picker offers
POST   /item-blocks/end-preview    {mode, minutes?, at?, shopId?} → {until, rolled}
POST   /item-blocks                {productId, kind, note?, targets: [{scope, scopeId}], duration} → [Block]
POST   /item-blocks/{id}/extend    {minutes} → Block
DELETE /item-blocks/{id}           → Block ("בטל עכשיו")
POST   /item-blocks/clear          {productId, shopId?, companyId?} → {cleared} (every block of the product)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.company import Company
from app.models.kiosk import KioskDevice
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.report_event import ReportEvent
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.sold_out import SoldOutMark
from app.models.user import User, UserRole
from app.services import block_durations, device_groups
from app.services import kiosk_control
from app.services import sold_out as svc
from app.services.company_hierarchy import visible_shop_ids

router = APIRouter(prefix="/item-blocks", tags=["item-blocks"])


class TargetIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    scope: Literal["company", "shop", "kiosks", "area", "group", "event", "machine", "kiosk"]
    scope_id: uuid.UUID = Field(..., alias="scopeId")


class DurationIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    mode: Literal["none", "minutes", "time", "end_of_day"] = "none"
    minutes: Optional[int] = None
    at: Optional[str] = None


class BlockIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    kind: Literal["sold_out", "blocked"] = "sold_out"
    note: Optional[str] = Field(None, max_length=200)
    targets: List[TargetIn] = Field(..., min_length=1, max_length=200)
    duration: DurationIn = Field(default_factory=DurationIn)


class EndPreviewIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    mode: Literal["none", "minutes", "time", "end_of_day"] = "none"
    minutes: Optional[int] = None
    at: Optional[str] = None
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")


class ExtendIn(BaseModel):
    minutes: int = Field(..., ge=1, le=block_durations.MAX_MINUTES)


class ClearIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _shops_in_view(db: Session, user: User, tenant_id, *, company_id=None, shop_id=None) -> List[Any]:
    """The shops whose blocks this user may see, narrowed to a company or a shop."""
    kiosk_control.require_kiosk_role(user)
    q = db.query(Shop.id, Shop.company_id).filter(Shop.tenant_id == tenant_id)
    if company_id is not None:
        q = q.filter(Shop.company_id == company_id)
    if shop_id is not None:
        q = q.filter(Shop.id == shop_id)
    rows = q.all()
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return [r[0] for r in rows]
    if user.role == UserRole.COMPANY_MANAGER:
        allowed = {str(s) for s in visible_shop_ids(db, user)}
        return [r[0] for r in rows if str(r[0]) in allowed]
    return [r[0] for r in rows if str(r[0]) == str(user.shop_id)]


def _check_target(db: Session, user: User, target: svc.Target, tenant_id) -> None:
    """
    The machine admins' scope rules: a company needs the company, anything else its shop; a manager
    of points of sale (app/services/stock_scope.py) only their areas and the devices in them — never
    a whole shop, the shop's kiosks, an event or the company.
    """
    from app.services import stock_locations as SL
    from app.services import stock_scope

    narrowed = stock_scope.scope_of(db, user)
    if target.scope == "company":
        company = db.get(Company, target.scope_id)
        kiosk_control.check_company_scope(db, user, company, tenant_id)
        if narrowed.narrowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")
        return
    shop = db.get(Shop, target.shop_id) if target.shop_id is not None else None
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, user, shop, tenant_id)
    if narrowed.narrowed:
        level = {"area": "area", "machine": "machine", "kiosk": "machine"}.get(target.scope)
        if level is None or not narrowed.covers_path(SL.path_of(db, level, target.scope_id)):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="outside_your_points_of_sale")


def _check_mark(db: Session, user: User, mark: SoldOutMark, tenant_id) -> None:
    if str(mark.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="block_not_found")
    target = svc.Target(mark.scope, mark.scope_id, "", mark.company_id, mark.shop_id)
    _check_target(db, user, target, tenant_id)


def _zone_and_day_start(db: Session, tenant_id, shop_id) -> tuple:
    from app.services.reports import resolve_report_timezone
    from app.services.settings_merge import merge_all_settings_layers
    from app.models.tenant import Tenant
    from types import SimpleNamespace

    zone = resolve_report_timezone(db, tenant_id, None)
    day_start = None
    shop = db.get(Shop, shop_id) if shop_id is not None else None
    if shop is not None:
        company = db.get(Company, shop.company_id) if shop.company_id else None
        tenant = db.get(Tenant, shop.tenant_id) if shop.tenant_id else None
        merged = merge_all_settings_layers(company or SimpleNamespace(settings={}), shop, tenant)
        day_start = merged.get(block_durations.SETTING_DAY_START)
    return zone, day_start


def _end(db: Session, tenant_id, shop_id, duration, now: datetime) -> block_durations.End:
    zone, day_start = _zone_and_day_start(db, tenant_id, shop_id)
    try:
        return block_durations.compute_end(
            duration.mode, now, zone_name=zone, minutes=duration.minutes, at=duration.at, day_start=day_start,
        )
    except block_durations.DurationRefused as refused:
        raise HTTPException(status_code=422, detail={"code": refused.code, "message": refused.message}) from refused


def _view(db: Session, marks: List[SoldOutMark], now: datetime) -> List[dict]:
    names = svc._scope_names(db, marks)
    pids = list({m.product_id for m in marks})
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(pids)).all()} if pids else {}
    sids = list({m.shop_id for m in marks if m.shop_id})
    shops = {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(sids)).all()} if sids else {}
    return [svc.mark_view(m, product=products.get(m.product_id), names=names, shops=shops, now=now) for m in marks]


@router.get("")
def list_blocks(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    product_id: Optional[uuid.UUID] = Query(None, alias="productId"),
    include_ended: bool = Query(False, alias="includeEnded"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shops = _shops_in_view(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id)
    companies = None
    if shop_id is None:
        rows = db.query(Shop.company_id).filter(Shop.id.in_(shops)).distinct().all() if shops else []
        companies = [r[0] for r in rows if r[0] is not None]
    else:
        shop = db.get(Shop, shop_id)
        companies = [shop.company_id] if shop is not None and shop.company_id else []
    return svc.list_blocks(
        db, tenant_id=active_tenant_id, shop_ids=shops, company_ids=companies, product_id=product_id,
        include_ended=include_ended,
    )


@router.get("/targets")
def list_targets(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What the scope picker offers for one shop: its company, the shop, its kiosks, areas, tills, events, groups."""
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    kiosk_control.check_shop_scope(db, current_user, shop, active_tenant_id)
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )
    machines = [m for m in machines if getattr(m, "is_fiscal", True) is not False]
    kiosk_ids = {
        r[0] for r in db.query(KioskDevice.machine_id)
        .filter(KioskDevice.machine_id.in_([m.id for m in machines]), KioskDevice.enabled.is_(True)).all()
    } if machines else set()
    areas = (
        db.query(ShopArea)
        .filter(ShopArea.shop_id == shop.id, ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
    )
    events = (
        db.query(ReportEvent)
        .filter(ReportEvent.shop_id == shop.id, ReportEvent.status != "confirmed", ReportEvent.ends_at > _now())
        .order_by(ReportEvent.starts_at)
        .all()
    )
    company = db.get(Company, shop.company_id) if shop.company_id else None
    company_ok = False
    if company is not None:
        try:
            kiosk_control.check_company_scope(db, current_user, company, active_tenant_id)
            company_ok = True
        except HTTPException:
            company_ok = False
    zone, day_start = _zone_and_day_start(db, active_tenant_id, shop.id)
    return {
        "company": {"id": str(company.id), "name": company.name} if company is not None and company_ok else None,
        "shop": {"id": str(shop.id), "name": shop.name},
        "areas": [{"id": str(a.id), "name": a.name} for a in areas],
        "tills": [
            {"id": str(m.id), "name": m.name, "posNumber": m.pos_number, "areaId": str(m.area_id) if m.area_id else None}
            for m in machines if m.id not in kiosk_ids
        ],
        "kiosks": [
            {"id": str(m.id), "name": m.name, "posNumber": m.pos_number, "areaId": str(m.area_id) if m.area_id else None}
            for m in machines if m.id in kiosk_ids
        ],
        "events": [
            {"id": str(e.id), "name": e.name, "startsAt": e.starts_at.isoformat(), "endsAt": e.ends_at.isoformat()}
            for e in events
        ],
        "groupsAvailable": device_groups.available(),
        "groups": [],
        "timezone": zone,
        "businessDayStart": day_start or block_durations.DEFAULT_DAY_START,
        "presets": list(block_durations.PRESET_MINUTES),
        "extendBy": list(block_durations.EXTEND_MINUTES),
    }


@router.post("/end-preview")
def end_preview(
    body: EndPreviewIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"חסום עד 14:35": the end the dialog's choice gives, in the shop's zone (a passed "עד שעה" rolls)."""
    kiosk_control.require_kiosk_role(current_user)
    end = _end(db, active_tenant_id, body.shop_id, body, _now())
    return {"until": end.until.isoformat() if end.until else None, "rolled": end.rolled, "mode": end.mode}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_blocks(
    body: BlockIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """One block per target (same product, kind, end and reason). All or nothing."""
    now = _now()
    product = svc.global_product(db, body.product_id, active_tenant_id)
    targets = []
    for t in body.targets:
        target = svc.resolve_target(db, t.scope, t.scope_id, active_tenant_id)
        _check_target(db, current_user, target, active_tenant_id)
        targets.append(target)
    first_shop = next((t.shop_id for t in targets if t.shop_id is not None), None)
    end = _end(db, active_tenant_id, first_shop, body.duration, now)
    rows = [
        svc.block(
            db, tenant_id=active_tenant_id, product=product, target=target, kind=body.kind,
            until=end.until, until_mode=end.mode, note=body.note, user=current_user, now=now,
        )
        for target in targets
    ]
    db.commit()
    out = _view(db, rows, now)
    return {"blocks": out, "until": end.until.isoformat() if end.until else None, "rolled": end.rolled}


@router.post("/clear")
def clear_product_blocks(
    body: ClearIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Every block in force of the product in the shops (and companies) this user may manage."""
    now = _now()
    product = svc.global_product(db, body.product_id, active_tenant_id)
    shops = _shops_in_view(db, current_user, active_tenant_id, company_id=body.company_id, shop_id=body.shop_id)
    marks = (
        db.query(SoldOutMark)
        .filter(SoldOutMark.product_id == product.id, SoldOutMark.tenant_id == active_tenant_id, svc.in_force_filter(now))
        .all()
    )
    cleared = []
    for mark in marks:
        if mark.shop_id is not None and mark.shop_id not in shops:
            continue
        try:
            _check_mark(db, current_user, mark, active_tenant_id)
        except HTTPException:
            continue
        if mark.shop_id is None and body.shop_id is not None:
            continue
        svc.clear(db, mark, user=current_user, now=now)
        cleared.append(mark)
    db.commit()
    return {"cleared": len(cleared), "blocks": _view(db, cleared, now)}


def _mark_or_404(db: Session, block_id: uuid.UUID) -> SoldOutMark:
    mark = db.get(SoldOutMark, block_id)
    if mark is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="block_not_found")
    return mark


@router.post("/{block_id}/extend")
def extend_block(
    block_id: uuid.UUID,
    body: ExtendIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    now = _now()
    mark = _mark_or_404(db, block_id)
    _check_mark(db, current_user, mark, active_tenant_id)
    svc.extend(db, mark, body.minutes, now=now)
    db.commit()
    return _view(db, [mark], now)[0]


@router.delete("/{block_id}")
def clear_block(
    block_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    now = _now()
    mark = _mark_or_404(db, block_id)
    _check_mark(db, current_user, mark, active_tenant_id)
    svc.clear(db, mark, user=current_user, now=now)
    db.commit()
    return _view(db, [mark], now)[0]
