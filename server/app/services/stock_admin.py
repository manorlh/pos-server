"""
The dashboard's stock work over the locations (app/services/stock_locations.py): the hierarchy picker,
the quick stock screen (view, +/−, count, receive, transfer), "אופן ניהול מלאי" with its switch
wizard, and the opening stock. Routes: app/routers/stock_live.py. Permissions: stock_scope.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.kiosk import KioskDevice
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.stock_level import StockLevel
from app.models.stock_movement import StockMovementReason
from app.models.stock_setting import StockLevelSetting
from app.services import stock as stock_service
from app.services import stock_locations as L
from app.services import stock_scope
from app.services.stock_locations import LEVEL_LABELS, Location, Path


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _dec(value: Any) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal("0")


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


# ── The hierarchy under a node ───────────────────────────────────────────────


def shops_under(db: Session, path: Path) -> List[Shop]:
    if path.node_level == "company":
        return db.query(Shop).filter(Shop.company_id == path.company_id).order_by(Shop.name).all()
    shop = db.get(Shop, path.shop_id) if path.shop_id else None
    return [shop] if shop is not None else []


def tree(db: Session, user: Any, tenant_id: Any, path: Path) -> Dict[str, Any]:
    """The picker: the node's shops, their points of sale and devices, as far as the user reaches."""
    scope = stock_scope.scope_of(db, user)
    shops = shops_under(db, path)
    out_shops = []
    for shop in shops:
        if not stock_scope.may(db, user, Path(company_id=shop.company_id, shop_id=shop.id, node_level="shop"), tenant_id) and not scope.narrowed:
            continue
        areas = (
            db.query(ShopArea)
            .filter(ShopArea.shop_id == shop.id, ShopArea.archived_at.is_(None))
            .order_by(ShopArea.sort_order, ShopArea.name)
            .all()
        )
        machines = (
            db.query(POSMachine)
            .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
            .order_by(POSMachine.pos_number, POSMachine.name)
            .all()
        )
        machines = [m for m in machines if getattr(m, "is_fiscal", True) is not False]
        kiosks = {
            r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id.in_([m.id for m in machines])).all()
        } if machines else set()

        def area_ok(a: ShopArea) -> bool:
            return scope.covers_path(Path(company_id=shop.company_id, shop_id=shop.id, area_id=a.id, node_level="area"))

        def machine_ok(m: POSMachine) -> bool:
            return scope.covers_path(Path(company_id=shop.company_id, shop_id=shop.id, area_id=m.area_id, machine_id=m.id, node_level="machine"))

        visible_areas = [a for a in areas if area_ok(a)]
        visible_machines = [m for m in machines if machine_ok(m)]
        if scope.narrowed and not visible_areas and not visible_machines:
            continue
        out_shops.append({
            "id": str(shop.id),
            "name": shop.name,
            "manageable": not scope.narrowed,
            "areas": [{"id": str(a.id), "name": a.name} for a in visible_areas],
            "machines": [
                {"id": str(m.id), "name": m.name, "posNumber": m.pos_number, "areaId": str(m.area_id) if m.area_id else None, "isKiosk": m.id in kiosks}
                for m in visible_machines
            ],
        })
    company = db.get(Company, path.company_id) if path.company_id else None
    return {
        "company": {"id": str(company.id), "name": company.name} if company is not None and not scope.narrowed else None,
        "shops": out_shops,
        "groupsAvailable": False,
        "narrowed": scope.narrowed,
    }


