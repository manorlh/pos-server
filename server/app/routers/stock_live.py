"""
Stock over the hierarchy (app/services/stock_locations.py, stock_admin.py, stock_alerts.py,
stock_reset.py) — the dashboard's quick stock screen, transfers, "אופן ניהול מלאי" with its wizard,
low-stock alerts, the opening stock and the daily reset.

Section `stock` (view for reads, edit for writes); the machine admins' roles and org scope, narrowed
by a profile's points of sale / devices (app/services/stock_scope.py). A node is `level` + `targetId`
(company · shop · area · machine).

GET  /stock/tree                 ?level=&targetId=           the picker under a node
GET  /stock/quick                ?level=&targetId=&categoryId=&q=
POST /stock/update               {level, targetId, productId, op, quantity, note?}
POST /stock/transfer             {productId, from:{level,targetId}, to:{level,targetId}, quantity, note?}
GET  /stock/movements            ?productId=&level=&targetId=
GET  /stock/settings             ?scopeLevel=&scopeId=       the managed-level rules
POST /stock/settings/preview     {scopeLevel, scopeId, itemKind?, itemId?, levels}
POST /stock/settings/apply       {... levels, openings[], transfers[], writeOff?, openingsConfirmed?}
GET  /stock/alerts               ?companyId=&shopId=
PUT  /stock/opening              {level, targetId, items:[{productId, openingQuantity?, dailyReset?, resetMode?}]}
POST /stock/reset                {level, targetId}            "בצע איפוס עכשיו"
GET  /stock/resets               ?companyId=&shopId=
GET  /stock/leftover             ?companyId=&shopId=&day=
"""
from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.company import Company
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import stock as stock_service
from app.services import stock_admin as svc
from app.services import stock_alerts
from app.services import stock_locations as L
from app.services import stock_reset
from app.services import stock_scope
from app.services.company_hierarchy import visible_shop_ids
from app.services.stock_locations import Location

router = APIRouter(prefix="/stock", tags=["stock"])

Level = Literal["company", "shop", "area", "machine", "group"]


class NodeIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    level: Level
    target_id: uuid.UUID = Field(..., alias="targetId")


class UpdateIn(NodeIn):
    product_id: uuid.UUID = Field(..., alias="productId")
    op: Literal["add", "remove", "count", "receive", "wastage"]
    quantity: Decimal
    note: Optional[str] = Field(None, max_length=300)


class TransferIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    source: NodeIn = Field(..., alias="from")
    target: NodeIn = Field(..., alias="to")
    quantity: Decimal = Field(..., gt=0)
    note: Optional[str] = Field(None, max_length=300)


class SettingIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    scope_level: Literal["company", "shop"] = Field(..., alias="scopeLevel")
    scope_id: uuid.UUID = Field(..., alias="scopeId")
    item_kind: Optional[Literal["category", "product"]] = Field(None, alias="itemKind")
    item_id: Optional[uuid.UUID] = Field(None, alias="itemId")
    levels: List[Level] = Field(..., min_length=1)


class ApplyIn(SettingIn):
    openings: List[Dict[str, Any]] = Field(default_factory=list)
    transfers: List[Dict[str, Any]] = Field(default_factory=list)
    write_off: bool = Field(False, alias="writeOff")
    openings_confirmed: bool = Field(False, alias="openingsConfirmed")


class OpeningIn(NodeIn):
    items: List[Dict[str, Any]] = Field(..., min_length=1, max_length=2000)


def _path(db: Session, user: User, tenant_id, level: str, target_id) -> L.Path:
    try:
        path = L.path_of(db, level, target_id)
    except LookupError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="location_not_found")
    stock_scope.check_path(db, user, path, tenant_id)
    return path


