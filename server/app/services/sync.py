"""
Sync service — build catalog payloads for MQTT and REST sync endpoints.
Supports full sync and delta sync (items updated since a given timestamp).

Machines with a shop_id receive an **effective** catalog: only globals **assigned** to that shop
(a row in `shop_product_overrides`) are merged with price and `is_listed`; plus machine-local
rows for stock / POS-only SKUs.
Delisted products are included with `shopListed: false` and `inStock: false`.
`isAvailable` on merged rows is the product's effective availability for *this machine*
(machine → area → shop → the shop's own company → the product), resolved in
`app/services/product_availability.py`, and false whenever the row is delisted. A
machine-local copy's own flag plays no part in it.
`updatedAt` is the max of global, override, local, company-, area- and machine-level
timestamps, of the till's own catalog row for the product, and of when the till last
changed area (its area level changed with it).
A category's `isActive` is likewise effective for *this machine* (the tenant flag, then
machine → area → shop), resolved in `app/services/category_availability.py`.
`inMachineCatalog` on each row says whether the product is on this till's own list
(`app/services/machine_catalog.py`), independently of the till's mode; the mode itself
travels once per payload (`machine_catalog_for_sync`). The till applies the rule.
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple
import uuid as uuid_mod

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, joinedload

from app.models.category import Category, CatalogLevel as CategoryCatalogLevel
from app.models.customer import Customer
from app.models.pos_machine import POSMachine
from app.services.machine_health import (
    normalize_battery_percent,
    normalize_battery_status,
    normalize_clock_skew_ms,
    normalize_serial_number,
)
from app.models.product import Product, CatalogLevel
from app.models.product_availability_override import (
    AreaProductOverride,
    CompanyProductOverride,
    MachineProductOverride,
)
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.shop_category_override import ShopCategoryOverride
from app.models.machine_catalog_item import MachineCatalogItem
from app.models.voucher import Voucher
from app.services import dietary
from app.services import sales_channel
from app.services import general_item
from app.services import item_ticket
from app.services import machine_catalog
from app.services import product_alerts
from app.services import product_availability as availability
from app.services import category_availability
from app.services import sold_out


# ── Serializers ──────────────────────────────────────────────────────────────

def _aware_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _effective_voucher_id(p: Product) -> Optional[uuid_mod.UUID]:
    """Product-level voucher wins; otherwise inherit the product's category voucher."""
    if p.voucher_id:
        return p.voucher_id
    category = p.category
    if category is not None and category.voucher_id:
        return category.voucher_id
    return None


def _is_general(p: Product) -> bool:
    """
    The till's `isGeneral`: the company's built-in general item (see
    app/services/general_item.py). A machine-local copy of it (catalog push) is not
    itself flagged — the unique index allows one flagged row per company — so it is
    read through the global row it copies.
    """
    if general_item.is_general(p):
        return True
    if getattr(p, "global_product_id", None) is None:
        return False
    return general_item.is_general(getattr(p, "global_product", None))


def _serialize_product(p: Product, shop_listed: Optional[bool] = None) -> Dict[str, Any]:
    if shop_listed is None:
        in_stock = p.in_stock
    else:
        in_stock = bool(p.in_stock and shop_listed)
    eff_voucher_id = _effective_voucher_id(p)
    row: Dict[str, Any] = {
        "id": str(p.id),
        "globalProductId": str(p.global_product_id) if p.global_product_id else None,
        "catalogLevel": p.catalog_level.value if hasattr(p.catalog_level, "value") else p.catalog_level,
        "isLocalOverride": p.is_local_override,
        "companyId": str(p.company_id) if p.company_id else None,
        "shopId": str(p.shop_id) if p.shop_id else None,
        "posMachineId": str(p.pos_machine_id) if p.pos_machine_id else None,
        "categoryId": str(p.category_id),
        "name": p.name,
        "description": p.description,
        "price": float(p.price),
        "sku": p.sku,
        "globalSku": p.global_sku,
        "imageUrl": p.image_url,
        "inStock": in_stock,
        # A machine-local or tenant-level row: no company, shop or machine level applies,
        # so this is the product's own flag — asked of the resolver all the same.
        "isAvailable": availability.resolve(p.is_available).available,
        "stockQuantity": p.stock_quantity,
        "barcode": p.barcode,
        "taxRate": float(p.tax_rate) if p.tax_rate is not None else None,
        "voucherId": str(eff_voucher_id) if eff_voucher_id else None,
        # Resolved (product, else category): the till prints from this as it stands.
        "ticketMode": item_ticket.effective_mode(p),
        "ticketEntries": getattr(p, "ticket_entries", None),
        "trackStock": bool(p.track_stock),
        "isOpenPrice": bool(p.is_open_price),
        "isWeighed": bool(p.is_weighed),
        "unitLabel": p.unit_label,
        # "לא מקבל הנחות": the till gives it no line, basket or promotion discount.
        "noDiscount": bool(getattr(p, "no_discount", False)),
        # The menu layer (docs/SPEC_MENU_MODIFIERS.md): allergen codes, and the course
        # its table lines fire in (null: the category's).
        "allergens": list(getattr(p, "allergens", None) or []),
        # "סימוני תזונה" (docs/SPEC_PRODUCT_DIETARY.md): codes in the fixed order, [] for none.
        "dietaryTags": dietary.tags_out(getattr(p, "dietary_tags", None)),
        # "היכן הפריט נמכר" (docs/SPEC_PRODUCT_CHANNELS.md): all / kiosk_only / pos_only.
        "salesChannel": sales_channel.out(getattr(p, "sales_channel", None)),
        "courseId": str(p.course_id) if getattr(p, "course_id", None) else None,
        # Order limits and refills (docs/SPEC_MENU_MODIFIERS.md §3.9).
        "maxPerOrder": getattr(p, "max_per_order", None),
        "refillable": bool(getattr(p, "refillable", False)),
        "maxRefills": getattr(p, "max_refills", None),
        # "הודעות לעובד" and "פריטים נלווים" (app/services/product_alerts.py).
        **product_alerts.sync_fields(p),
        "isGeneral": _is_general(p),
        # A machine-local or tenant-level row is the till's own: always on its list.
        "inMachineCatalog": True,
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
    *levels: Any,
) -> datetime:
    """Latest of every row the merged product was built from, availability levels included."""
    parts = [_aware_utc(global_p.updated_at)]
    for row in (local, override, *levels):
        if row is not None:
            parts.append(_aware_utc(row.updated_at))
    parts = [p for p in parts if p is not None]
    return max(parts) if parts else datetime.now(timezone.utc)


