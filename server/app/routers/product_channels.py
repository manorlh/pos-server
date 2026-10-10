"""
"מופיע ב" — a product's four channels and their exceptions, and the bulk screen
(app/services/product_channels.py, specs/digital-menu-ordering-cards-plan.md §4.2).

* `GET /product-channels/products/{id}` — the product's default for each channel, its exceptions
  per shop / point of sale (with who set them) and, for each exception's place, the effective
  values with their source.
* `PUT /product-channels/products/{id}` — change the default (`channels`, only those sent) and set
  or let go of exceptions (`overrides`, `allowed` null = back to inherit). Every place named must be
  the caller's to write; the whole request is refused otherwise.
* `POST /product-channels/bulk` — the same switches on many products: the rows selected, or "all
  matching" a filter, run here on the server (pages never loaded included). `dryRun` answers the
  counts first (matched / would change / unchanged / not yours) with a sample. Products the caller
  may not edit are reported, never silently skipped.

Devices: a default change wakes the organisation's devices (as a product edit does); an exception
wakes the devices of its shop. Each one reads its `salesChannel` from the pull
(`product_channels.project_rows`) — the older codes only.
"""
from __future__ import annotations

import logging
import uuid as uuid_mod
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.product import CatalogLevel, Product
from app.models.product_channel_override import ProductChannelOverride
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.user import User
from app.routers.products import _CATALOG_ROLES, _check_product_access
from app.routers.shops import _check_shop_override_write
from app.services import product_channels as PC
from app.services import product_list_filters as list_filters
from app.services.catalog_notify import notify_all_machines_for_tenant, notify_machines_for_shop
from app.services.company_hierarchy import catalog_visibility_filter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/product-channels", tags=["product-channels"])

#: The most products one bulk request changes ("all matching" beyond it is refused, not cut).
BULK_MAX = 20000
SAMPLE_SIZE = 12


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return (value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)).isoformat()


def _channels_field(v):
    from app.schemas.product import _channels_in

    return _channels_in(v)


class OverrideIn(BaseModel):
    level: Literal["shop", "area"]
    target_id: uuid_mod.UUID = Field(..., alias="targetId")
    channel: Literal["pos", "kiosk", "online", "menu"]
    #: True / False — appears there or not; null — no exception (back to the product's default).
    allowed: Optional[bool] = None

    class Config:
        populate_by_name = True


class ProductChannelsIn(BaseModel):
    channels: Optional[Dict[str, bool]] = None
    overrides: Optional[List[OverrideIn]] = Field(None, max_length=400)

    @field_validator("channels", mode="before")
    @classmethod
    def _channels(cls, v):
        return _channels_field(v)


class BulkFilter(BaseModel):
    search: Optional[str] = None
    category_ids: Optional[List[str]] = Field(None, alias="categoryIds")
    channel_on: Optional[List[str]] = Field(None, alias="channelOn")
    channel_off: Optional[List[str]] = Field(None, alias="channelOff")
    company_id: Optional[uuid_mod.UUID] = Field(None, alias="companyId")

    class Config:
        populate_by_name = True


class BulkSelection(BaseModel):
    #: The rows the user ticked (a page or a few).
    ids: Optional[List[uuid_mod.UUID]] = Field(None, max_length=BULK_MAX)
    #: "כל התוצאות": every product matching this filter, on the server.
    all_matching: Optional[BulkFilter] = Field(None, alias="allMatching")

    class Config:
        populate_by_name = True


class BulkIn(BaseModel):
    selection: BulkSelection
    set: Dict[str, bool]
    dry_run: bool = Field(True, alias="dryRun")

    @field_validator("set", mode="before")
    @classmethod
    def _set(cls, v):
        out = _channels_field(v)
        if not out:
            raise ValueError("set at least one channel")
        return out

    class Config:
        populate_by_name = True


# ── Reading ──────────────────────────────────────────────────────────────────


def _global_product(db: Session, product_id: str, tenant_id) -> Product:
    try:
        ident = uuid_mod.UUID(str(product_id))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    product = db.get(Product, ident)
    if product is not None and product.global_product_id is not None:
        product = db.get(Product, product.global_product_id)
    if product is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    ensure_same_tenant(product.tenant_id, tenant_id)
    return product


