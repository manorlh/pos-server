"""
Sync service — build catalog payloads for MQTT and REST sync endpoints.
Supports full sync and delta sync (items updated since a given timestamp).

Machines with a shop_id receive an **effective** catalog: only globals **assigned** to that shop
(a row in `shop_product_overrides`) are merged with price, `is_listed`, and `is_available`
(per-shop sale flag, default true); plus machine-local rows for stock / POS-only SKUs.
Delisted products are included with `shopListed: false` and `inStock: false`.
`isAvailable` on merged rows follows the override (and listing), not the global product row.
`updatedAt` is the max of global, override, and local timestamps.
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple
import uuid as uuid_mod

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.models.category import Category, CatalogLevel as CategoryCatalogLevel
from app.models.pos_machine import POSMachine
from app.models.product import Product, CatalogLevel
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride


# ── Serializers ──────────────────────────────────────────────────────────────

def _aware_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _serialize_product(p: Product, shop_listed: Optional[bool] = None) -> Dict[str, Any]:
    if shop_listed is None:
        in_stock = p.in_stock
    else:
        in_stock = bool(p.in_stock and shop_listed)
    row: Dict[str, Any] = {
        "id": str(p.id),
        "globalProductId": str(p.global_product_id) if p.global_product_id else None,
        "catalogLevel": p.catalog_level.value if hasattr(p.catalog_level, "value") else p.catalog_level,
        "isLocalOverride": p.is_local_override,
        "merchantId": str(p.merchant_id),
        "companyId": str(p.company_id) if p.company_id else None,
        "shopId": str(p.shop_id) if p.shop_id else None,
        "posMachineId": str(p.pos_machine_id) if p.pos_machine_id else None,
        "categoryId": str(p.category_id),
        "name": p.name,
        "description": p.description,
        "price": float(p.price),
        "sku": p.sku,
        "imageUrl": p.image_url,
        "inStock": in_stock,
        "isAvailable": p.is_available,
        "stockQuantity": p.stock_quantity,
        "barcode": p.barcode,
        "taxRate": float(p.tax_rate) if p.tax_rate is not None else None,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
        "updatedAt": p.updated_at.isoformat() if p.updated_at else None,
    }
    if shop_listed is not None:
        row["shopListed"] = shop_listed
    return row


def _effective_ts(
    global_p: Product,
    local: Optional[Product],
    override: Optional[ShopProductOverride],
) -> datetime:
    parts = [_aware_utc(global_p.updated_at)]
    if local:
        parts.append(_aware_utc(local.updated_at))
    if override:
        parts.append(_aware_utc(override.updated_at))
    parts = [p for p in parts if p is not None]
    return max(parts) if parts else datetime.now(timezone.utc)


def _serialize_merged_product(
    global_p: Product,
    local: Optional[Product],
    override: Optional[ShopProductOverride],
    machine_shop_id: uuid_mod.UUID,
    since: Optional[datetime],
) -> Optional[Dict[str, Any]]:
    """Build one sync row for a global product; return None if delta filter excludes it."""
    eff_ts = _effective_ts(global_p, local, override)
    if since is not None and _aware_utc(eff_ts) <= _aware_utc(since):
        return None

    row_id = local.id if local is not None else global_p.id
    price = float(override.price) if override and override.price is not None else float(global_p.price)
    shop_listed = override.is_listed if override is not None else True
    shop_can_sell = override.is_available if override is not None else True
    base_in_stock = local.in_stock if local is not None else global_p.in_stock
    effective_in_stock = bool(shop_listed and base_in_stock)
    stock_qty = local.stock_quantity if local is not None else global_p.stock_quantity
    # Sale flag is per shop assortment (override), not the machine-local stock row — locals
    # often omit is_available or carried stale values, which wrongly hid items on POS.
    is_avail = bool(shop_listed and shop_can_sell)

    catalog_level = local.catalog_level if local is not None else global_p.catalog_level
    is_local_override = local.is_local_override if local is not None else False

    return {
        "id": str(row_id),
        "globalProductId": str(global_p.id),
        "catalogLevel": catalog_level.value if hasattr(catalog_level, "value") else catalog_level,
        "isLocalOverride": is_local_override,
        "merchantId": str(global_p.merchant_id),
        "companyId": str(global_p.company_id) if global_p.company_id else None,
        "shopId": str(machine_shop_id),
        "posMachineId": str(local.pos_machine_id) if local and local.pos_machine_id else None,
        "categoryId": str(global_p.category_id),
        "name": global_p.name,
        "description": global_p.description,
        "price": price,
        "sku": global_p.sku,
        "imageUrl": global_p.image_url,
        "inStock": effective_in_stock,
        "isAvailable": bool(is_avail),
        "stockQuantity": stock_qty,
        "barcode": global_p.barcode,
        "taxRate": float(global_p.tax_rate) if global_p.tax_rate is not None else None,
        "shopListed": shop_listed,
        "createdAt": (local.created_at if local else global_p.created_at).isoformat()
        if (local and local.created_at) or global_p.created_at
        else None,
        "updatedAt": eff_ts.isoformat() if eff_ts else None,
    }


def _serialize_category(c: Category) -> Dict[str, Any]:
    return {
        "id": str(c.id),
        "catalogLevel": c.catalog_level.value if hasattr(c.catalog_level, "value") else c.catalog_level,
        "merchantId": str(c.merchant_id),
        "companyId": str(c.company_id) if c.company_id else None,
        "shopId": str(c.shop_id) if c.shop_id else None,
        "posMachineId": str(c.pos_machine_id) if c.pos_machine_id else None,
        "name": c.name,
        "description": c.description,
        "color": c.color,
        "imageUrl": c.image_url,
        "parentId": str(c.parent_id) if c.parent_id else None,
        "isActive": c.is_active,
        "sortOrder": c.sort_order,
        "createdAt": c.created_at.isoformat() if c.created_at else None,
        "updatedAt": c.updated_at.isoformat() if c.updated_at else None,
    }


def _resolve_merchant_id_for_machine(db: Session, machine: POSMachine) -> Optional[str]:
    mid = str(machine.merchant_id) if machine.merchant_id else None
    if mid or not machine.shop_id:
        return mid
    shop = (
        db.query(Shop)
        .options(joinedload(Shop.company))
        .filter(Shop.id == machine.shop_id)
        .first()
    )
    if shop and shop.company:
        return str(shop.company.merchant_id)
    return None


def merge_categories_referenced_by_products(
    db: Session,
    machine: POSMachine,
    products: List[Dict[str, Any]],
    categories: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Delta sync can return updated products while omitting categories (unchanged since `since`).
    POS SQLite requires every product.categoryId to exist. Add any missing referenced categories
    and their parent chain for this merchant.
    """
    mid = _resolve_merchant_id_for_machine(db, machine)
    if not mid or not products:
        return categories

    all_ids: Set[uuid_mod.UUID] = set()
    for p in products:
        raw = p.get("categoryId")
        if not raw:
            continue
        try:
            cur: Optional[uuid_mod.UUID] = uuid_mod.UUID(str(raw))
        except (ValueError, TypeError):
            continue
        while cur is not None:
            if cur in all_ids:
                break
            all_ids.add(cur)
            row = db.query(Category).filter(Category.id == cur).first()
            if not row:
                break
            cur = row.parent_id

    if not all_ids:
        return categories

    mid_uuid = uuid_mod.UUID(str(mid)) if isinstance(mid, str) else mid
    existing_ids = {str(c.get("id")) for c in categories if c.get("id")}
    rows = (
        db.query(Category)
        .filter(Category.id.in_(all_ids), Category.merchant_id == mid_uuid)
        .order_by(Category.sort_order)
        .all()
    )
    merged = list(categories)
    seen = set(existing_ids)
    for r in rows:
        sid = str(r.id)
        if sid not in seen:
            merged.append(_serialize_category(r))
            seen.add(sid)
    return merged


