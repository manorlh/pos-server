"""
Groups ("קבוצות") on production voucher types and batches — the production vouchers contract §1/§2:
a package of 3 (three groups of one), "one of several" (groups of 0–1, a total of 1), a fixed
list as groups of one product. Each group selects products by product, by category (with its
sub-categories) or "everything", minus exclusions (exclusions win — the shared rules'
`eligible_products`, golden-pinned).

Storage (JSON on the type and the batch): [{key, name, minQty, maxQty, valueAgorot, allowRepeat,
allItems, productIds, categoryIds, includeSubcategories, excludeProductIds, excludeCategoryIds,
sortOrder}] — a batch's groups also carry `frozenProductIds`, the catalog expanded at issue
(`catalog_mode` frozen, the default). A voucher of a grouped batch keeps what is left per group
in `remaining` as {"g:<key>": units, "total": units}.

Redeeming groups goes through reserve → confirm (§3): the legacy `/redeem` never takes them.
"""
from __future__ import annotations

import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence

from fastapi import status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.shop import Shop
from app.services import production_voucher_rules as PR

GROUPS = "groups"
ITEMS = "items"
CATALOG_MODES = ("frozen", "live")
TOTAL = "total"
GROUPS_INVALID = "prepaid_voucher_groups_invalid"


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _attr(g: Any, name: str, alias: str, default=None):
    """A group's field, from the schema's object or a stored dict."""
    if isinstance(g, dict):
        return g.get(alias, g.get(name, default))
    return getattr(g, name, default)


def _ids(values: Optional[Iterable[Any]]) -> List[str]:
    out: List[str] = []
    for v in values or ():
        s = str(v).strip().lower()
        if s and s not in out:
            out.append(s)
    return out