def _serialize_merged_product(
    global_p: Product,
    local: Optional[Product],
    override: Optional[ShopProductOverride],
    machine_shop_id: uuid_mod.UUID,
    since: Optional[datetime],
    company_override: Optional[CompanyProductOverride] = None,
    machine_override: Optional[MachineProductOverride] = None,
    catalog_item: Optional[MachineCatalogItem] = None,
    area_override: Optional[AreaProductOverride] = None,
    area_changed_at: Optional[datetime] = None,
    blocks: Any = None,
) -> Optional[Dict[str, Any]]:
    """
    Build one sync row for a global product; return None if delta filter excludes it.

    `company_override` must be the row of the *shop's own* company
    (`availability.company_level_company_id`), `area_override` the row of the area the
    machine stands in, `machine_override` the row of the machine being synced. Their
    timestamps count toward `updatedAt`, so a lock set at any level reaches a till that
    only pulls deltas. `catalog_item` is the till's own whitelist row for the product,
    and counts toward `updatedAt` for the same reason. `area_changed_at` is when the till
    last moved area: its area level changed then without any row changing.
    """
    eff_ts = _effective_ts(
        global_p, local, override, company_override, area_override, machine_override,
        catalog_item,
    )
    moved = _aware_utc(area_changed_at)
    if moved is not None and moved > eff_ts:
        eff_ts = moved
    # "אזל" / "חסום" (app/services/sold_out.py): a block set, removed or ended moves the row too.
    blocked_at = _aware_utc(getattr(blocks, "changed_at", None))
    if blocked_at is not None and blocked_at > eff_ts:
        eff_ts = blocked_at
    if since is not None and _aware_utc(eff_ts) <= _aware_utc(since):
        return None
    active_blocks = list(getattr(blocks, "active", None) or [])

    row_id = local.id if local is not None else global_p.id
    price = float(override.price) if override and override.price is not None else float(global_p.price)
    shop_listed = override.is_listed if override is not None else True
    base_in_stock = local.in_stock if local is not None else global_p.in_stock
    effective_in_stock = bool(shop_listed and base_in_stock)
    stock_qty = local.stock_quantity if local is not None else global_p.stock_quantity
    # Never from the machine-local stock row — locals often omit is_available or carried
    # stale values, which wrongly hid items on POS. A delisted row is never sellable.
    resolved = availability.resolve_rows(
        global_p, company_override, override, machine_override, area_row=area_override
    )
    is_avail = bool(shop_listed and resolved[availability.Level.MACHINE].available)
    # The lock that decides, for a Z the till closes offline (docs/SPEC_AVAILABILITY.md).
    lock = availability.lock_info(
        resolved,
        {
            availability.Level.SHOP: override,
            availability.Level.AREA: area_override,
            availability.Level.MACHINE: machine_override,
        },
    ) if shop_listed else None

    catalog_level = local.catalog_level if local is not None else global_p.catalog_level
    is_local_override = local.is_local_override if local is not None else False
    if local is not None and local.is_local_override and local.image_url:
        image_url = local.image_url
    else:
        image_url = global_p.image_url

    return {
        "id": str(row_id),
        "globalProductId": str(global_p.id),
        "catalogLevel": catalog_level.value if hasattr(catalog_level, "value") else catalog_level,
        "isLocalOverride": is_local_override,
        "companyId": str(global_p.company_id) if global_p.company_id else None,
        "shopId": str(machine_shop_id),
        "posMachineId": str(local.pos_machine_id) if local and local.pos_machine_id else None,
        "categoryId": str(global_p.category_id),
        "name": global_p.name,
        "description": global_p.description,
        "price": price,
        "sku": global_p.sku,
        "globalSku": global_p.global_sku,
        "imageUrl": image_url,
        "inStock": effective_in_stock,
        # Not locked and not blocked: what a till or kiosk that reads only this field sells.
        # A till that predates blocks reads only `isAvailable`: a block set by hand reaches it there;
        # an automatic "אזל" (the stock ran out) only through `blocks`, which updated tills and kiosks
        # read with their own stock policy (sold_out.manual_in_force).
        "isAvailable": bool(is_avail) and not sold_out.manual_in_force(active_blocks),
        # The catalog lock alone ("זמינות למכירה"), and the blocks in force that cover this device
        # ("אזל" / "חסום", app/services/sold_out.py) — a current till decides between them with its
        # own clock (app/services/sold_out_rules.py).
        "lockAvailable": bool(is_avail),
        "blocks": [sold_out.block_out(b) for b in active_blocks],
        "availabilityLock": lock,
        "stockQuantity": stock_qty,
        "barcode": global_p.barcode,
        "taxRate": float(global_p.tax_rate) if global_p.tax_rate is not None else None,
        "voucherId": str(_effective_voucher_id(global_p)) if _effective_voucher_id(global_p) else None,
        # What the product *is*, so from the global row; resolved against its category.
        "ticketMode": item_ticket.effective_mode(global_p),
        "ticketEntries": getattr(global_p, "ticket_entries", None),
        "trackStock": bool(global_p.track_stock),
        "isOpenPrice": bool(global_p.is_open_price),
        # Taken from the global row, like every other product *description* field: a
        # shop override carries price and availability, never what the thing is or how
        # it is measured. A shop selling the same SKU by the piece would be a different
        # product, not an override.
        "isWeighed": bool(global_p.is_weighed),
        "unitLabel": global_p.unit_label,
        # "לא מקבל הנחות", from the global row like the rest of what the product is.
        "noDiscount": bool(getattr(global_p, "no_discount", False)),
        # What the dish contains and its course, from the global row like the rest of
        # what the product is (docs/SPEC_MENU_MODIFIERS.md).
        "allergens": list(getattr(global_p, "allergens", None) or []),
        # "סימוני תזונה", from the global row like the allergens.
        "dietaryTags": dietary.tags_out(getattr(global_p, "dietary_tags", None)),
        # "היכן הפריט נמכר", from the global row like the rest of what the product is: the
        # till hides kiosk_only from its sell screen, the kiosk hides pos_only.
        "salesChannel": sales_channel.out(getattr(global_p, "sales_channel", None)),
        "courseId": str(global_p.course_id) if getattr(global_p, "course_id", None) else None,
        "maxPerOrder": getattr(global_p, "max_per_order", None),
        "refillable": bool(getattr(global_p, "refillable", False)),
        "maxRefills": getattr(global_p, "max_refills", None),
        # "הודעות לעובד" and "פריטים נלווים", from the global row like the rest of what the
        # product is (app/services/product_alerts.py).
        **product_alerts.sync_fields(global_p),
        # From the global row like the rest of what the product *is*: a till's local
        # copy of the general item is still the general item.
        "isGeneral": general_item.is_general(global_p),
        # On this till's own list, whatever the till's mode — see machine_catalog.
        "inMachineCatalog": bool(catalog_item is not None and catalog_item.is_included),
        "shopListed": shop_listed,
        "createdAt": (local.created_at if local else global_p.created_at).isoformat()
        if (local and local.created_at) or global_p.created_at
        else None,
        "updatedAt": eff_ts.isoformat() if eff_ts else None,
    }