def _locations_under(db: Session, path: Path, shops: Sequence[Shop]) -> List[Tuple[Location, Path]]:
    """Every location at or under the node (company → shops → areas → devices)."""
    out: List[Tuple[Location, Path]] = []
    if path.node_level == "company" and path.company_id is not None:
        out.append((Location("company", path.company_id), Path(company_id=path.company_id, node_level="company")))
    for shop in shops:
        sp = Path(company_id=shop.company_id, shop_id=shop.id, node_level="shop")
        if path.node_level in ("company", "shop"):
            out.append((Location("shop", shop.id), sp))
        areas = db.query(ShopArea).filter(ShopArea.shop_id == shop.id).all()
        for a in areas:
            if path.node_level in ("company", "shop") or (path.node_level == "area" and a.id == path.area_id):
                out.append((Location("area", a.id), Path(company_id=shop.company_id, shop_id=shop.id, area_id=a.id, node_level="area")))
        machines = db.query(POSMachine).filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True)).all()
        for m in machines:
            inside = (
                path.node_level in ("company", "shop")
                or (path.node_level == "area" and m.area_id == path.area_id)
                or (path.node_level == "machine" and m.id == path.machine_id)
            )
            if inside:
                out.append((Location("machine", m.id), Path(company_id=shop.company_id, shop_id=shop.id, area_id=m.area_id, machine_id=m.id, node_level="machine")))
    return out


def _products(
    db: Session, shops: Sequence[Shop], *, category_id: Any = None, q: Optional[str] = None, product_id: Any = None, limit: int = 400,
) -> List[Product]:
    if not shops:
        return []
    query = (
        db.query(Product)
        .join(ShopProductOverride, ShopProductOverride.global_product_id == Product.id)
        .filter(
            ShopProductOverride.shop_id.in_([s.id for s in shops]),
            Product.track_stock.is_(True),
            Product.pos_machine_id.is_(None),
        )
        .distinct()
    )
    if category_id is not None:
        query = query.filter(Product.category_id == category_id)
    if product_id is not None:
        query = query.filter(Product.id == product_id)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(or_(Product.name.ilike(like), Product.sku.ilike(like), Product.barcode.ilike(like)))
    return query.order_by(Product.name).limit(limit).all()