def stored(groups: Optional[Sequence[Any]]) -> Optional[List[Dict[str, Any]]]:
    """The groups as the type / batch stores them: a key each, money in agorot, ids as strings."""
    if not groups:
        return None
    out: List[Dict[str, Any]] = []
    for n, g in enumerate(groups):
        value = _attr(g, "value", "value")
        agorot = _attr(g, "value_agorot", "valueAgorot")
        if agorot is None and value is not None:
            agorot = int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        key = (_attr(g, "key", "key") or "").strip() or uuid.uuid4().hex[:8]
        row = {
            "key": key,
            "name": (_attr(g, "name", "name") or "").strip(),
            "minQty": int(_attr(g, "min_qty", "minQty", 0) or 0),
            "maxQty": int(_attr(g, "max_qty", "maxQty", 1) or 1),
            "valueAgorot": int(agorot) if agorot is not None else None,
            "allowRepeat": bool(_attr(g, "allow_repeat", "allowRepeat", True)),
            "allItems": bool(_attr(g, "all_items", "allItems", False)),
            "productIds": _ids(_attr(g, "product_ids", "productIds")),
            "categoryIds": _ids(_attr(g, "category_ids", "categoryIds")),
            "includeSubcategories": bool(_attr(g, "include_subcategories", "includeSubcategories", True)),
            "excludeProductIds": _ids(_attr(g, "exclude_product_ids", "excludeProductIds")),
            "excludeCategoryIds": _ids(_attr(g, "exclude_category_ids", "excludeCategoryIds")),
            "sortOrder": int(_attr(g, "sort_order", "sortOrder", n) or n),
        }
        frozen = _attr(g, "frozen_product_ids", "frozenProductIds")
        if frozen is not None:
            row["frozenProductIds"] = _ids(frozen)
        out.append(row)
    out.sort(key=lambda r: (r["sortOrder"], r["name"]))
    keys = [r["key"] for r in out]
    if len(set(keys)) != len(keys):
        raise _pv()._http(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{GROUPS_INVALID}: each group's key once")
    return out


def out_shekels(groups: Optional[Sequence[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    """The groups as the dashboard reads them: the value in ₪, without the frozen expansion."""
    if not groups:
        return None
    return [
        {**{k: v for k, v in g.items() if k not in ("valueAgorot", "frozenProductIds")},
         "value": None if g.get("valueAgorot") is None else round(int(g["valueAgorot"]) / 100, 2)}
        for g in groups
    ]


def total_max(groups: Sequence[Dict[str, Any]], total_qty: Optional[int]) -> int:
    return int(total_qty) if total_qty else sum(int(g.get("maxQty") or 0) for g in groups)


def selection_of(g: Dict[str, Any]) -> PR.Selection:
    return PR.Selection(
        all_items=bool(g.get("allItems")),
        product_ids=tuple(g.get("productIds") or ()),
        category_ids=tuple(g.get("categoryIds") or ()),
        include_subcategories=bool(g.get("includeSubcategories", True)),
        exclude_product_ids=tuple(g.get("excludeProductIds") or ()),
        exclude_category_ids=tuple(g.get("excludeCategoryIds") or ()),
    )


def _catalog_products(db: Session, tenant_id, company_id, *columns):
    """
    The products a batch of [company_id] may name — (id, categoryId, *columns), in name order — the
    same products its picker lists (`GET /prepaid-vouchers/products`, unsearched):

    * the catalog products of the company's group (its parents and children);
    * the tenant-wide catalog products (no company — the business's general catalog). Leaving these
      out refused a group naming one with "unknown product" while the picker offered it (12.10.2026);
    * the products made on the tills (or in a shop) of the company's group, with no catalog product
      behind them.

    A till's local copy of a catalog product is the catalog product's, never another.
    """
    PV = _pv()
    related = [uuid.UUID(c) for c in PV._related_companies(db, company_id)] or [PV._as_uuid(company_id)]
    rows = [
        tuple(r)
        for r in db.query(Product.id, Product.category_id, Product.name, *columns)
        .filter(
            Product.tenant_id == tenant_id,
            Product.pos_machine_id.is_(None),
            or_(
                Product.company_id.in_(related),
                and_(Product.company_id.is_(None), Product.catalog_level == CatalogLevel.GLOBAL),
            ),
        )
        .all()
    ]
    seen = {r[0] for r in rows}
    group = PV._company_group(db, company_id)
    own = (
        db.query(Product.id, Product.category_id, Product.name, *columns, Product.pos_machine_id, Product.shop_id)
        .filter(
            Product.tenant_id == tenant_id,
            Product.catalog_level != CatalogLevel.GLOBAL,
            Product.global_product_id.is_(None),
        )
        .all()
    )
    if own:
        machine_ids = {r[-2] for r in own if r[-2] is not None}
        machine_shop = dict(
            db.query(POSMachine.id, POSMachine.shop_id).filter(POSMachine.id.in_(machine_ids)).all()
        ) if machine_ids else {}
        shop_ids = {machine_shop.get(r[-2]) if r[-2] is not None else r[-1] for r in own} - {None}
        shop_company = dict(
            db.query(Shop.id, Shop.company_id).filter(Shop.id.in_(shop_ids)).all()
        ) if shop_ids else {}
        for r in own:
            machine_id, shop_id = r[-2], r[-1]
            sid = machine_shop.get(machine_id) if machine_id is not None else shop_id
            if r[0] not in seen and sid is not None and str(shop_company.get(sid)) in group:
                seen.add(r[0])
                rows.append(tuple(r[:-2]))
    rows.sort(key=lambda r: ((r[2] or ""), str(r[0])))
    return [(r[0], r[1], *r[3:]) for r in rows]


def batch_products(db: Session, tenant_id, company_id) -> List[tuple]:
    """(id, categoryId) of every product a batch of [company_id] may name — `_catalog_products`."""
    return _catalog_products(db, tenant_id, company_id)


def _catalog(products, db: Session, tenant_id) -> PR.Catalog:
    categories = db.query(Category.id, Category.parent_id).filter(Category.tenant_id == tenant_id).all()
    return PR.Catalog(
        products=tuple((str(row[0]).lower(), str(row[1]).lower() if row[1] else None) for row in products),
        categories=tuple((str(c).lower(), str(p).lower() if p else None) for c, p in categories),
    )


def catalog_of(db: Session, tenant_id, company_id) -> PR.Catalog:
    """The batch's company catalog as the rules read it: its products (in name order) and the tenant's categories."""
    return _catalog(_catalog_products(db, tenant_id, company_id), db, tenant_id)


#: Warnings of the groups check (never refusals): a department with no active products in it, and a
#: group that takes no active product at all.
EMPTY_DEPARTMENT = "empty_department"
EMPTY_GROUP = "empty_group"
#: Overlaps listed at most (two "everything" groups overlap on the whole catalog); `overlapCount` says all.
MAX_OVERLAPS_LISTED = 100


def check(db: Session, user, tenant_id, company_id, shop_ids, groups: Sequence[Any]) -> Dict[str, Any]:
    """
    The groups of a type or batch being set up, against the catalog of the form's company — the
    dashboard's warnings next to a group (P:\\specs\\voucher-one-per-group.md §4), never a refusal:

    * `overlaps` — a product more than one group takes (departments expanded, exclusions applied,
      as `eligible_products` does at issue): at the till the cashier is asked which group it is
      for. [{productId, name, groups: [names], groupIndexes: [i]}], at most MAX_OVERLAPS_LISTED,
      and `overlapCount`;
    * `emptyGroups` — a chosen department with no active product in it (after the group's
      exclusions): {group, groupIndex, reason: "empty_department", categoryId, categoryName};
      a group that takes no active product at all, when no department already says why:
      {group, groupIndex, reason: "empty_group"}.

    An active product is one the catalog has and that is not marked unavailable. `groupIndex` is
    the group's place in the body (a new group has no key yet). Read only.
    """
    PV = _pv()
    from app.models.company import Company

    PV._require_role(user)
    company = db.query(Company).filter(Company.id == PV._as_uuid(company_id)).first()
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise PV._http(status.HTTP_404_NOT_FOUND, PV.COMPANY_NOT_FOUND)
    shops = PV._validate_shops(db, user, tenant_id, company.id, shop_ids)
    if not PV._covers_company(db, user, company.id) and not shops:
        raise PV._http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)

    rows = _catalog_products(db, tenant_id, company.id, Product.name, Product.is_available)
    catalog = _catalog(rows, db, tenant_id)
    names = {str(r[0]).lower(): r[2] for r in rows}
    active = {str(r[0]).lower() for r in rows if r[3] is not False}
    selections = [
        selection_of({
            "allItems": _attr(g, "all_items", "allItems", False),
            "productIds": _ids(_attr(g, "product_ids", "productIds")),
            "categoryIds": _ids(_attr(g, "category_ids", "categoryIds")),
            "includeSubcategories": _attr(g, "include_subcategories", "includeSubcategories", True),
            "excludeProductIds": _ids(_attr(g, "exclude_product_ids", "excludeProductIds")),
            "excludeCategoryIds": _ids(_attr(g, "exclude_category_ids", "excludeCategoryIds")),
        })
        for g in groups
    ]
    group_names = [(_attr(g, "name", "name") or "").strip() for g in groups]
    taken = [PR.eligible_products(s, catalog) for s in selections]

    by_product: Dict[str, List[int]] = {}
    for i, ids in enumerate(taken):
        for pid in ids:
            by_product.setdefault(pid, []).append(i)
    overlapping = [(pid, idx) for pid, idx in by_product.items() if len(idx) > 1]
    order = {pid: n for n, (pid, *_rest) in enumerate(catalog.products)}
    overlapping.sort(key=lambda o: order.get(o[0], 0))
    overlaps = [
        {"productId": pid, "name": names.get(pid), "groups": [group_names[i] for i in idx], "groupIndexes": idx}
        for pid, idx in overlapping[:MAX_OVERLAPS_LISTED]
    ]

    wanted_categories = {c for s in selections for c in s.category_ids}
    category_names = {}
    if wanted_categories:
        cids = [u for u in (PV._as_uuid(c) for c in wanted_categories) if u is not None]
        category_names = {
            str(i).lower(): n
            for i, n in db.query(Category.id, Category.name).filter(Category.tenant_id == tenant_id, Category.id.in_(cids))
        } if cids else {}
    empty: List[Dict[str, Any]] = []
    for i, s in enumerate(selections):
        said = False
        if not s.all_items:
            for cid in s.category_ids:
                one = PR.Selection(
                    category_ids=(cid,), include_subcategories=s.include_subcategories,
                    exclude_product_ids=s.exclude_product_ids, exclude_category_ids=s.exclude_category_ids,
                )
                if not any(p in active for p in PR.eligible_products(one, catalog)):
                    empty.append({"group": group_names[i], "groupIndex": i, "reason": EMPTY_DEPARTMENT,
                                  "categoryId": cid, "categoryName": category_names.get(cid)})
                    said = True
        if not said and not any(p in active for p in taken[i]):
            empty.append({"group": group_names[i], "groupIndex": i, "reason": EMPTY_GROUP})
    return {"overlaps": overlaps, "overlapCount": len(overlapping), "emptyGroups": empty}


def validate(db: Session, tenant_id, company_id, groups: Optional[Sequence[Dict[str, Any]]]) -> None:
    """Every product and category a group names is this tenant's (the company's catalog for products)."""
    if not groups:
        return
    catalog = catalog_of(db, tenant_id, company_id)
    known_products = {p for p, _ in catalog.products}
    known_categories = {c for c, _ in catalog.categories}
    for g in groups:
        if not (g.get("allItems") or g.get("productIds") or g.get("categoryIds")):
            raise _pv()._http(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{GROUPS_INVALID}: {g.get('name')}: nothing chosen")
        for pid in list(g.get("productIds") or []) + list(g.get("excludeProductIds") or []):
            if pid not in known_products:
                raise _pv()._http(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{GROUPS_INVALID}: unknown product {pid}")
        for cid in list(g.get("categoryIds") or []) + list(g.get("excludeCategoryIds") or []):
            if cid not in known_categories:
                raise _pv()._http(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{GROUPS_INVALID}: unknown category {cid}")


def freeze(db: Session, tenant_id, company_id, groups: Optional[Sequence[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    """A batch's groups with the catalog expanded now (`frozenProductIds`): what `frozen` redeems."""
    if not groups:
        return None
    catalog = catalog_of(db, tenant_id, company_id)
    return [{**g, "frozenProductIds": PR.eligible_products(selection_of(g), catalog)} for g in groups]


def names(db: Session, tenant_id, groups: Optional[Sequence[Dict[str, Any]]]) -> Optional[Dict[str, Dict[str, str]]]:
    """
    The names of the products and categories [groups] name, chosen and excluded — for the dashboard
    only (the editor's chips and "סיכום השובר": "עד 50 פריטים מתוך 'אוכל'"). Read only; None without groups.
    """
    if not groups:
        return None
    product_ids: set = set()
    category_ids: set = set()
    for g in groups:
        product_ids |= set(g.get("productIds") or []) | set(g.get("excludeProductIds") or [])
        category_ids |= set(g.get("categoryIds") or []) | set(g.get("excludeCategoryIds") or [])

    def uuids(values):
        out = []
        for v in values:
            try:
                out.append(uuid.UUID(str(v)))
            except ValueError:
                continue
        return out

    pids, cids = uuids(product_ids), uuids(category_ids)
    products = {
        str(i).lower(): n
        for i, n in db.query(Product.id, Product.name).filter(Product.tenant_id == tenant_id, Product.id.in_(pids))
    } if pids else {}
    categories = {
        str(i).lower(): n
        for i, n in db.query(Category.id, Category.name).filter(Category.tenant_id == tenant_id, Category.id.in_(cids))
    } if cids else {}
    return {"products": products, "categories": categories}


def initial_remaining(groups: Sequence[Dict[str, Any]], total_qty: Optional[int]) -> Dict[str, int]:
    out = {f"g:{g['key']}": int(g.get("maxQty") or 0) for g in groups}
    out[TOTAL] = total_max(groups, total_qty)
    return out


def remaining_of(voucher, groups: Sequence[Dict[str, Any]], total_qty: Optional[int]) -> Dict[str, int]:
    """Per group key what is left on [voucher], and "total"."""
    rem = voucher.remaining or {}
    out = {g["key"]: int(Decimal(str(rem.get(f"g:{g['key']}", g.get("maxQty") or 0)))) for g in groups}
    out[TOTAL] = int(Decimal(str(rem.get(TOTAL, total_max(groups, total_qty)))))
    return out


def eligible(db: Session, batch, g: Dict[str, Any], catalog: Optional[PR.Catalog] = None) -> List[str]:
    """The products a group takes now: the frozen list (still in the catalog), or `live` the catalog of now."""
    catalog = catalog or catalog_of(db, batch.tenant_id, batch.company_id)
    mode = getattr(batch, "catalog_mode", None) or "frozen"
    return PR.eligible_now(mode, g.get("frozenProductIds") or [], selection_of(g), catalog)


def till_view(db: Session, machine, batch, voucher) -> Dict[str, Any]:
    """Lookup's groups block (§2): each group with what is left and its products, the till's ids included."""
    groups = list(getattr(batch, "groups", None) or [])
    if (getattr(batch, "selection", None) or ITEMS) != GROUPS or not groups:
        return {"selection": ITEMS}
    PV = _pv()
    catalog = catalog_of(db, batch.tenant_id, batch.company_id)
    left = remaining_of(voucher, groups, batch.total_qty)
    category_ids = {c for g in groups for c in (g.get("categoryIds") or [])}
    cids = [u for u in (PV._as_uuid(c) for c in category_ids) if u is not None]
    category_names = {
        str(i).lower(): n
        for i, n in db.query(Category.id, Category.name).filter(Category.tenant_id == batch.tenant_id, Category.id.in_(cids))
    } if cids else {}
    out_groups = []
    for g in groups:
        ids = eligible(db, batch, g, catalog)
        till = PV._till_products(db, machine, ids)
        both: List[str] = []
        for pid in ids:
            both.append(pid)
            copy = (till.get(pid) or {}).get("tillProductId")
            if copy and str(copy).lower() != pid:
                both.append(str(copy).lower())
        quota = int(g.get("maxQty", 1) or 0)
        remaining = left.get(g["key"], 0)
        out_groups.append({
            "key": g["key"], "name": g.get("name"), "minQty": g.get("minQty", 0), "maxQty": g.get("maxQty", 1),
            "remaining": remaining, "valueAgorot": g.get("valueAgorot"),
            "allowRepeat": bool(g.get("allowRepeat", True)), "productIds": both,
            # The same list under the name the voucher-first picker reads (the owner's spec of
            # 11.10.2026 §3): the group's products as the reserve takes them — `eligible`, the
            # frozen list or the live catalog by `catalogMode` — the cloud's ids and the till's own.
            "eligibleProductIds": both,
            # "מכסה 5 | מומשו 2 | נותרו 3" per group: units, from the voucher's own `remaining`.
            "quota": quota,
            "used": max(0, quota - int(remaining)),
            "excludedIds": list(g.get("excludeProductIds") or []),
            # What the group was set up with, for the cashier's "מה מגיע ללקוח" card (the owner,
            # 13.10.2026): a whole department is said "מחלקת משקאות", not its products. Additive.
            "allItems": bool(g.get("allItems")),
            "categoryIds": list(g.get("categoryIds") or []),
            "categories": [{"id": c, "name": category_names.get(c)} for c in (g.get("categoryIds") or [])],
            "includeSubcategories": bool(g.get("includeSubcategories", True)),
        })
    total = total_max(groups, batch.total_qty)
    return {
        "selection": GROUPS,
        "groups": out_groups,
        "totalMax": total,
        "totalRemaining": left[TOTAL],
        "unitsLeft": left[TOTAL],
        "catalogMode": getattr(batch, "catalog_mode", None) or "frozen",
    }