def _serialize_category(
    c: Category,
    override: Optional[ShopCategoryOverride] = None,
    activity: Optional[Dict[str, Any]] = None,
    area_changed_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    One category as a till sees it, with the till's own shop's name for it if it has one.

    `activity` is the category's `{level: row}` from `category_availability` for this
    till; `isActive` is what it resolves to, and the tenant's own flag when there are
    none. `updatedAt` is the latest of the category's, the rename override's, those
    rows' and the till's last area move, so that whatever a till stores reflects the
    change it was actually sent for.
    """
    name = override.name if override is not None and override.name else c.name
    updated = c.updated_at
    stamps = [
        override.updated_at if override is not None else None,
        category_availability.latest_change(activity),
        area_changed_at,
    ]
    for stamp in stamps:
        if stamp is not None and (updated is None or _as_utc(stamp) > _as_utc(updated)):
            updated = stamp
    return {
        "id": str(c.id),
        "catalogLevel": c.catalog_level.value if hasattr(c.catalog_level, "value") else c.catalog_level,
        "companyId": str(c.company_id) if c.company_id else None,
        "shopId": str(c.shop_id) if c.shop_id else None,
        "posMachineId": str(c.pos_machine_id) if c.pos_machine_id else None,
        "name": name,
        "description": c.description,
        "color": c.color,
        "imageUrl": c.image_url,
        "parentId": str(c.parent_id) if c.parent_id else None,
        "ticketMode": item_ticket.category_mode(c),
        # The course its products fire in by default (docs/SPEC_MENU_MODIFIERS.md §8).
        "courseId": str(c.course_id) if getattr(c, "course_id", None) else None,
        "isActive": category_availability.resolve_rows(c, activity),
        # The switch-off that decides it, for a Z the till closes offline
        # (docs/SPEC_AVAILABILITY.md); null when active, or switched off by the tenant.
        "activeLock": category_availability.lock_info(c.is_active, activity),
        "sortOrder": c.sort_order,
        "createdAt": c.created_at.isoformat() if c.created_at else None,
        "updatedAt": updated.isoformat() if updated else None,
    }


def _as_utc(value: datetime) -> datetime:
    """SQLite hands timestamps back naive; compare them as the UTC they were written as."""
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _serialize_voucher(v: Voucher) -> Dict[str, Any]:
    mode = v.value_display_mode
    return {
        "id": str(v.id),
        "name": v.name,
        "isActive": v.is_active,
        "title": v.title,
        "subtitle": v.subtitle,
        "bodyText": v.body_text,
        "footerText": v.footer_text,
        "validityDays": v.validity_days,
        "validFrom": v.valid_from.isoformat() if v.valid_from else None,
        "validUntil": v.valid_until.isoformat() if v.valid_until else None,
        "valueDisplayMode": mode.value if hasattr(mode, "value") else mode,
        "displayValue": float(v.display_value) if v.display_value is not None else None,
        "printBarcode": v.print_barcode,
        "printQr": v.print_qr,
        "language": v.language,
        "createdAt": v.created_at.isoformat() if v.created_at else None,
        "updatedAt": v.updated_at.isoformat() if v.updated_at else None,
    }


def _serialize_customer(c: Customer) -> Dict[str, Any]:
    """
    One customer row for the till.

    `isActive` and `deleted` are two different facts and both are shipped. `isActive`
    false is the merchant archiving a customer they still have on file; `deleted` is
    the customer being removed. The till needs both because it must stop *offering* an
    archived customer while still being able to render a document already issued to a
    deleted one.
    """
    return {
        "id": str(c.id),
        "name": c.name,
        "vatNumber": c.vat_number,
        "phone": c.phone,
        "email": c.email,
        "address": c.address,
        "addressNumber": c.address_number,
        "city": c.city,
        "postalCode": c.postal_code,
        "country": c.country,
        "isActive": bool(c.is_active),
        "deleted": c.deleted_at is not None,
        "createdAt": c.created_at.isoformat() if c.created_at else None,
        "updatedAt": c.updated_at.isoformat() if c.updated_at else None,
    }


def _resolve_tenant_id_for_machine(db: Session, machine: POSMachine) -> Optional[str]:
    if machine.tenant_id:
        return str(machine.tenant_id)
    if not machine.shop_id:
        return None
    shop = (
        db.query(Shop)
        .options(joinedload(Shop.company))
        .filter(Shop.id == machine.shop_id)
        .first()
    )
    if shop and shop.tenant_id:
        return str(shop.tenant_id)
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
    and their parent chain for this tenant.
    """
    tid = _resolve_tenant_id_for_machine(db, machine)
    if not tid or not products:
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

    tid_uuid = uuid_mod.UUID(str(tid)) if isinstance(tid, str) else tid
    existing_ids = {str(c.get("id")) for c in categories if c.get("id")}
    rows = (
        db.query(Category)
        .filter(Category.id.in_(all_ids), Category.tenant_id == tid_uuid)
        .order_by(Category.sort_order)
        .all()
    )
    merged = list(categories)
    seen = set(existing_ids)
    missing = [r for r in rows if str(r.id) not in seen]
    if not missing:
        return merged
    # Sent as this till would get them on a full pull — its shop's name and its
    # effective `isActive` — or a delta would undo a rename or a switch-off on the till.
    renames: Dict[Any, ShopCategoryOverride] = {}
    activity: Dict[str, Dict[str, Any]] = {}
    if machine.shop_id:
        renames = {
            o.category_id: o
            for o in db.query(ShopCategoryOverride).filter(
                ShopCategoryOverride.shop_id == machine.shop_id,
                ShopCategoryOverride.category_id.in_([r.id for r in missing]),
            )
        }
        activity = category_availability.overrides_for_machine(db, machine, [r.id for r in missing])
    for r in missing:
        sid = str(r.id)
        if sid not in seen:
            merged.append(_serialize_category(r, renames.get(r.id), activity.get(sid)))
            seen.add(sid)
    return merged


def merge_vouchers_referenced_by_products(
    db: Session,
    products: List[Dict[str, Any]],
    vouchers: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Delta sync: include voucher templates referenced by synced products."""
    voucher_ids: Set[uuid_mod.UUID] = set()
    for p in products:
        raw = p.get("voucherId")
        if not raw:
            continue
        try:
            voucher_ids.add(uuid_mod.UUID(str(raw)))
        except (ValueError, TypeError):
            continue

    if not voucher_ids:
        return vouchers

    existing_ids = {str(v.get("id")) for v in vouchers if v.get("id")}
    rows = db.query(Voucher).filter(Voucher.id.in_(voucher_ids)).all()
    merged = list(vouchers)
    seen = set(existing_ids)
    for r in rows:
        sid = str(r.id)
        if sid not in seen:
            merged.append(_serialize_voucher(r))
            seen.add(sid)
    return merged


# ── Query helpers ─────────────────────────────────────────────────────────────

def _products_merged_for_shop_machine(
    db: Session,
    tenant_id: str,
    machine: POSMachine,
    since: Optional[datetime],
) -> List[Dict[str, Any]]:
    tid = uuid_mod.UUID(str(tenant_id)) if isinstance(tenant_id, str) else tenant_id
    shop_id = machine.shop_id
    mqid = machine.id

    # Explicit assortment: only globals with a shop_product_overrides row for this shop.
    assigned_rows: List[Tuple[ShopProductOverride, Product]] = []
    if shop_id:
        assigned_rows = (
            db.query(ShopProductOverride, Product)
            .join(Product, Product.id == ShopProductOverride.global_product_id)
            .options(joinedload(Product.category))
            .filter(
                ShopProductOverride.shop_id == shop_id,
                Product.tenant_id == tid,
                Product.catalog_level == CatalogLevel.GLOBAL,
                Product.pos_machine_id.is_(None),
            )
            .order_by(Product.name)
            .all()
        )

    locals_list = (
        db.query(Product)
        .options(joinedload(Product.category))
        .filter(Product.pos_machine_id == mqid)
        .all()
    )
    by_global: Dict[Any, Product] = {}
    pos_only: List[Product] = []
    for loc in locals_list:
        if loc.global_product_id:
            by_global[loc.global_product_id] = loc
        else:
            pos_only.append(loc)

    # The two availability levels that are not on the assortment row. The company is the
    # shop's own — never the product's, never an ancestor (see product_availability).
    assigned_ids = [g.id for _, g in assigned_rows]
    shop = db.query(Shop).filter(Shop.id == shop_id).first() if shop_id and assigned_ids else None
    company_levels = availability.company_overrides(
        db, availability.company_level_company_id(shop), assigned_ids
    )
    area_levels = availability.area_overrides(db, getattr(machine, "area_id", None), assigned_ids)
    machine_levels = availability.machine_overrides(db, mqid, assigned_ids)
    catalog_rows = machine_catalog.catalog_items(db, mqid) if assigned_ids else {}
    area_changed_at = getattr(machine, "area_changed_at", None)
    product_blocks = sold_out.blocks_for_machine(db, machine, assigned_ids, since=since) if assigned_ids else {}

    out: List[Dict[str, Any]] = []
    for ovr, g in assigned_rows:
        loc = by_global.get(g.id)
        row = _serialize_merged_product(
            g,
            loc,
            ovr,
            shop_id,
            since,
            company_override=company_levels.get(str(g.id)),
            machine_override=machine_levels.get(str(g.id)),
            catalog_item=catalog_rows.get(str(g.id)),
            area_override=area_levels.get(str(g.id)),
            area_changed_at=area_changed_at if isinstance(area_changed_at, datetime) else None,
            blocks=product_blocks.get(str(g.id)),
        )
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
    tenant_id: Optional[str] = None,
    pos_machine_id: Optional[str] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    Return products for a machine.
    If `since` is provided only return products updated after that timestamp (delta sync).
    If `pos_machine_id` is None returns global (tenant-level) products.
    If the machine has `shop_id`, returns merged **assigned** globals + overrides + machine-local
    stock and POS-only rows; otherwise returns only rows owned by that machine (legacy).
    """
    if pos_machine_id is None:
        query = db.query(Product).options(joinedload(Product.category)).filter(
            Product.pos_machine_id.is_(None)
        )
        if tenant_id:
            query = query.filter(Product.tenant_id == tenant_id)
        if since:
            query = query.filter(Product.updated_at > since)
        return [_serialize_product(p) for p in query.all()]

    machine = db.query(POSMachine).filter(POSMachine.id == pos_machine_id).first()
    if machine and machine.shop_id:
        tid = tenant_id or _resolve_tenant_id_for_machine(db, machine)
        if tid:
            return _products_merged_for_shop_machine(db, tid, machine, since)

    query = db.query(Product).options(joinedload(Product.category)).filter(
        Product.pos_machine_id == pos_machine_id
    )
    if tenant_id:
        query = query.filter(Product.tenant_id == tenant_id)
    if since:
        query = query.filter(Product.updated_at > since)

    return [_serialize_product(p) for p in query.all()]


def overrides_changed_since(
    overrides: Dict[Any, ShopCategoryOverride], since: datetime
) -> List[Any]:
    """Ids of the categories whose *shop override* changed after `since`."""
    return [
        category_id
        for category_id, override in overrides.items()
        if override.updated_at is not None and _as_utc(override.updated_at) > _as_utc(since)
    ]


def category_delta_filter(since: datetime, renamed_here: List[Any]):
    """
    Which categories a delta pull must resend.

    A shop renaming its own button touches only the override row, so the category's own
    timestamp cannot be the only thing a delta looks at — the rename would reach this
    shop's tills only on their next full pull, which for a till left running can be
    days.
    """
    changed = Category.updated_at > since
    if not renamed_here:
        return changed
    return or_(changed, Category.id.in_(renamed_here))


def _category_ids_listed_in_shop(db: Session, shop_id, category_ids: List[Any]) -> Set[str]:
    """Which of `category_ids` a product listed in this shop is filed under."""
    rows = (
        db.query(Product.category_id)
        .join(ShopProductOverride, ShopProductOverride.global_product_id == Product.id)
        .filter(
            ShopProductOverride.shop_id == shop_id,
            ShopProductOverride.is_listed.is_(True),
            Product.category_id.in_(category_ids),
        )
        .distinct()
        .all()
    )
    return {str(row[0]) for row in rows}


def _categories_for_shop(db: Session, machine: POSMachine, categories: List[Category]) -> List[Category]:
    """
    The tenant's categories this till's shop may see.

    A category placed on a company or a shop reaches only that company's or that shop's
    tills — one added from a till belongs to its shop alone. A category any product
    listed in this shop is filed under still comes, whoever placed it, so no product on
    the till points at a category it was never sent.
    """
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    company_id = str(shop.company_id) if shop and shop.company_id else None

    def placed_here(c: Category) -> bool:
        if c.company_id is not None and str(c.company_id) != company_id:
            return False
        return c.shop_id is None or str(c.shop_id) == str(machine.shop_id)

    outside = [c for c in categories if not placed_here(c)]
    if not outside:
        return categories
    in_use = _category_ids_listed_in_shop(db, machine.shop_id, [c.id for c in outside])
    return [c for c in categories if placed_here(c) or str(c.id) in in_use]


def category_sent_to_machine(db: Session, machine: POSMachine, category: Category) -> bool:
    """Is `category` among those `get_categories_for_sync` sends this till (with a shop)?"""
    if not machine.shop_id or category.pos_machine_id is not None:
        return False
    if str(category.tenant_id) != str(machine.tenant_id):
        return False
    level = category.catalog_level.value if hasattr(category.catalog_level, "value") else category.catalog_level
    if level != CategoryCatalogLevel.GLOBAL.value:
        return False
    return bool(_categories_for_shop(db, machine, [category]))


def get_categories_for_sync(
    db: Session,
    tenant_id: Optional[str] = None,
    pos_machine_id: Optional[str] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    Return categories for a machine with optional delta filter.

    Machines **with** `shop_id` receive **global** tenant categories (same IDs as on merged
    products' `categoryId`). Machines **without** `shop_id` keep legacy behavior: only
    machine-local category rows.
    """
    if pos_machine_id:
        machine = db.query(POSMachine).filter(POSMachine.id == pos_machine_id).first()
        if machine and machine.shop_id:
            tid = tenant_id or _resolve_tenant_id_for_machine(db, machine)
            if tid:
                q = (
                    db.query(Category)
                    .filter(
                        Category.tenant_id == tid,
                        Category.catalog_level == CategoryCatalogLevel.GLOBAL,
                        Category.pos_machine_id.is_(None),
                    )
                )
                overrides = {
                    o.category_id: o
                    for o in db.query(ShopCategoryOverride).filter(
                        ShopCategoryOverride.shop_id == machine.shop_id
                    )
                }
                # Whether each category is active here: shop, area and till rows.
                activity = category_availability.overrides_for_machine(db, machine)
                moved = machine.area_changed_at if isinstance(
                    getattr(machine, "area_changed_at", None), datetime
                ) else None
                # A till that moved area since gets every category again: its area
                # level changed without any row changing.
                if since and not (moved is not None and _as_utc(moved) > _as_utc(since)):
                    q = q.filter(
                        category_delta_filter(
                            since,
                            overrides_changed_since(overrides, since)
                            + category_availability.changed_since(activity, since),
                        )
                    )
                rows = _categories_for_shop(db, machine, q.order_by(Category.sort_order).all())
                return [
                    _serialize_category(c, overrides.get(c.id), activity.get(str(c.id)), moved)
                    for c in rows
                ]

    query = db.query(Category)
    if tenant_id:
        query = query.filter(Category.tenant_id == tenant_id)
    if pos_machine_id:
        query = query.filter(Category.pos_machine_id == pos_machine_id)
    else:
        query = query.filter(Category.pos_machine_id.is_(None))
    if since:
        query = query.filter(Category.updated_at > since)

    return [_serialize_category(c) for c in query.order_by(Category.sort_order).all()]


def get_vouchers_for_sync(
    db: Session,
    tenant_id: Optional[str] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """Return active voucher templates for a tenant."""
    if not tenant_id:
        return []
    tid = uuid_mod.UUID(str(tenant_id)) if isinstance(tenant_id, str) else tenant_id
    query = db.query(Voucher).filter(Voucher.tenant_id == tid, Voucher.is_active.is_(True))
    if since:
        query = query.filter(Voucher.updated_at > since)
    return [_serialize_voucher(v) for v in query.order_by(Voucher.name).all()]


def get_customers_for_sync(
    db: Session,
    tenant_id: Optional[str] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    Return the tenant's customers for a machine, with optional delta filter.

    Deliberately unlike `get_vouchers_for_sync`, which filters `is_active` in the
    query: this one returns **every** row, archived and deleted included, and lets the
    till decide what to do with the flags. A filtered query cannot express a deletion
    at all — a row that stops being returned is indistinguishable from a row that has
    not changed, so on a delta pull the till would keep offering a customer forever
    after the merchant removed them. Shipping the tombstone is the only way a delta
    sync can propagate a removal, and it is the same reason
    `get_pos_users_sync` returns deactivated users rather than hiding them.
    """
    if not tenant_id:
        return []
    tid = uuid_mod.UUID(str(tenant_id)) if isinstance(tenant_id, str) else tenant_id
    query = db.query(Customer).filter(Customer.tenant_id == tid)
    if since:
        query = query.filter(Customer.updated_at > since)
    return [_serialize_customer(c) for c in query.order_by(Customer.name).all()]


def machine_catalog_for_sync(machine: POSMachine) -> Dict[str, Any]:
    """
    The till's catalog mode, sent whole on every pull — full or delta.

    Always sent rather than only when changed: it is one small object, and a till that
    missed a change (a delta after a restore, say) then corrects itself on the next
    pull of any kind. The product rows carry the list; this carries how to apply it.
    """
    ts = getattr(machine, "catalog_mode_updated_at", None)
    return {
        "mode": machine_catalog.mode_of(machine),
        "updatedAt": _aware_utc(ts).isoformat() if isinstance(ts, datetime) else None,
    }


def update_machine_sync_timestamp(db: Session, machine_id: str) -> None:
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine:
        machine.last_sync_at = datetime.now(timezone.utc)
        db.commit()


def update_machine_heartbeat(
    db: Session,
    machine_id: str,
    *,
    mqtt_connected: Optional[bool] = None,
    app_version: Optional[str] = None,
    serial_number: Optional[str] = None,
    battery_percent: Optional[int] = None,
    battery_status: Optional[str] = None,
    clock_skew_ms: Optional[int] = None,
    pending_count: Optional[int] = None,
    pending_documents: Optional[int] = None,
) -> None:
    """
    Record a heartbeat, plus whatever device health came with it.

    Every health argument is "None means the till did not say", so an older build
    that omits them leaves the last known values in place rather than wiping them.
    The one field that is deliberately allowed to *stay* null after a report is
    battery_percent — a device that reports "I could not read the battery" is not
    reporting 0%, and last_health_report_at is what tells the two apart.
    """
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        return

    now = datetime.now(timezone.utc)
    machine.last_heartbeat_at = now
    if mqtt_connected is not None:
        machine.mqtt_connected = mqtt_connected
    if app_version is not None:
        machine.app_version = app_version[:64] if app_version else None

    # Outbox depth, stamped so the dashboard can say how old the reading is. Written
    # together: a count without its timestamp cannot be told apart from a stale one, and
    # the status light leans on exactly that distinction when a terminal goes quiet.
    if pending_count is not None or pending_documents is not None:
        if pending_count is not None:
            machine.pending_count = pending_count
        if pending_documents is not None:
            machine.pending_documents = pending_documents
        machine.pending_count_at = now

    reported_health = False

    serial = normalize_serial_number(serial_number)
    if serial:
        # Refreshed from every heartbeat, not written once at pairing: a unit that
        # was swapped out on the counter must not keep reporting the old serial.
        machine.serial_number = serial
        reported_health = True
    if battery_percent is not None:
        machine.battery_percent = normalize_battery_percent(battery_percent)
        reported_health = True
    if battery_status is not None:
        machine.battery_status = normalize_battery_status(battery_status)
        reported_health = True
    if clock_skew_ms is not None:
        machine.clock_skew_ms = normalize_clock_skew_ms(clock_skew_ms)
        reported_health = True

    if reported_health:
        machine.last_health_report_at = now

    db.commit()


def update_machine_heartbeat_timestamp(db: Session, machine_id: str) -> None:
    """Backward-compatible alias."""
    update_machine_heartbeat(db, machine_id)


def get_catalog_change_watermark_for_machine(db: Session, machine: POSMachine) -> Optional[datetime]:
    """
    Best-effort watermark for the newest cloud-side catalog change that should be visible to this machine.
    Used to compute whether the machine's latest pull may be stale.
    """
    tid = _resolve_tenant_id_for_machine(db, machine)
    if not tid:
        return None

    tid_uuid = uuid_mod.UUID(str(tid)) if isinstance(tid, str) else tid
    points: List[datetime] = []

    # Customers ride the catalog payload, so a customer edit has to move the
    # watermark too — otherwise the till's last pull keeps looking fresh and the new
    # customer does not reach the counter until something unrelated changes.
    customer_max = (
        db.query(func.max(Customer.updated_at))
        .filter(Customer.tenant_id == tid_uuid)
        .scalar()
    )

    if machine.shop_id:
        product_max = (
            db.query(func.max(Product.updated_at))
            .join(ShopProductOverride, ShopProductOverride.global_product_id == Product.id)
            .filter(
                ShopProductOverride.shop_id == machine.shop_id,
                Product.tenant_id == tid_uuid,
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
                Category.tenant_id == tid_uuid,
                Category.catalog_level == CategoryCatalogLevel.GLOBAL,
                Category.pos_machine_id.is_(None),
            )
            .scalar()
        )
        voucher_max = (
            db.query(func.max(Voucher.updated_at))
            .filter(Voucher.tenant_id == tid_uuid)
            .scalar()
        )
        local_product_max = (
            db.query(func.max(Product.updated_at))
            .filter(Product.pos_machine_id == machine.id)
            .scalar()
        )
        # Availability set for the shop's own company, on products this shop sells —
        # the same company `_products_merged_for_shop_machine` reads, and only the rows
        # that can change what this till is sent.
        shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
        company_availability_max = (
            db.query(func.max(CompanyProductOverride.updated_at))
            .join(
                ShopProductOverride,
                and_(
                    ShopProductOverride.global_product_id == CompanyProductOverride.product_id,
                    ShopProductOverride.shop_id == machine.shop_id,
                ),
            )
            .filter(
                CompanyProductOverride.company_id
                == availability.company_level_company_id(shop)
            )
            .scalar()
        )
        machine_availability_max = (
            db.query(func.max(MachineProductOverride.updated_at))
            .filter(MachineProductOverride.machine_id == machine.id)
            .scalar()
        )
        # The area the till stands in, and when it moved there: either changes its
        # area level. No query for a till in no area.
        area_availability_max = None
        area_id = getattr(machine, "area_id", None)
        if area_id is not None:
            area_availability_max = (
                db.query(func.max(AreaProductOverride.updated_at))
                .filter(AreaProductOverride.area_id == area_id)
                .scalar()
            )
        moved = getattr(machine, "area_changed_at", None)
        # Category activity for this till's shop, area and itself.
        category_availability_max = category_availability.last_change(db, machine)
        # The till's own list and mode: a change to either changes what it shows.
        machine_catalog_max = machine_catalog.last_change(db, machine)
        # "אזל" / "חסום" anywhere in the shop or its company (app/services/sold_out.py).
        from app.models.sold_out import SoldOutMark

        blocks_max = (
            db.query(func.max(SoldOutMark.updated_at))
            .filter(
                (SoldOutMark.shop_id == machine.shop_id)
                | ((SoldOutMark.scope == "company") & (SoldOutMark.company_id == (shop.company_id if shop else None)))
            )
            .scalar()
        ) if sold_out.tables_ready(db) else None
        points.append(blocks_max)
        points.extend([
            product_max, override_max, category_max, voucher_max,
            local_product_max, customer_max,
            company_availability_max, area_availability_max, machine_availability_max,
            category_availability_max,
            moved if isinstance(moved, datetime) else None,
            machine_catalog_max,
        ])
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
        voucher_max = (
            db.query(func.max(Voucher.updated_at))
            .filter(Voucher.tenant_id == tid_uuid)
            .scalar()
        )
        points.extend([local_product_max, local_category_max, voucher_max, customer_max])

    # The menu block rides the catalog pull too (docs/SPEC_MENU_MODIFIERS.md §10.1).
    from app.services.menu import menu_changed_at

    points.append(menu_changed_at(db, tid_uuid))
    # And the "תפריטים" block (docs/SPEC_MENUS.md).
    from app.services.catalog_menus import changed_at as catalog_menus_changed_at

    points.append(catalog_menus_changed_at(db, tid_uuid))

    points = [p for p in points if p is not None]
    if not points:
        return None
    return max(_aware_utc(p) for p in points if p is not None)