def _require_writer(user: User) -> None:
    if not stock_scope.is_writer(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _shops_and_companies(db: Session, user: User, tenant_id, company_id=None, shop_id=None):
    from app.services import kiosk_control

    kiosk_control.require_kiosk_role(user)
    q = db.query(Shop).filter(Shop.tenant_id == tenant_id)
    if company_id is not None:
        q = q.filter(Shop.company_id == company_id)
    if shop_id is not None:
        q = q.filter(Shop.id == shop_id)
    shops = q.all()
    if user.role == UserRole.COMPANY_MANAGER:
        allowed = {str(s) for s in visible_shop_ids(db, user)}
        shops = [s for s in shops if str(s.id) in allowed]
    elif user.role == UserRole.SHOP_MANAGER:
        shops = [s for s in shops if str(s.id) == str(user.shop_id)]
    companies = {s.company_id for s in shops if s.company_id}
    return shops, companies


@router.get("/tree")
def get_tree(
    level: Level = Query(...),
    target_id: uuid.UUID = Query(..., alias="targetId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    try:
        path = L.path_of(db, level, target_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="location_not_found")
    svc._check_org(db, current_user, path, active_tenant_id)
    return svc.tree(db, current_user, active_tenant_id, path)


@router.get("/quick")
def get_quick(
    level: Level = Query(...),
    target_id: uuid.UUID = Query(..., alias="targetId"),
    category_id: Optional[uuid.UUID] = Query(None, alias="categoryId"),
    q: Optional[str] = Query(None, max_length=100),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    path = _path(db, current_user, active_tenant_id, level, target_id)
    return svc.quick_view(db, current_user, active_tenant_id, path, category_id=category_id, q=q)


@router.post("/update")
def post_update(
    body: UpdateIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_writer(current_user)
    path = _path(db, current_user, active_tenant_id, body.level, body.target_id)
    out = svc.update(
        db, current_user, active_tenant_id, path, product_id=body.product_id, op=body.op,
        quantity=body.quantity, note=body.note,
    )
    db.commit()
    return out


@router.post("/transfer")
def post_transfer(
    body: TransferIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_writer(current_user)
    out = svc.transfer(
        db, current_user, active_tenant_id, product_id=body.product_id,
        source=Location(body.source.level, body.source.target_id),
        target=Location(body.target.level, body.target.target_id), quantity=body.quantity, note=body.note,
    )
    db.commit()
    return out


@router.get("/movements")
def get_movements(
    product_id: uuid.UUID = Query(..., alias="productId"),
    level: Level = Query(...),
    target_id: uuid.UUID = Query(..., alias="targetId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    path = _path(db, current_user, active_tenant_id, level, target_id)
    shops = svc.shops_under(db, path)
    scope = stock_scope.scope_of(db, current_user)
    locations = [loc for loc, p in svc._locations_under(db, path, shops) if scope.covers_path(p)]
    return stock_service.movements_for(db, product_id, locations=locations)


def _check_setting_scope(db: Session, user: User, tenant_id, scope_level: str, scope_id) -> None:
    path = L.path_of(db, scope_level, scope_id)
    svc._check_org(db, user, path, tenant_id)
    if stock_scope.scope_of(db, user).narrowed:
        raise HTTPException(status_code=403, detail="outside_your_points_of_sale")


@router.get("/settings")
def get_settings(
    scope_level: Literal["company", "shop"] = Query(..., alias="scopeLevel"),
    scope_id: uuid.UUID = Query(..., alias="scopeId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    try:
        _check_setting_scope(db, current_user, active_tenant_id, scope_level, scope_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="scope_not_found")
    out = svc.rules_view(db, scope_level, scope_id)
    if scope_level == "shop":
        shop = db.get(Shop, scope_id)
        out["inherited"] = svc.rules_view(db, "company", shop.company_id) if shop and shop.company_id else None
    return out


@router.post("/settings/preview")
def post_settings_preview(
    body: SettingIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _check_setting_scope(db, current_user, active_tenant_id, body.scope_level, body.scope_id)
    try:
        return svc.preview_switch(
            db, scope_level=body.scope_level, scope_id=body.scope_id, item_kind=body.item_kind,
            item_id=body.item_id, levels=body.levels,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"code": str(e), "message": "בחירת רמות לא תקינה"})


@router.post("/settings/apply")
def post_settings_apply(
    body: ApplyIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_writer(current_user)
    _check_setting_scope(db, current_user, active_tenant_id, body.scope_level, body.scope_id)
    try:
        out = svc.apply_switch(
            db, current_user, active_tenant_id, scope_level=body.scope_level, scope_id=body.scope_id,
            item_kind=body.item_kind, item_id=body.item_id, levels=body.levels, openings=body.openings,
            transfers=body.transfers, write_off=body.write_off, openings_confirmed=body.openings_confirmed,
        )
    except HTTPException:
        db.rollback()
        raise
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail={"code": str(e), "message": "בחירה לא תקינה"})
    db.commit()
    return out


@router.get("/alerts")
def get_alerts(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shops, companies = _shops_and_companies(db, current_user, active_tenant_id, company_id, shop_id)
    rows = stock_alerts.open_alerts(db, active_tenant_id, shop_ids=[s.id for s in shops], company_ids=list(companies) if shop_id is None else None)
    scope = stock_scope.scope_of(db, current_user)
    names: Dict[str, Any] = {}
    out = []
    for a in rows:
        path = L.Path(company_id=a.company_id, shop_id=a.shop_id, area_id=a.area_id, machine_id=a.machine_id, node_level=a.level)
        if not scope.covers_path(path):
            continue
        out.append(stock_alerts.alert_out(db, a, names))
    return out


@router.put("/opening")
def put_opening(
    body: OpeningIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_writer(current_user)
    n = svc.set_opening(db, current_user, active_tenant_id, Location(body.level, body.target_id), body.items)
    db.commit()
    return {"updated": n}


@router.post("/reset")
def post_reset(
    body: NodeIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"בצע איפוס עכשיו" (an event): the location's products to their opening stock, at once."""
    _require_writer(current_user)
    loc = Location(body.level, body.target_id)
    stock_scope.check_location(db, current_user, loc, active_tenant_id)
    reset = stock_reset.run(db, loc, tenant_id=active_tenant_id, trigger="manual", user=current_user)
    if reset is None:
        raise HTTPException(status_code=409, detail={"code": "already_running", "message": "איפוס כבר רץ עכשיו"})
    db.commit()
    return {"id": str(reset.id), "items": reset.items, "businessDay": reset.business_day.isoformat()}


@router.get("/resets")
def get_resets(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shops, companies = _shops_and_companies(db, current_user, active_tenant_id, company_id, shop_id)
    return stock_reset.history(db, shop_ids=[s.id for s in shops], company_ids=list(companies) if shop_id is None else [])


@router.get("/leftover")
def get_leftover(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    day: Optional[date] = Query(None),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shops, companies = _shops_and_companies(db, current_user, active_tenant_id, company_id, shop_id)
    return stock_reset.leftover(db, shop_ids=[s.id for s in shops], company_ids=list(companies) if shop_id is None else [], day=day)