def quick_view(
    db: Session,
    user: Any,
    tenant_id: Any,
    path: Path,
    *,
    category_id: Any = None,
    q: Optional[str] = None,
    product_id: Any = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Each tracked product sold under the node: the total (the node's own location and every managed
    location under it), each location with its quantity and low flag, where an update chosen here
    goes, the blocks in force, and what a device here sees ("אזל" / "חסום", the shared rule).
    """
    from app.services import sold_out
    from app.services import sold_out_rules as rules

    now = now or utc_now()
    scope = stock_scope.scope_of(db, user)
    shops = shops_under(db, path)
    products = _products(db, shops, category_id=category_id, q=q, product_id=product_id)
    locations = [(loc, p) for loc, p in _locations_under(db, path, shops) if scope.covers_path(p)]
    ids = [p.id for p in products]
    clauses = [and_(StockLevel.level == loc.level, StockLevel.target_id == loc.target_id) for loc, _ in locations]
    levels = (
        db.query(StockLevel).filter(or_(*clauses), StockLevel.product_id.in_(ids)).all()
        if ids and clauses else []
    )
    by_key = {(l.level, str(l.target_id), l.product_id): l for l in levels}
    book = L.RuleBook(db, company_ids={s.company_id for s in shops} | ({path.company_id} if path.company_id else set()), shop_ids=[s.id for s in shops])
    names: Dict[str, Optional[str]] = {}
    blocks = sold_out.list_blocks(
        db, tenant_id=tenant_id, shop_ids=[s.id for s in shops], company_ids=[s.company_id for s in shops if s.company_id],
    ) if sold_out.tables_ready(db) else []
    blocks_by_product: Dict[str, List[Dict[str, Any]]] = {}
    for b in blocks:
        blocks_by_product.setdefault(b["productId"], []).append(b)
    setting_on = sold_out.auto_setting_on(db, path.shop_id) if path.shop_id else True

    rows = []
    for p in products:
        out_locs = []
        total = Decimal("0")
        for loc, lpath in locations:
            managed = book.managed(company_id=lpath.company_id, shop_id=lpath.shop_id, product=p)
            is_managed = loc.level in managed
            row = by_key.get((loc.level, str(loc.target_id), p.id))
            if not is_managed and (row is None or _dec(row.quantity) == 0):
                continue
            qty = _dec(row.quantity) if row is not None else Decimal("0")
            if is_managed:
                total += qty
            if loc.key not in names:
                names[loc.key] = L.location_name(db, loc)
            out_locs.append({
                **loc.out(),
                "name": names[loc.key],
                "levelLabel": LEVEL_LABELS.get(loc.level, loc.level),
                "quantity": float(qty),
                "managed": is_managed,
                "reorderMin": row.reorder_min if row is not None else None,
                "low": is_managed and stock_service.is_low(qty, row.reorder_min if row is not None else None),
                "openingQuantity": float(row.opening_quantity) if row is not None and row.opening_quantity is not None else None,
                "dailyReset": bool(row.daily_reset) if row is not None else False,
                "resetMode": (row.reset_mode if row is not None else "set") or "set",
            })
        managed_here = book.managed(company_id=path.company_id, shop_id=path.shop_id, product=p)
        try:
            target = L.update_location(path, managed_here)
            target_out = {**target.out(), "name": L.location_name(db, target), "levelLabel": LEVEL_LABELS.get(target.level, target.level)}
        except L.NotManaged:
            target_out = None
        own = by_key.get((target.level, str(target.target_id), p.id)) if target_out else None
        p_blocks = blocks_by_product.get(str(p.id), [])
        seen = None
        if path.node_level in ("shop", "area", "machine"):
            till = rules.Till(
                company_id=str(path.company_id) if path.company_id else None, shop_id=str(path.shop_id),
                area_id=str(path.area_id) if path.area_id else None,
                machine_id=str(path.machine_id) if path.machine_id else None,
            )
            sell = L.sell_from(path, managed_here) if path.node_level == "machine" else (target if target_out else None)
            sell_row = by_key.get((sell.level, str(sell.target_id), p.id)) if sell is not None else None
            decision = rules.decide(
                [b for b in p_blocks if b["scope"] not in ("kiosk", "kiosks")], now, till=till,
                setting=None if setting_on else False, track_stock=True,
                stock=float(sell_row.quantity) if sell_row is not None else 0.0,
            )
            seen = {"state": decision.state, "reason": decision.reason}
        rows.append({
            "productId": str(p.id),
            "productName": p.name,
            "sku": p.sku,
            "barcode": p.barcode,
            "imageUrl": p.image_url,
            "categoryId": str(p.category_id) if p.category_id else None,
            "managedLevels": list(managed_here),
            "total": float(total),
            "updateTarget": target_out,
            "quantityAtTarget": float(own.quantity) if own is not None else (0.0 if target_out else None),
            "low": any(l["low"] for l in out_locs),
            "locations": out_locs,
            "blocks": p_blocks,
            "devicesSee": seen,
        })
    rows.sort(key=lambda r: (not (r["low"] or bool(r["blocks"])), r["productName"] or ""))
    return {
        "node": {"level": path.node_level, "companyId": str(path.company_id) if path.company_id else None,
                 "shopId": str(path.shop_id) if path.shop_id else None,
                 "areaId": str(path.area_id) if path.area_id else None,
                 "machineId": str(path.machine_id) if path.machine_id else None},
        "rows": rows,
        "serverTime": now.isoformat(),
    }


# ── Updating ─────────────────────────────────────────────────────────────────

UPDATE_OPS = ("add", "remove", "count", "receive", "wastage")


def update(
    db: Session,
    user: Any,
    tenant_id: Any,
    path: Path,
    *,
    product_id: Any,
    op: str,
    quantity: Decimal,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    """
    +/− ("add" / "remove" / "wastage"), "count" (set to) or "receive" at the node: the location it
    goes to is the node's own when it holds stock, else the nearest managed one above (said in the
    answer). A user scoped to points of sale must stay inside them. The caller commits.
    """
    from app.services import sold_out

    if op not in UPDATE_OPS:
        raise _bad("invalid_op", "פעולה לא מוכרת")
    product = sold_out.global_product(db, product_id, tenant_id)
    managed = L.managed_for(db, path, product)
    try:
        loc = L.update_location(path, managed)
    except L.NotManaged as e:
        raise _bad(e.code, e.message)
    stock_scope.check_location(db, user, loc, tenant_id)
    quantity = _dec(quantity)
    if op != "count" and quantity <= 0:
        raise _bad("quantity_must_be_positive", "הכמות חייבת להיות גדולה מאפס")
    if op == "count" and quantity < 0:
        raise _bad("quantity_negative", "ספירה לא יכולה להיות שלילית")
    who = getattr(user, "id", None)
    if op == "count":
        stock_service.set_quantity(
            db, tenant_id=tenant_id, shop_id=None, product_id=product.id, target_quantity=quantity,
            created_by_user_id=who, note=note or "ספירה", location=loc,
        )
    else:
        delta = quantity if op in ("add", "receive") else -quantity
        reason = {
            "add": StockMovementReason.ADJUSTMENT, "remove": StockMovementReason.ADJUSTMENT,
            "wastage": StockMovementReason.WASTAGE, "receive": StockMovementReason.GOODS_RECEIPT,
        }[op]
        stock_service.apply_movement(
            db, movement_id=uuid.uuid4(), tenant_id=tenant_id, shop_id=None, product_id=product.id, delta=delta,
            reason=reason, occurred_at=utc_now(), created_by_user_id=who, note=note, location=loc,
        )
    db.flush()
    row = stock_service.level_at(db, loc, product.id)
    return {
        "location": {**loc.out(), "name": L.location_name(db, loc), "levelLabel": LEVEL_LABELS.get(loc.level, loc.level)},
        "redirected": loc != path.node,
        "quantity": float(row.quantity) if row is not None else 0.0,
        "productId": str(product.id),
    }


def transfer(
    db: Session,
    user: Any,
    tenant_id: Any,
    *,
    product_id: Any,
    source: Location,
    target: Location,
    quantity: Decimal,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    """Between two managed locations — up, down or across. The user must cover one side (theirs). The caller commits."""
    from app.services import sold_out

    product = sold_out.global_product(db, product_id, tenant_id)
    s_path = _path_or_404(db, source)
    t_path = _path_or_404(db, target)
    for loc, p in ((source, s_path), (target, t_path)):
        if loc.level not in L.managed_for(db, p, product):
            raise _bad("not_managed_here", f"ב{LEVEL_LABELS.get(loc.level, loc.level)} הזה לא מנוהל מלאי למוצר")
    if not (stock_scope.may(db, user, s_path, tenant_id) or stock_scope.may(db, user, t_path, tenant_id)):
        raise HTTPException(status_code=403, detail="outside_your_points_of_sale")
    # Both sides in the user's org (a narrowed user may move between their area and the store above it).
    for p in (s_path, t_path):
        _check_org(db, user, p, tenant_id)
    try:
        transfer_id = stock_service.transfer(
            db, tenant_id=tenant_id, product_id=product.id, quantity=_dec(quantity), source=source, target=target,
            created_by_user_id=getattr(user, "id", None), note=note,
        )
    except ValueError as e:
        raise _bad(str(e), {"quantity_must_be_positive": "הכמות חייבת להיות גדולה מאפס", "same_location": "אותו מיקום"}.get(str(e), str(e)))
    return {
        "transferId": str(transfer_id),
        "from": {**source.out(), "quantity": float(stock_service.quantity_at(db, source, product.id))},
        "to": {**target.out(), "quantity": float(stock_service.quantity_at(db, target, product.id))},
    }


def _check_org(db: Session, user: Any, path: Path, tenant_id: Any) -> None:
    """The role and org scope only (not the points-of-sale narrowing)."""
    from app.services import kiosk_control

    if path.node_level == "company":
        kiosk_control.check_company_scope(db, user, db.get(Company, path.company_id), tenant_id)
    else:
        shop = db.get(Shop, path.shop_id) if path.shop_id else None
        if shop is None:
            raise HTTPException(status_code=404, detail="Shop not found")
        kiosk_control.check_shop_scope(db, user, shop, tenant_id)


def _path_or_404(db: Session, loc: Location) -> Path:
    try:
        return L.location_path(db, loc)
    except LookupError:
        raise HTTPException(status_code=404, detail="location_not_found")


# ── "אופן ניהול מלאי" and its switch wizard ───────────────────────────────────


def rules_view(db: Session, scope_level: str, scope_id: Any) -> Dict[str, Any]:
    rows = (
        db.query(StockLevelSetting)
        .filter(StockLevelSetting.scope_level == scope_level, StockLevelSetting.scope_id == scope_id)
        .all()
    )
    names: Dict[str, Optional[str]] = {}
    out = []
    for r in rows:
        item_name = None
        if r.item_kind == "product" and r.item_id:
            p = db.get(Product, r.item_id)
            item_name = p.name if p else None
        elif r.item_kind == "category" and r.item_id:
            from app.models.category import Category

            c = db.get(Category, r.item_id)
            item_name = c.name if c else None
        out.append({
            "id": str(r.id), "itemKind": r.item_kind, "itemId": str(r.item_id) if r.item_id else None,
            "itemName": item_name, "levels": list(L._safe_levels(r.levels)),
            "updatedAt": r.updated_at.isoformat() if r.updated_at else None,
        })
    return {"scopeLevel": scope_level, "scopeId": str(scope_id), "rules": out, "default": list(L.DEFAULT_LEVELS), "levels": list(L.LEVELS)}


def _affected(db: Session, scope_level: str, scope_id: Any, item_kind: Optional[str], item_id: Any) -> Tuple[List[Shop], List[Product]]:
    shops = (
        db.query(Shop).filter(Shop.company_id == scope_id).all() if scope_level == "company"
        else [s for s in [db.get(Shop, scope_id)] if s is not None]
    )
    products = _products(db, shops, limit=5000)
    if item_kind == "product":
        products = [p for p in products if str(p.id) == str(item_id)]
    elif item_kind == "category":
        products = [p for p in products if str(p.category_id) == str(item_id)]
    return shops, products


def preview_switch(
    db: Session, *, scope_level: str, scope_id: Any, item_kind: Optional[str], item_id: Any, levels: Sequence[str],
) -> Dict[str, Any]:
    """
    What switching to `levels` means, before anything moves: per product, the locations newly managed
    (they start at 0 unless an opening count or a transfer fills them), and the stock left in
    locations no longer managed (it must be transferred, or written off explicitly).
    """
    new_levels = L.normalize_levels(list(levels))
    shops, products = _affected(db, scope_level, scope_id, item_kind, item_id)
    book = L.RuleBook(db, company_ids={s.company_id for s in shops} | ({scope_id} if scope_level == "company" else set()), shop_ids=[s.id for s in shops])
    newly: List[Dict[str, Any]] = []
    stranded: List[Dict[str, Any]] = []
    names: Dict[str, Optional[str]] = {}
    seen: Set[Tuple[str, str, str]] = set()

    def note(target: List[Dict[str, Any]], p: Product, loc: Location, qty: Decimal) -> None:
        key = (str(p.id), loc.level, str(loc.target_id))
        if key in seen:
            return
        seen.add(key)
        if loc.key not in names:
            names[loc.key] = L.location_name(db, loc)
        target.append({
            "productId": str(p.id), "productName": p.name, "quantity": float(qty),
            "location": {**loc.out(), "name": names[loc.key], "levelLabel": LEVEL_LABELS.get(loc.level, loc.level)},
        })

    for shop in shops:
        locs = [loc for loc, _ in _locations_under(db, Path(company_id=shop.company_id, shop_id=shop.id, node_level="shop"), [shop])]
        if scope_level == "company":
            locs = [Location("company", scope_id)] + locs
        for p in products:
            old = book.managed(company_id=shop.company_id, shop_id=shop.id, product=p)
            for loc in locs:
                row = stock_service.level_at(db, loc, p.id)
                qty = _dec(row.quantity) if row is not None else Decimal("0")
                if loc.level in new_levels and loc.level not in old:
                    note(newly, p, loc, qty)
                elif loc.level not in new_levels and qty != 0:
                    note(stranded, p, loc, qty)
    return {"levels": list(new_levels), "products": len(products), "newlyManaged": newly, "stranded": stranded}


def apply_switch(
    db: Session,
    user: Any,
    tenant_id: Any,
    *,
    scope_level: str,
    scope_id: Any,
    item_kind: Optional[str],
    item_id: Any,
    levels: Sequence[str],
    openings: Iterable[Dict[str, Any]] = (),
    transfers: Iterable[Dict[str, Any]] = (),
    write_off: bool = False,
    openings_confirmed: bool = False,
) -> Dict[str, Any]:
    """
    The wizard's "apply": the openings and transfers the owner entered, the new setting, and a check
    that nothing is left in a location no longer managed (409 `stock_left_outside` with the list,
    unless `write_off` — then an explicit adjustment to 0 per location). Newly managed locations
    without an opening or a transfer need `openings_confirmed` (they start at 0). Never moves
    anything silently. The caller commits (a refusal rolls back).
    """
    new_levels = L.normalize_levels(list(levels))
    who = getattr(user, "id", None)
    preview = preview_switch(db, scope_level=scope_level, scope_id=scope_id, item_kind=item_kind, item_id=item_id, levels=new_levels)
    filled: Set[Tuple[str, str, str]] = set()
    for o in openings:
        loc = Location(o["level"], uuid.UUID(str(o["targetId"])))
        stock_service.set_quantity(
            db, tenant_id=tenant_id, shop_id=None, product_id=uuid.UUID(str(o["productId"])),
            target_quantity=_dec(o["quantity"]), created_by_user_id=who, note="ספירת פתיחה — החלפת אופן ניהול מלאי",
            location=loc,
        )
        filled.add((str(o["productId"]), loc.level, str(loc.target_id)))
    for t in transfers:
        src = Location(t["from"]["level"], uuid.UUID(str(t["from"]["targetId"])))
        dst = Location(t["to"]["level"], uuid.UUID(str(t["to"]["targetId"])))
        stock_service.transfer(
            db, tenant_id=tenant_id, product_id=uuid.UUID(str(t["productId"])), quantity=_dec(t["quantity"]),
            source=src, target=dst, created_by_user_id=who, note="העברה — החלפת אופן ניהול מלאי",
        )
        filled.add((str(t["productId"]), dst.level, str(dst.target_id)))
    unfilled = [n for n in preview["newlyManaged"] if (n["productId"], n["location"]["level"], n["location"]["targetId"]) not in filled]
    if unfilled and not openings_confirmed:
        raise HTTPException(status_code=409, detail={
            "code": "openings_required",
            "message": "למיקומים החדשים נדרשת ספירת פתיחה או העברה (או אישור שהם מתחילים מ-0)",
            "locations": unfilled,
        })
    db.flush()
    after = preview_switch(db, scope_level=scope_level, scope_id=scope_id, item_kind=item_kind, item_id=item_id, levels=new_levels)
    if after["stranded"]:
        if not write_off:
            raise HTTPException(status_code=409, detail={
                "code": "stock_left_outside",
                "message": "נשאר מלאי במיקומים שלא ינוהלו יותר — העבירו אותו או אשרו מחיקה",
                "locations": after["stranded"],
            })
        for s in after["stranded"]:
            loc = Location(s["location"]["level"], uuid.UUID(s["location"]["targetId"]))
            stock_service.set_quantity(
                db, tenant_id=tenant_id, shop_id=None, product_id=uuid.UUID(s["productId"]), target_quantity=Decimal("0"),
                created_by_user_id=who, note="מחיקה מאושרת — החלפת אופן ניהול מלאי", location=loc,
                reason=StockMovementReason.ADJUSTMENT,
            )
    key = L.rule_key(scope_level, scope_id, item_kind, item_id)
    row = db.query(StockLevelSetting).filter(StockLevelSetting.rule_key == key).first()
    if row is None:
        row = StockLevelSetting(
            id=uuid.uuid4(), tenant_id=tenant_id, scope_level=scope_level, scope_id=scope_id,
            item_kind=item_kind, item_id=item_id, rule_key=key,
        )
        db.add(row)
    row.levels = list(new_levels)
    row.updated_by_user_id = who
    row.updated_at = utc_now()
    db.flush()
    # Every till of the scope pulls its stock again: what it sells from may have moved.
    shops, _ = _affected(db, scope_level, scope_id, None, None)
    for shop in shops:
        stock_service._wake_on_crossing(db, Location("shop", shop.id), None)
    return {"levels": list(new_levels), "openings": len(list(filled)), "writtenOff": len(after["stranded"]) if write_off else 0}


# ── Opening stock ────────────────────────────────────────────────────────────


def _reorder_min(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        n = Decimal(str(value))
    except (ArithmeticError, ValueError):
        raise _bad("invalid_reorder_min", "מינימום להתראה: מספר שלם, 0 ומעלה")
    if not n.is_finite() or n < 0 or n != n.to_integral_value():
        raise _bad("invalid_reorder_min", "מינימום להתראה: מספר שלם, 0 ומעלה")
    return int(n)


def set_opening(
    db: Session,
    user: Any,
    tenant_id: Any,
    loc: Location,
    items: Iterable[Dict[str, Any]],
) -> int:
    """
    "מלאי פתיחה" per product at a location: opening quantity, daily reset on/off, its mode, and the
    reorder minimum the low-stock alert compares with (a whole number; null: none). The caller commits.
    """
    from app.services import stock_reset

    path = stock_scope.check_location(db, user, loc, tenant_id)
    n = 0
    switched_on = False
    reevaluate: List[StockLevel] = []
    for it in items:
        product = db.get(Product, uuid.UUID(str(it["productId"])))
        if product is None:
            continue
        row = stock_service.level_at(db, loc, product.id)
        if row is None:
            row = StockLevel(
                tenant_id=tenant_id, company_id=path.company_id, shop_id=path.shop_id, level=loc.level,
                target_id=loc.target_id, product_id=product.id, quantity=Decimal("0"),
            )
            db.add(row)
        if "openingQuantity" in it:
            row.opening_quantity = None if it["openingQuantity"] is None else _dec(it["openingQuantity"])
        if "dailyReset" in it and it["dailyReset"] is not None:
            switched_on = switched_on or (bool(it["dailyReset"]) and not row.daily_reset)
            row.daily_reset = bool(it["dailyReset"])
        if it.get("resetMode") in stock_reset.MODES:
            row.reset_mode = it["resetMode"]
        if "reorderMin" in it:
            new_min = _reorder_min(it["reorderMin"])
            if new_min != row.reorder_min:
                row.reorder_min = new_min
                reevaluate.append(row)
        row.updated_at = utc_now()
        n += 1
    db.flush()
    if switched_on:
        stock_reset.mark_started(db, loc, tenant_id)
    # A new minimum raises or clears the low-stock alert now, not at the next sale.
    if reevaluate and L.table_ready(db, "stock_alerts"):
        from app.services import stock_alerts

        for row in reevaluate:
            if product_tracked(db, row.product_id):
                stock_alerts.reevaluate(db, row)
    return n


def product_tracked(db: Session, product_id: Any) -> bool:
    return bool(db.query(Product.track_stock).filter(Product.id == product_id).scalar())