def _place_names(db: Session, rows: List[ProductChannelOverride]) -> Dict[tuple, Dict[str, Any]]:
    shops = {r.target_id for r in rows if r.level == "shop"}
    areas = {r.target_id for r in rows if r.level == "area"}
    out: Dict[tuple, Dict[str, Any]] = {}
    area_rows = db.query(ShopArea).filter(ShopArea.id.in_(list(areas))).all() if areas else []
    shops |= {a.shop_id for a in area_rows}
    shop_rows = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(list(shops))).all()} if shops else {}
    for sid, s in shop_rows.items():
        out[("shop", str(sid))] = {"name": s.name, "shopId": str(sid), "shopName": s.name}
    for a in area_rows:
        shop = shop_rows.get(a.shop_id)
        out[("area", str(a.id))] = {
            "name": a.name, "shopId": str(a.shop_id), "shopName": shop.name if shop is not None else None,
        }
    return out


def product_channels_view(db: Session, product: Product) -> Dict[str, Any]:
    rows = (
        db.query(ProductChannelOverride)
        .filter(ProductChannelOverride.product_id == product.id, ProductChannelOverride.allowed.isnot(None))
        .order_by(ProductChannelOverride.level, ProductChannelOverride.target_id, ProductChannelOverride.channel)
        .all()
    ) if PC.tables_ready(db) else []
    names = _place_names(db, rows)
    defaults = PC.of(product)
    places: Dict[tuple, Dict[str, Any]] = {}
    overrides = []
    for r in rows:
        info = names.get((r.level, str(r.target_id)), {})
        overrides.append({
            "id": str(r.id),
            "level": r.level,
            "targetId": str(r.target_id),
            "targetName": info.get("name"),
            "shopId": info.get("shopId"),
            "shopName": info.get("shopName"),
            "channel": r.channel,
            "allowed": bool(r.allowed),
            "updatedBy": r.updated_by_name,
            "updatedAt": _iso(r.updated_at),
        })
        places.setdefault((r.level, str(r.target_id)), info)
    # For each place with an exception: every channel as it stands there, and from where.
    effective = []
    for (level, target), info in places.items():
        shop_id = target if level == "shop" else info.get("shopId")
        area_id = target if level == "area" else None
        eff = PC.resolve(defaults, rows, shop_id=shop_id, area_id=area_id)
        effective.append({
            "level": level, "targetId": target, "targetName": info.get("name"),
            "channels": {c: {"allowed": e.allowed, "source": e.source} for c, e in eff.items()},
        })
    return {
        "productId": str(product.id),
        "channels": defaults,
        "salesChannel": PC.stored_code(product),
        "overrides": overrides,
        "effective": effective,
    }