# ── Query helpers ─────────────────────────────────────────────────────────────

def _products_merged_for_shop_machine(
    db: Session,
    merchant_id: str,
    machine: POSMachine,
    since: Optional[datetime],
) -> List[Dict[str, Any]]:
    mid = uuid_mod.UUID(str(merchant_id)) if isinstance(merchant_id, str) else merchant_id
    shop_id = machine.shop_id
    mqid = machine.id

    # Explicit assortment: only globals with a shop_product_overrides row for this shop.
    assigned_rows: List[Tuple[ShopProductOverride, Product]] = []
    if shop_id:
        assigned_rows = (
            db.query(ShopProductOverride, Product)
            .join(Product, Product.id == ShopProductOverride.global_product_id)
            .filter(
                ShopProductOverride.shop_id == shop_id,
                Product.merchant_id == mid,
                Product.catalog_level == CatalogLevel.GLOBAL,
                Product.pos_machine_id.is_(None),
            )
            .order_by(Product.name)
            .all()
        )

    locals_list = db.query(Product).filter(Product.pos_machine_id == mqid).all()
    by_global: Dict[Any, Product] = {}
    pos_only: List[Product] = []
    for loc in locals_list:
        if loc.global_product_id:
            by_global[loc.global_product_id] = loc
        else:
            pos_only.append(loc)

    out: List[Dict[str, Any]] = []
    for ovr, g in assigned_rows:
        loc = by_global.get(g.id)
        row = _serialize_merged_product(g, loc, ovr, shop_id, since)
        if row is not None:
            out.append(row)

    for loc in pos_only:
        if since is not None and loc.updated_at is not None:
            if _aware_utc(loc.updated_at) <= _aware_utc(since):
                continue
        out.append(_serialize_product(loc))

    return out


