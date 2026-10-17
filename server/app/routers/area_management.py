"""
"ניהול נקודות מכירה" and prices along the chain (P:/specs/chain-areas.md §6, §9, §12):

* `GET|PUT /products/{id}/areas`, `POST /products/areas/bulk` — where in each shop a product is sold
  (app/services/product_areas.py);
* `GET /products/{id}/prices`, `PUT /products/{id}/prices/shops/{shopId}`, `PUT /products/{id}/prices/areas/{areaId}`,
  `GET /products/{id}/price-changes`, `PUT /products/{id}/price-lock`, `GET|PUT /companies/{id}/price-policy` —
  prices per level, "מי רשאי לשנות מחירים" and the log (app/services/price_policy.py);
* `GET /products/{id}/levels-summary` — per shop, what lower levels set differently ("N חריגות למטה");
* `GET /shops/{id}/areas/overview` — the points of sale of a shop side by side.

Who: the catalog's readers read; writes are checked per target (the shop's role rule, then the user's points of
sale — app/services/area_scope.py — then the price policy).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.price_policy import PricePolicy
from app.models.product import CatalogLevel, Product
from app.models.product_availability_override import AreaProductOverride, MachineProductOverride
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User, UserRole
from app.services import area_scope
from app.services import price_policy as PP
from app.services import product_areas as PA
from app.services.permission_matrix import SHOP_SCOPED_ROLES

router = APIRouter(tags=["area-management"])


class _Body(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ProductAreasIn(_Body):
    shop_id: uuid.UUID = Field(alias="shopId")
    #: The points of sale where it is sold; null = every point of sale of the shop.
    area_ids: Optional[List[uuid.UUID]] = Field(None, alias="areaIds", max_length=200)


class BulkAreasIn(_Body):
    product_ids: List[uuid.UUID] = Field(alias="productIds", min_length=1, max_length=PA.MAX_BULK)
    shop_id: uuid.UUID = Field(alias="shopId")
    area_ids: List[uuid.UUID] = Field(alias="areaIds", min_length=1, max_length=200)
    action: Literal["add", "remove"]


class PriceIn(_Body):
    #: null = back to the level above.
    price: Optional[float] = Field(None, ge=0, le=1_000_000)


class PriceLockIn(_Body):
    locked: bool


class PricePolicyIn(_Body):
    editors: Literal["chain", "shop", "area"] = "area"
    shop_editors: Optional[Dict[str, Literal["chain", "shop", "area"]]] = Field(None, alias="shopEditors")
    locked_product_ids: Optional[List[uuid.UUID]] = Field(None, alias="lockedProductIds", max_length=5000)
    locked_category_ids: Optional[List[uuid.UUID]] = Field(None, alias="lockedCategoryIds", max_length=2000)
    max_delta_pct: Optional[float] = Field(None, alias="maxDeltaPct", ge=0, le=100)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _uuid(value: Any) -> Optional[uuid.UUID]:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _product(db: Session, user: User, product_id: Any, tenant_id: Any) -> Product:
    """A chain (global) product of this organization the user's catalog reaches."""
    from app.services.company_hierarchy import catalog_company_ids

    pid = _uuid(product_id)
    product = db.get(Product, pid) if pid is not None else None
    if (
        product is None
        or str(product.tenant_id) != str(tenant_id)
        or product.pos_machine_id is not None
        or product.catalog_level not in (CatalogLevel.GLOBAL, "global")
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ids = catalog_company_ids(db, user)
    if ids is not None and product.company_id is not None and product.company_id not in set(ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    return product


def _reachable_shops(db: Session, user: User, tenant_id: Any) -> List[Shop]:
    from app.services.company_hierarchy import visible_shop_ids

    query = db.query(Shop).filter(Shop.tenant_id == tenant_id)
    if user.role == UserRole.COMPANY_MANAGER:
        query = query.filter(Shop.id.in_(visible_shop_ids(db, user)))
    elif user.role in SHOP_SCOPED_ROLES:
        query = query.filter(Shop.id == user.shop_id)
    elif user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return []
    reach = area_scope.reach_of(db, user)
    return [s for s in query.order_by(Shop.name).all() if reach.covers_shop(s.id)]


def _shop_for_write(db: Session, user: User, shop_id: Any, tenant_id: Any) -> Shop:
    from app.routers.shops import _check_shop_member_write

    shop = db.get(Shop, _uuid(shop_id)) if _uuid(shop_id) is not None else None
    if shop is None or str(shop.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    _check_shop_member_write(user, shop, db)
    area_scope.check_shop_read(db, user, shop.id)
    return shop


def _allowed_in_shop(db: Session, product: Product, shop: Shop) -> None:
    from app.services.product_shop_scope import product_allowed_in_shop

    if not product_allowed_in_shop(db, product, shop):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Product not in shop company")


def _notify_shop(db: Session, shop_id: Any, reason: str) -> None:
    from app.services.catalog_notify import notify_machines_for_shop

    notify_machines_for_shop(db, str(shop_id), reason=reason)


# ── Points of sale of a product ──────────────────────────────────────────────


@router.get("/products/{product_id}/areas")
def get_product_areas(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    product = _product(db, current_user, product_id, active_tenant_id)
    return {"productId": str(product.id), "shops": PA.view(db, current_user, product, _reachable_shops(db, current_user, active_tenant_id))}


@router.put("/products/{product_id}/areas")
def put_product_areas(
    product_id: str,
    body: ProductAreasIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The product's points of sale in one shop (null = all). None selected = the shop stops selling it."""
    product = _product(db, current_user, product_id, active_tenant_id)
    shop = _shop_for_write(db, current_user, body.shop_id, active_tenant_id)
    _allowed_in_shop(db, product, shop)
    change = PA.plan(db, current_user, shop, product, area_ids=body.area_ids)
    PA.apply(db, shop, product, change)
    db.commit()
    if change.changed:
        _notify_shop(db, shop.id, "product_areas")
    return {"productId": str(product.id), "shops": PA.view(db, current_user, product, [shop])}


@router.post("/products/areas/bulk")
def bulk_product_areas(
    body: BulkAreasIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"הוספה/הסרה מנקודות מכירה" for many products in one shop. Each product on its own; refusals listed."""
    shop = _shop_for_write(db, current_user, body.shop_id, active_tenant_id)
    changed: List[str] = []
    unchanged: List[str] = []
    refused: List[Dict[str, Any]] = []
    for pid in dict.fromkeys(body.product_ids):
        try:
            product = _product(db, current_user, pid, active_tenant_id)
            _allowed_in_shop(db, product, shop)
            kw = {"add": body.area_ids} if body.action == "add" else {"remove": body.area_ids}
            change = PA.plan(db, current_user, shop, product, **kw)
            PA.apply(db, shop, product, change)
            db.flush()
            (changed if change.changed else unchanged).append(str(pid))
        except HTTPException as exc:
            refused.append({"productId": str(pid), "detail": exc.detail})
    db.commit()
    if changed:
        _notify_shop(db, shop.id, "product_areas")
    return {"changed": changed, "unchanged": unchanged, "refused": refused}


# ── Prices ───────────────────────────────────────────────────────────────────


@router.get("/products/{product_id}/prices")
def get_product_prices(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    product = _product(db, current_user, product_id, active_tenant_id)
    return PP.prices_view(db, current_user, product, _reachable_shops(db, current_user, active_tenant_id))


@router.put("/products/{product_id}/prices/shops/{shop_id}")
def put_shop_price(
    product_id: str,
    shop_id: str,
    body: PriceIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The shop's price ("כאן"), null = back to the chain's. Never the chain's own price."""
    product = _product(db, current_user, product_id, active_tenant_id)
    shop = _shop_for_write(db, current_user, shop_id, active_tenant_id)
    area_scope.refuse_shop_level(db, current_user)
    row = (
        db.query(ShopProductOverride)
        .filter(ShopProductOverride.shop_id == shop.id, ShopProductOverride.global_product_id == product.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not in shop assortment")
    PP.set_shop_price(db, current_user, product, row, body.price)
    db.commit()
    _notify_shop(db, shop.id, "shop_product_override")
    return PP.prices_view(db, current_user, product, [shop])


@router.put("/products/{product_id}/prices/areas/{area_id}")
def put_area_price(
    product_id: str,
    area_id: str,
    body: PriceIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A point of sale's price, null = back to the shop's."""
    from app.services import product_availability as availability

    product = _product(db, current_user, product_id, active_tenant_id)
    area = db.get(ShopArea, _uuid(area_id)) if _uuid(area_id) is not None else None
    if area is None or str(area.tenant_id) != str(active_tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Area not found")
    if area.archived_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="area_archived")
    shop = _shop_for_write(db, current_user, area.shop_id, active_tenant_id)
    area_scope.check_area(db, current_user, area.id)
    if (
        db.query(ShopProductOverride.id)
        .filter(ShopProductOverride.shop_id == shop.id, ShopProductOverride.global_product_id == product.id)
        .first()
        is None
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not in shop assortment")
    row = PP.set_area_price(db, current_user, product, area, body.price)
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    availability.notify_area_change(db, area.id)
    return PP.prices_view(db, current_user, product, [shop])


@router.get("/products/{product_id}/price-changes")
def get_price_changes(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    product = _product(db, current_user, product_id, active_tenant_id)
    rows = PP.changes_out(db, product.id)
    reach = area_scope.reach_of(db, current_user)
    if reach.narrowed or current_user.role in SHOP_SCOPED_ROLES or current_user.role == UserRole.COMPANY_MANAGER:
        shops = {str(s.id) for s in _reachable_shops(db, current_user, active_tenant_id)}
        area_shop = {
            str(a.id): str(a.shop_id)
            for a in db.query(ShopArea).filter(ShopArea.id.in_([_uuid(r["targetId"]) for r in rows if r["targetId"]] or [uuid.uuid4()]))
        }

        def visible(r: Dict[str, Any]) -> bool:
            if r["level"] == PP.LEVEL_BASE:
                return True
            if r["level"] == PP.SHOP:
                return r["targetId"] in shops and not reach.narrowed
            return area_shop.get(r["targetId"]) in shops and reach.covers_area(r["targetId"])

        rows = [r for r in rows if visible(r)]
    return {"productId": str(product.id), "changes": rows}


def _policy_company(db: Session, user: User, company_id: Any, tenant_id: Any, *, write: bool) -> Company:
    from app.services.company_hierarchy import user_covers_company

    company = db.get(Company, _uuid(company_id)) if _uuid(company_id) is not None else None
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return company
    if write:
        # The chain's own decision: a manager covering the company, not narrowed to shops or points of sale.
        from app.services.dashboard_access import profile_scope

        scope = profile_scope(db, user)
        narrowed_to_shops = scope is not None and scope.shop_ids and not scope.org_wide and not scope.company_ids
        if (
            user.role != UserRole.COMPANY_MANAGER
            or not user_covers_company(db, user, company.id)
            or narrowed_to_shops
            or area_scope.narrowed(db, user)
        ):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="price_policy_chain_only")
        return company
    from app.services.company_hierarchy import catalog_company_ids

    ids = catalog_company_ids(db, user)
    if ids is not None and company.id not in set(ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    return company


def _policy_out(db: Session, company: Company) -> Dict[str, Any]:
    row = db.get(PricePolicy, company.id)
    eff = PP.effective(db, company_id=company.id)
    return {
        "companyId": str(company.id),
        "own": None if row is None else {
            "editors": row.editors,
            "shopEditors": dict(row.shop_editors or {}),
            "lockedProductIds": [str(p) for p in (row.locked_product_ids or [])],
            "lockedCategoryIds": [str(c) for c in (row.locked_category_ids or [])],
            "maxDeltaPct": float(row.max_delta_pct) if row.max_delta_pct is not None else None,
            "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
        },
        "effective": eff.out(),
        "editorsOptions": [{"id": k, "label": v} for k, v in PP.EDITORS_LABELS.items()],
    }


@router.get("/companies/{company_id}/price-policy")
def get_price_policy(
    company_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _policy_company(db, current_user, company_id, active_tenant_id, write=False)
    return _policy_out(db, company)


@router.put("/companies/{company_id}/price-policy")
def put_price_policy(
    company_id: str,
    body: PricePolicyIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"מי רשאי לשנות מחירים" for the company (and its sub-companies). Only the chain."""
    company = _policy_company(db, current_user, company_id, active_tenant_id, write=True)
    shops = {str(s) for (s,) in db.query(Shop.id).filter(Shop.company_id == company.id).all()}
    shop_editors = {k: v for k, v in (body.shop_editors or {}).items()}
    if any(k not in shops for k in shop_editors):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="shop_not_in_company")
    row = db.get(PricePolicy, company.id)
    if row is None:
        row = PricePolicy(company_id=company.id, tenant_id=company.tenant_id)
        db.add(row)
    row.editors = body.editors
    row.shop_editors = shop_editors or None
    row.locked_product_ids = sorted({str(p) for p in body.locked_product_ids or []}) or None
    row.locked_category_ids = sorted({str(c) for c in body.locked_category_ids or []}) or None
    row.max_delta_pct = body.max_delta_pct
    row.updated_by_user_id = current_user.id
    db.commit()
    return _policy_out(db, company)


@router.put("/products/{product_id}/price-lock")
def put_price_lock(
    product_id: str,
    body: PriceLockIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"מחיר נעול ע״י הרשת" on the product's company policy (a tenant-wide product: refused, 400)."""
    product = _product(db, current_user, product_id, active_tenant_id)
    if product.company_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="product_has_no_company")
    company = _policy_company(db, current_user, product.company_id, active_tenant_id, write=True)
    row = db.get(PricePolicy, company.id)
    if row is None:
        row = PricePolicy(company_id=company.id, tenant_id=company.tenant_id, editors=PP.AREA)
        db.add(row)
    ids = {str(p) for p in (row.locked_product_ids or [])}
    if body.locked:
        ids.add(str(product.id))
    else:
        ids.discard(str(product.id))
    row.locked_product_ids = sorted(ids) or None
    row.updated_by_user_id = current_user.id
    db.commit()
    return {"productId": str(product.id), "locked": body.locked, "policy": _policy_out(db, company)}


# ── What lower levels set differently ────────────────────────────────────────


@router.get("/products/{product_id}/levels-summary")
def get_levels_summary(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Per shop the user reaches that sells the product: its price and lock, and how many points of sale / devices
    set something of their own — the "ב-N נקודות יש חריגה" notes beside a chain- or shop-wide change.
    """
    product = _product(db, current_user, product_id, active_tenant_id)
    shops = _reachable_shops(db, current_user, active_tenant_id)
    rows = {
        r.shop_id: r
        for r in db.query(ShopProductOverride).filter(
            ShopProductOverride.global_product_id == product.id,
            ShopProductOverride.shop_id.in_([s.id for s in shops] or [uuid.uuid4()]),
        )
    }
    out = []
    totals = {"shopPrices": 0, "shopLocks": 0, "areaPrices": 0, "areaLocks": 0, "machineLocks": 0, "partialAreas": 0}
    for shop in shops:
        row = rows.get(shop.id)
        if row is None or not row.is_listed:
            continue
        areas = PA.live_areas(db, shop.id)
        area_ids = [a.id for a in areas]
        area_rows = db.query(AreaProductOverride).filter(
            AreaProductOverride.product_id == product.id,
            AreaProductOverride.area_id.in_(area_ids or [uuid.uuid4()]),
        ).all()
        machine_ids = [m for (m,) in db.query(POSMachine.id).filter(POSMachine.shop_id == shop.id).all()]
        machine_locks = db.query(MachineProductOverride).filter(
            MachineProductOverride.product_id == product.id,
            MachineProductOverride.machine_id.in_(machine_ids or [uuid.uuid4()]),
            MachineProductOverride.is_available.isnot(None),
        ).count()
        sold = PA.effective_ids(row, areas)
        item = {
            "shopId": str(shop.id),
            "shopName": shop.name,
            "price": float(row.price) if row.price is not None else None,
            "isAvailable": row.is_available,
            "areasTotal": len(areas),
            "areasSold": len(sold),
            "areaPrices": sum(1 for r in area_rows if r.price is not None),
            "areaLocks": sum(1 for r in area_rows if r.is_available is not None),
            "machineLocks": machine_locks,
        }
        totals["shopPrices"] += int(row.price is not None)
        totals["shopLocks"] += int(row.is_available is not None)
        totals["areaPrices"] += item["areaPrices"]
        totals["areaLocks"] += item["areaLocks"]
        totals["machineLocks"] += machine_locks
        totals["partialAreas"] += int(bool(areas) and len(sold) < len(areas))
        out.append(item)
    return {"productId": str(product.id), "basePrice": float(product.price or 0), "shops": out, "totals": totals}


# ── The points of sale of a shop side by side ────────────────────────────────


@router.get("/shops/{shop_id}/areas/overview")
def get_areas_overview(
    shop_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"ניהול נקודות מכירה": per point of sale (the user's own only, for a manager of points of sale)."""
    from app.routers.shops import _check_shop_access
    from app.services import areas as A
    from app.services import area_overview

    shop = db.get(Shop, _uuid(shop_id)) if _uuid(shop_id) is not None else None
    if shop is None or str(shop.tenant_id) != str(active_tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    _check_shop_access(current_user, shop, db)
    area_scope.check_shop_read(db, current_user, shop.id)
    areas = A.shop_areas(db, shop.id)
    mine = area_scope.allowed_area_ids(db, current_user)
    if mine is not None:
        areas = [a for a in areas if a.id in mine]
    return area_overview.overview(db, shop, areas, whole_shop=mine is None)