@router.get("/products/{product_id}")
def get_product_channels(
    product_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    product = _global_product(db, product_id, active_tenant_id)
    _check_product_access(current_user, product, db)
    return product_channels_view(db, product)


# ── Writing one product ──────────────────────────────────────────────────────


def _place_shop(db: Session, level: str, target_id, tenant_id) -> Shop:
    """The shop an exception's place lies in, this tenant's; 404 otherwise."""
    if level == "shop":
        shop = db.get(Shop, target_id)
    else:
        area = db.get(ShopArea, target_id)
        if area is None or area.archived_at is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Point of sale not found")
        ensure_same_tenant(area.tenant_id, tenant_id)
        shop = db.get(Shop, area.shop_id)
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    return shop


def _user_name(user: User) -> Optional[str]:
    name = getattr(user, "username", None) or getattr(user, "email", None)
    return name[:200] if name else None


@router.put("/products/{product_id}")
def put_product_channels(
    product_id: str,
    body: ProductChannelsIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    product = _global_product(db, product_id, active_tenant_id)
    _check_product_access(current_user, product, db)
    if product.catalog_level not in (CatalogLevel.GLOBAL, "global") or product.pos_machine_id is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only a catalog product has channels")
    if body.overrides and not PC.tables_ready(db):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="channel_overrides_unavailable")

    # Every place first: the whole request is refused if one is not the caller's.
    shops: Dict[tuple, Shop] = {}
    for o in body.overrides or []:
        key = (o.level, str(o.target_id))
        if key not in shops:
            shop = _place_shop(db, o.level, o.target_id, active_tenant_id)
            _check_shop_override_write(current_user, shop, db)
            shops[key] = shop

    changed_default = PC.apply(product, body.channels or {})
    touched_shops: Set[str] = set()
    now = _now()
    who = _user_name(current_user)
    for o in body.overrides or []:
        row = (
            db.query(ProductChannelOverride)
            .filter(
                ProductChannelOverride.product_id == product.id,
                ProductChannelOverride.level == o.level,
                ProductChannelOverride.target_id == o.target_id,
                ProductChannelOverride.channel == o.channel,
            )
            .first()
        )
        if row is None:
            if o.allowed is None:
                continue
            row = ProductChannelOverride(
                id=uuid_mod.uuid4(), tenant_id=product.tenant_id, product_id=product.id,
                level=o.level, target_id=o.target_id, channel=o.channel, created_at=now,
            )
            db.add(row)
        elif row.allowed == o.allowed:
            continue
        row.allowed = o.allowed
        row.updated_at = now
        row.updated_by_user_id = getattr(current_user, "id", None)
        row.updated_by_name = who
        touched_shops.add(str(shops[(o.level, str(o.target_id))].id))
    if changed_default:
        product.updated_at = now
    db.commit()
    db.refresh(product)
    if changed_default and product.tenant_id is not None:
        notify_all_machines_for_tenant(db, str(product.tenant_id), reason="product_change")
    else:
        for shop_id in touched_shops:
            notify_machines_for_shop(db, shop_id, reason="product_change")
    if changed_default or touched_shops:
        logger.info(
            "product channels product=%s default=%s exceptions_shops=%d by=%s",
            product.id, PC.summary(PC.of(product)), len(touched_shops), getattr(current_user, "id", None),
        )
    return product_channels_view(db, product)


# ── Bulk ─────────────────────────────────────────────────────────────────────


def _matching_query(db: Session, user: User, tenant_id, f: BulkFilter):
    """The catalog products a filter matches — the product list's own conditions, on the server."""
    q = db.query(Product).filter(
        Product.tenant_id == tenant_id,
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
    )
    visible = catalog_visibility_filter(db, user, Product)
    if visible is not None:
        q = q.filter(visible)
    if f.company_id is not None:
        q = q.filter(Product.company_id == f.company_id)
    matches = list_filters.search_condition(f.search)
    if matches is not None:
        q = q.filter(matches)
    in_categories = list_filters.category_condition([c for c in (f.category_ids or []) if c], False, tenant_id)
    if in_categories is not None:
        q = q.filter(in_categories)
    for wanted, on in ((f.channel_on, True), (f.channel_off, False)):
        for channel in [c for c in (wanted or []) if c]:
            if channel not in PC.CHANNELS:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown channel")
            q = q.filter(PC.condition(Product, channel, on))
    return q


@router.post("/bulk")
def bulk_product_channels(
    body: BulkIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    if not body.dry_run and current_user.role not in _CATALOG_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    sel = body.selection
    if (sel.ids is None) == (sel.all_matching is None):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="choose ids or allMatching")
    if sel.ids is not None:
        products = []
        ids = list(dict.fromkeys(sel.ids))
        for start in range(0, len(ids), 500):
            products += db.query(Product).filter(Product.id.in_(ids[start:start + 500])).all()
        found = {p.id for p in products}
        missing = [str(i) for i in ids if i not in found]
        products = [p for p in products if str(p.tenant_id) == str(active_tenant_id)]
        missing += [str(i) for i in ids if i in found and i not in {p.id for p in products}]
    else:
        q = _matching_query(db, current_user, active_tenant_id, sel.all_matching)
        total = q.count()
        if total > BULK_MAX:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "too_many", "message": f"יותר מ-{BULK_MAX} מוצרים — צמצמו את הסינון", "matched": total},
            )
        products = q.order_by(Product.name, Product.id).all()
        missing = []

    refused: List[Dict[str, Any]] = []
    allowed: List[Product] = []
    for p in products:
        if p.catalog_level not in (CatalogLevel.GLOBAL, "global") or p.pos_machine_id is not None:
            refused.append({"id": str(p.id), "name": p.name, "reason": "not_catalog"})
            continue
        try:
            _check_product_access(current_user, p, db)
        except HTTPException:
            refused.append({"id": str(p.id), "name": p.name, "reason": "not_yours"})
            continue
        allowed.append(p)

    changes = []
    for p in allowed:
        before = PC.of(p)
        after = {**before, **body.set}
        if after != before:
            changes.append((p, before, after))
    sample = [
        {"id": str(p.id), "name": p.name, "before": before, "after": after}
        for p, before, after in changes[:SAMPLE_SIZE]
    ]
    result = {
        "matched": len(products) + len(missing),
        "changed": len(changes),
        "unchanged": len(allowed) - len(changes),
        "refused": len(refused) + len(missing),
        "refusedSample": refused[:SAMPLE_SIZE] + [{"id": m, "name": None, "reason": "not_found"} for m in missing[:SAMPLE_SIZE]],
        "sample": sample,
        "set": body.set,
        "applied": False,
    }
    if body.dry_run or not changes:
        return result
    now = _now()
    for p, _before, _after in changes:
        PC.apply(p, body.set)
        p.updated_at = now
    db.commit()
    notify_all_machines_for_tenant(db, str(active_tenant_id), reason="product_change")
    logger.info(
        "product channels bulk set=%s changed=%d refused=%d by=%s",
        body.set, len(changes), result["refused"], getattr(current_user, "id", None),
    )
    result["applied"] = True
    return result