def get_products_for_sync(
    db: Session,
    merchant_id: Optional[str] = None,
    pos_machine_id: Optional[str] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    Return products for a machine.
    If `since` is provided only return products updated after that timestamp (delta sync).
    If `pos_machine_id` is None returns global (merchant-level) products.
    If the machine has `shop_id`, returns merged **assigned** globals + overrides + machine-local
    stock and POS-only rows; otherwise returns only rows owned by that machine (legacy).
    """
    if pos_machine_id is None:
        query = db.query(Product).filter(Product.pos_machine_id.is_(None))
        if merchant_id:
            query = query.filter(Product.merchant_id == merchant_id)
        if since:
            query = query.filter(Product.updated_at > since)
        return [_serialize_product(p) for p in query.all()]

    machine = db.query(POSMachine).filter(POSMachine.id == pos_machine_id).first()
    if machine and machine.shop_id:
        mid = merchant_id or (str(machine.merchant_id) if machine.merchant_id else None)
        if not mid and machine.shop_id:
            shop = (
                db.query(Shop)
                .options(joinedload(Shop.company))
                .filter(Shop.id == machine.shop_id)
                .first()
            )
            if shop and shop.company:
                mid = str(shop.company.merchant_id)
        if mid:
            return _products_merged_for_shop_machine(db, mid, machine, since)

    query = db.query(Product).filter(Product.pos_machine_id == pos_machine_id)
    if merchant_id:
        query = query.filter(Product.merchant_id == merchant_id)
    if since:
        query = query.filter(Product.updated_at > since)

    return [_serialize_product(p) for p in query.all()]


def get_categories_for_sync(
    db: Session,
    merchant_id: Optional[str] = None,
    pos_machine_id: Optional[str] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    Return categories for a machine with optional delta filter.

    Machines **with** `shop_id` receive **global** merchant categories (same IDs as on merged
    products' `categoryId`). Machines **without** `shop_id` keep legacy behavior: only
    machine-local category rows.
    """
    if pos_machine_id:
        machine = db.query(POSMachine).filter(POSMachine.id == pos_machine_id).first()
        if machine and machine.shop_id:
            mid = merchant_id
            if not mid and machine.merchant_id:
                mid = str(machine.merchant_id)
            if not mid:
                shop = (
                    db.query(Shop)
                    .options(joinedload(Shop.company))
                    .filter(Shop.id == machine.shop_id)
                    .first()
                )
                if shop and shop.company:
                    mid = str(shop.company.merchant_id)
            if mid:
                q = (
                    db.query(Category)
                    .filter(
                        Category.merchant_id == mid,
                        Category.catalog_level == CategoryCatalogLevel.GLOBAL,
                        Category.pos_machine_id.is_(None),
                    )
                )
                if since:
                    q = q.filter(Category.updated_at > since)
                return [_serialize_category(c) for c in q.order_by(Category.sort_order).all()]

    query = db.query(Category)
    if merchant_id:
        query = query.filter(Category.merchant_id == merchant_id)
    if pos_machine_id:
        query = query.filter(Category.pos_machine_id == pos_machine_id)
    else:
        query = query.filter(Category.pos_machine_id.is_(None))
    if since:
        query = query.filter(Category.updated_at > since)

    return [_serialize_category(c) for c in query.order_by(Category.sort_order).all()]


def update_machine_sync_timestamp(db: Session, machine_id: str) -> None:
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine:
        machine.last_sync_at = datetime.now(timezone.utc)
        db.commit()


def update_machine_heartbeat_timestamp(db: Session, machine_id: str) -> None:
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine:
        machine.last_heartbeat_at = datetime.now(timezone.utc)
        db.commit()


def get_catalog_change_watermark_for_machine(db: Session, machine: POSMachine) -> Optional[datetime]:
    """
    Best-effort watermark for the newest cloud-side catalog change that should be visible to this machine.
    Used to compute whether the machine's latest pull may be stale.
    """
    mid = _resolve_merchant_id_for_machine(db, machine)
    if not mid:
        return None

    mid_uuid = uuid_mod.UUID(str(mid)) if isinstance(mid, str) else mid
    points: List[datetime] = []

    if machine.shop_id:
        product_max = (
            db.query(func.max(Product.updated_at))
            .join(ShopProductOverride, ShopProductOverride.global_product_id == Product.id)
            .filter(
                ShopProductOverride.shop_id == machine.shop_id,
                Product.merchant_id == mid_uuid,
                Product.catalog_level == CatalogLevel.GLOBAL,
                Product.pos_machine_id.is_(None),
            )
            .scalar()
        )
        override_max = (
            db.query(func.max(ShopProductOverride.updated_at))
            .filter(ShopProductOverride.shop_id == machine.shop_id)
            .scalar()
        )
        category_max = (
            db.query(func.max(Category.updated_at))
            .filter(
                Category.merchant_id == mid_uuid,
                Category.catalog_level == CategoryCatalogLevel.GLOBAL,
                Category.pos_machine_id.is_(None),
            )
            .scalar()
        )
        local_product_max = (
            db.query(func.max(Product.updated_at))
            .filter(Product.pos_machine_id == machine.id)
            .scalar()
        )
        points.extend([product_max, override_max, category_max, local_product_max])
    else:
        local_product_max = (
            db.query(func.max(Product.updated_at))
            .filter(Product.pos_machine_id == machine.id)
            .scalar()
        )
        local_category_max = (
            db.query(func.max(Category.updated_at))
            .filter(Category.pos_machine_id == machine.id)
            .scalar()
        )
        points.extend([local_product_max, local_category_max])

    points = [p for p in points if p is not None]
    if not points:
        return None
    return max(_aware_utc(p) for p in points if p is not None)
