"""
The shared effective-state resolver of the digital channels — the database half
(specs/digital-menu-ordering-cards-plan.md §4.4 / §8; the rule: app/services/digital_effective_rules.py).

Given a context — tenant, shop, point of sale, profile (and its revision), channel, service, language,
time — it gathers, from the engines that already exist, what decides each product, and asks the
rule: the catalog and the shop's assortment (`shop_product_overrides`), the availability locks
(company / shop / point of sale, app/services/product_availability.py) and the categories' switches,
"מופיע ב" (item-blocks' model, the canonical one: `products.appears_in`,
app/services/product_channels.py), the profile's selection and publication, the time menus offered on
this web channel (`catalog_menus.web_channels`, the menus' own rule app/services/catalog_menu_rules.py),
the blocks in force ("חסום" / "אזל": item-blocks' `sold_out_marks.channels` and their own rule,
app/services/sold_out_rules.py `decide` with a `Till` of the web channel) and stock, the profile's
hours. The order comes from "סדר תצוגה" (app/services/display_ordering.py).

One code path for three requests: the public page (the published revision — `mode="public"`), the
editor's preview (the draft, with a test context — `mode="preview"`) and an order's validation
(`mode="validate"`). Prices are the base the till starts from (the shop's price, or the active time
menu's) — promotions stay the tills' (the cloud has no promotion engine).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.product import CatalogLevel, Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.services import digital_effective_rules as ER
from app.services import display_ordering_rules as OR
from app.services import product_channels as PC


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _money(value: Any) -> Optional[str]:
    if value is None:
        return None
    return f"{Decimal(str(value)).quantize(Decimal('0.01')):.2f}"


# ── Where ────────────────────────────────────────────────────────────────────


@dataclass
class Place:
    tenant_id: uuid.UUID
    company_id: Optional[uuid.UUID]
    shop_id: Optional[uuid.UUID]
    area_id: Optional[uuid.UUID]


def place_for(db: Session, profile: Any, *, shop_id: Any = None, area_id: Any = None) -> Place:
    """
    The place a request resolves in: the profile's own point of sale or shop; under a company
    profile a shop (and point of sale) of that company may be named. Never "the first in a list".
    """
    company_id, p_shop, p_area = profile.company_id, profile.shop_id, profile.area_id
    shop_id, area_id = _uuid(shop_id), _uuid(area_id)
    if p_area is not None:
        if (area_id is not None and area_id != p_area) or (shop_id is not None and shop_id != p_shop):
            raise _bad("place_outside_profile", "המקום אינו של הפרופיל הזה", status.HTTP_404_NOT_FOUND)
        return Place(profile.tenant_id, company_id, p_shop, p_area)
    if p_shop is not None:
        if shop_id is not None and shop_id != p_shop:
            raise _bad("place_outside_profile", "המקום אינו של הפרופיל הזה", status.HTTP_404_NOT_FOUND)
        if area_id is not None:
            area = db.get(ShopArea, area_id)
            if area is None or area.shop_id != p_shop or getattr(area, "archived_at", None) is not None:
                raise _bad("place_outside_profile", "נקודת המכירה אינה של הסניף", status.HTTP_404_NOT_FOUND)
        return Place(profile.tenant_id, company_id, p_shop, area_id)
    # A company profile: a shop of the company (or of one under it), when named.
    if shop_id is not None:
        from app.services.company_hierarchy import descendant_company_ids

        shop = db.get(Shop, shop_id)
        allowed = {company_id, *descendant_company_ids(db, company_id)} if company_id else set()
        if shop is None or shop.company_id not in allowed:
            raise _bad("place_outside_profile", "הסניף אינו של החברה", status.HTTP_404_NOT_FOUND)
        if area_id is not None:
            area = db.get(ShopArea, area_id)
            if area is None or area.shop_id != shop.id:
                raise _bad("place_outside_profile", "נקודת המכירה אינה של הסניף", status.HTTP_404_NOT_FOUND)
        return Place(profile.tenant_id, shop.company_id, shop.id, area_id)
    return Place(profile.tenant_id, company_id, None, None)


def local_now(db: Session, tenant_id: Any, at: Optional[datetime] = None) -> datetime:
    """`at` (now) on the business's wall clock (Asia/Jerusalem unless the tenant says otherwise), naive."""
    from app.services.catalog_menus import tenant_zone

    zone = tenant_zone(db, tenant_id)
    moment = at or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        return moment.replace(second=0, microsecond=0)
    return moment.astimezone(zone).replace(tzinfo=None, second=0, microsecond=0)


# ── Gathering ────────────────────────────────────────────────────────────────


def _catalog(db: Session, place: Place) -> Tuple[List[Product], Dict[str, Any]]:
    """`(products, {product id: its shop row})` — the shop's assortment, or the company's catalog."""
    if place.shop_id is not None:
        rows = (
            db.query(ShopProductOverride, Product)
            .join(Product, Product.id == ShopProductOverride.global_product_id)
            .filter(
                ShopProductOverride.shop_id == place.shop_id,
                Product.tenant_id == place.tenant_id,
                Product.catalog_level == CatalogLevel.GLOBAL,
                Product.pos_machine_id.is_(None),
            )
            .all()
        )
        return [p for _o, p in rows], {str(p.id): o for o, p in rows}
    from app.services.catalog_menus import company_chain

    chain = company_chain(db, place.company_id) if place.company_id else []
    q = db.query(Product).filter(
        Product.tenant_id == place.tenant_id,
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
    )
    q = q.filter(or_(Product.company_id.is_(None), Product.company_id.in_(chain))) if chain else q
    return q.all(), {}


def _available(db: Session, place: Place, products: Sequence[Product], shop_rows: Mapping[str, Any]) -> Dict[str, bool]:
    from app.services import product_availability as A

    ids = [p.id for p in products]
    shop = db.get(Shop, place.shop_id) if place.shop_id else None
    company_rows = A.company_overrides(db, A.company_level_company_id(shop), ids) if shop is not None else {}
    area_rows = A.area_overrides(db, place.area_id, ids) if place.area_id is not None else {}
    out = {}
    for p in products:
        key = str(p.id)
        levels = A.resolve_rows(p, company_rows.get(key), shop_rows.get(key), None, area_row=area_rows.get(key))
        out[key] = bool(levels[A.Level.MACHINE].available)
    return out


def _categories(db: Session, place: Place, category_ids: Iterable[Any]) -> Tuple[Dict[str, Category], Dict[str, bool], Dict[str, List[str]]]:
    """`(categories by id, active here, chain: [it, its parent, …])`."""
    from app.services import category_availability as CA
    from app.services.sold_out import category_chains

    ids = {str(c) for c in category_ids if c is not None}
    chains = category_chains(db, ids)
    all_ids = {c for chain in chains.values() for c in chain}
    rows = {str(c.id): c for c in db.query(Category).filter(Category.id.in_([_uuid(i) for i in all_ids])).all()} if all_ids else {}
    overrides: Dict[str, Dict[str, Any]] = {}
    targets = []
    if place.shop_id is not None:
        targets.append(("shop", place.shop_id))
    if place.area_id is not None:
        targets.append(("area", place.area_id))
    if targets and rows:
        from app.models.category_availability_override import CategoryAvailabilityOverride as CAO

        q = db.query(CAO).filter(
            CAO.category_id.in_([c.id for c in rows.values()]),
            or_(*[and_(CAO.level == lvl, CAO.target_id == tid) for lvl, tid in targets]),
        )
        for r in q.all():
            overrides.setdefault(str(r.category_id), {})[r.level] = r
    active = {}
    for cid, c in rows.items():
        o = overrides.get(cid, {})
        shop_v = o.get("shop").is_active if o.get("shop") is not None else None
        area_v = o.get("area").is_active if o.get("area") is not None else None
        active[cid] = CA.resolve(bool(getattr(c, "is_active", True)), shop_v, area_v, None)
    return rows, active, chains


def _blocks(db: Session, place: Place, products: Sequence[Product], chains: Mapping[str, List[str]], now: datetime) -> Dict[str, List[Any]]:
    """
    The blocks in force at this place, per product (its own and its categories') — item-blocks' rows as
    they are (`sold_out_marks`, with their `channels`); their own rule decides which reach the channel
    (app/services/sold_out.py `resolve_channel` reads the same: the shop's, and its company's).
    """
    from app.models.sold_out import SoldOutMark
    from app.services import sold_out as SO

    if not SO.tables_ready(db):
        return {}
    places = []
    if place.shop_id is not None:
        places.append(SoldOutMark.shop_id == place.shop_id)
    if place.company_id is not None:
        places.append(and_(SoldOutMark.scope == "company", SoldOutMark.company_id == place.company_id))
    if not places:
        return {}
    pids = [p.id for p in products]
    cats = {c for chain in chains.values() for c in chain}
    item = SoldOutMark.product_id.in_(pids)
    if cats:
        item = or_(item, SoldOutMark.category_id.in_([_uuid(c) for c in cats]))
    q = db.query(SoldOutMark).filter(or_(*places), SO.in_force_filter(now), item)
    by_product: Dict[str, List[Any]] = {}
    by_category: Dict[str, List[Any]] = {}
    for m in q.all():
        if m.product_id is not None:
            by_product.setdefault(str(m.product_id), []).append(m)
        elif m.category_id is not None:
            by_category.setdefault(str(m.category_id), []).append(m)
    out: Dict[str, List[Any]] = {}
    for p in products:
        found = list(by_product.get(str(p.id), []))
        for c in chains.get(str(p.category_id), []):
            found += by_category.get(c, [])
        if found:
            out[str(p.id)] = found
    return out


def _stock(db: Session, place: Place, products: Sequence[Product]) -> Tuple[Dict[str, float], bool]:
    """`({product id: on hand where this place sells from}, "אזל אוטומטי" on)` — tracked products only."""
    from app.models.stock_level import StockLevel
    from app.services import sold_out as SO

    tracked = [p.id for p in products if p.track_stock]
    if not tracked or place.shop_id is None:
        return {}, True
    out: Dict[str, float] = {}
    targets = [("shop", place.shop_id)] + ([("area", place.area_id)] if place.area_id is not None else [])
    try:
        rows = db.query(StockLevel).filter(
            StockLevel.product_id.in_(tracked),
            or_(*[and_(StockLevel.level == lvl, StockLevel.target_id == tid) for lvl, tid in targets]),
        ).all()
    except Exception:  # noqa: BLE001 - stock not in this world
        return {}, True
    shop_q: Dict[str, float] = {}
    area_q: Dict[str, float] = {}
    for r in rows:
        (area_q if r.level == "area" else shop_q)[str(r.product_id)] = float(r.quantity or 0)
    for pid in tracked:
        key = str(pid)
        out[key] = area_q.get(key, shop_q.get(key, 0.0))
    try:
        auto = SO.auto_setting_on(db, place.shop_id, place.area_id, company_id=place.company_id)
    except Exception:  # noqa: BLE001
        auto = True
    return out, auto


def web_menus(db: Session, place: Place, channel: str, local_at: datetime) -> Optional[Dict[str, Any]]:
    """
    The time menu offered on this web channel at this place now (`catalog_menus.web_channels`):
    None when no menu along the place's chain is offered on the web (the menus play no part);
    else `{"mode", "menuId", "menu"}` by the menus' own rule (fallback included).
    """
    from app.models.catalog_menu import CatalogMenu
    from app.services import catalog_menu_rules as CMR
    from app.services import catalog_menus as CM

    if not CM.tables_ready(db) or place.shop_id is None and place.company_id is None:
        return None
    if "web_channels" not in CatalogMenu.__table__.columns:
        return None
    shop = db.get(Shop, place.shop_id) if place.shop_id else None
    chain = CM.chain_for(db, shop, area_id=place.area_id, company_id=place.company_id)
    data = CM._data(db, place.tenant_id, chain)
    menu_ids = [_uuid(m) for m in (data.get("menus") or {})]
    if not menu_ids:
        return None
    web = {
        str(mid) for mid, chans in db.query(CatalogMenu.id, CatalogMenu.web_channels).filter(CatalogMenu.id.in_(menu_ids)).all()
        if isinstance(chans, list) and channel in chans
    }
    if not web:
        return None
    block = CM.block_of(data, chain)
    block = {
        **block,
        "menus": [{**m, "channel": "both"} for m in block.get("menus") or [] if m.get("id") in web],
        "assignments": [a for a in block.get("assignments") or [] if a.get("menuId") in web],
    }
    r = CMR.resolve(block, local_at, CMR.SURFACE_POS)
    return {"mode": r["mode"], "menuId": r.get("menuId"), "menu": CMR.menu_by_id(block, r.get("menuId"))}


def _price_menu(db: Session, menu_id: Any) -> Dict[str, Optional[str]]:
    """A menu's own prices: `{product id: price}` (only the products it prices)."""
    from app.models.catalog_menu import CatalogMenuProduct

    out: Dict[str, Optional[str]] = {}
    ident = _uuid(menu_id)
    if ident is None:
        return out
    for row in db.query(CatalogMenuProduct).filter(CatalogMenuProduct.menu_id == ident).all():
        if row.price is not None:
            out[str(row.product_id)] = _money(row.price)
    return out


# ── Schedule ─────────────────────────────────────────────────────────────────


def _open(schedule: Optional[Mapping[str, Any]], exceptions: Sequence[Mapping[str, Any]], local_at: datetime) -> bool:
    from app.services.catalog_menu_rules import schedule_active

    today = local_at.date().isoformat()
    for e in exceptions or []:
        if e.get("date") == today:
            if e.get("closed", True) and not e.get("ranges"):
                return False
            return schedule_active({"ranges": e.get("ranges") or []}, local_at)
    if schedule is None:
        return True
    return schedule_active(dict(schedule), local_at)


def hours(content: Mapping[str, Any], service: Optional[str], local_at: datetime) -> Dict[str, bool]:
    """`{"access": browsing allowed now, "order": orders taken now (for this service)}`."""
    sched = content.get("schedule") if isinstance(content.get("schedule"), Mapping) else {}
    exceptions = sched.get("exceptions") or []
    access = _open(sched.get("access"), exceptions, local_at)
    order = sched.get("order")
    if isinstance(order, Mapping) and any(k in order for k in ("dine_in", "takeaway")):
        # Per service; a service with no schedule of its own takes orders whenever browsing is open.
        if service:
            order_open = _open(order.get(service), exceptions, local_at)
        else:
            order_open = any(_open(order.get(k), exceptions, local_at) for k in ("dine_in", "takeaway"))
    else:
        order_open = _open(order, exceptions, local_at)
    return {"access": access, "order": access and order_open}


# ── Selection: parents and the kiosk ─────────────────────────────────────────


def _kiosk_hidden(db: Session, source: Optional[Mapping[str, Any]]) -> Tuple[Set[str], Set[str]]:
    """"כמו הקיוסק": the kiosk's hidden products and categories at the source level (its config, live)."""
    from app.services import kiosk_config as cfgsvc
    from app.services import display_ordering as DO

    if not source:
        return set(), set()
    try:
        target = DO.resolve_target(db, source.get("level"), source.get("targetId"), None)
        layers = cfgsvc.layers_for(db, company_id=target.company_id, shop_id=target.shop_id, machine_id=target.machine_id)
        stack = [layers.company]
        if source.get("level") in ("shop", "machine"):
            stack.append(layers.shop)
        if source.get("level") == "machine":
            stack.append(layers.machine)
        config = cfgsvc.resolve(*stack)
    except Exception:  # noqa: BLE001 - no kiosks here: nothing hidden
        return set(), set()
    catalog = config.get("catalog") or {}
    return ({str(x) for x in catalog.get("hiddenProducts") or []}, {str(x) for x in catalog.get("hiddenCategories") or []})


def _parent_selection(db: Session, profile: Any):
    """The parent's published selection and the parent's own parent answer, as a function of a product."""
    from app.services import presentation_profiles as PP

    parent = PP.profile_row(db, profile.parent_profile_id) if profile.parent_profile_id else None
    if parent is None:
        return None
    pub = PP.revision(db, parent.published_revision_id)
    if pub is None:
        return None
    selection = (pub.content or {}).get("selection") or {}
    grand = _parent_selection(db, parent)
    hidden = _kiosk_hidden(db, ER.clean_selection(selection).get("source")) if ER.clean_selection(selection)["mode"] == "kiosk" else None

    def answer(pid: str, chain: Sequence[str]) -> ER.Selected:
        return ER.select(selection, pid, chain, parent=grand(pid, chain) if grand else None, kiosk_hidden=hidden)

    return answer


# ── The resolver ─────────────────────────────────────────────────────────────


@dataclass
class Request:
    profile: Any
    revision: Any
    channel: str
    service: Optional[str] = None
    lang: Optional[str] = None
    at: Optional[datetime] = None
    mode: str = "public"            # public | preview | validate
    shop_id: Any = None
    area_id: Any = None


def _effective_content(db: Session, profile: Any, rev: Any) -> Dict[str, Any]:
    from app.services import presentation_profiles as PP

    fields = PP.effective_fields(db, profile, rev)
    content = dict(PP.default_content(profile.kind))
    for f, e in fields.items():
        content[f] = e["value"]
    content["selection"] = ER.clean_selection(((rev.content if rev is not None else None) or {}).get("selection"))
    return content


def resolve(db: Session, req: Request) -> Dict[str, Any]:
    """The view-model of a profile in a context, with every product's display, orderability and reasons."""
    from app.services import display_ordering as DO
    from app.services import presentation_profiles as PP

    profile, rev = req.profile, req.revision
    channel = req.channel or profile.kind
    if channel not in ER.WEB_CHANNELS:
        raise _bad("invalid_channel", "ערוץ לא מוכר")
    if req.service is not None and req.service not in ("dine_in", "takeaway"):
        raise _bad("invalid_service", "סוג שירות לא מוכר")
    lang = req.lang if req.lang in (profile.languages or []) else profile.default_language
    place = place_for(db, profile, shop_id=req.shop_id, area_id=req.area_id)
    now = req.at or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    local_at = local_now(db, profile.tenant_id, now)
    content = _effective_content(db, profile, rev)
    display = content.get("display") or {}
    open_now = hours(content, req.service, local_at)

    products, shop_rows = _catalog(db, place)
    available = _available(db, place, products, shop_rows)
    cats, cat_active, chains = _categories(db, place, {p.category_id for p in products})
    blocks = _blocks(db, place, products, chains, now)
    stock, auto = _stock(db, place, products)
    menu = web_menus(db, place, channel, local_at)
    menu_ids: Set[str] = set()
    menu_prices: Dict[str, Optional[str]] = {}
    if menu is not None and menu.get("mode") == "menu" and menu.get("menu"):
        from app.services import catalog_menu_rules as CMR

        applied = CMR.apply(
            menu["menu"], [{"id": str(p.id), "categoryId": str(p.category_id), "price": p.price} for p in products],
        )
        menu_ids = {p["id"] for p in applied["products"]}
        menu_prices = {p["id"]: p["price"] for p in applied["products"] if p["priceSource"] == "menu"}
    price_list = _price_menu(db, (profile.price_context or {}).get("menuId")) if (profile.price_context or {}).get("mode") == "catalog_menu" else {}
    selection = content["selection"]
    parent = _parent_selection(db, profile) if selection["mode"] in ("inherit_add", "inherit_full") else None
    hidden_kiosk = _kiosk_hidden(db, selection.get("source")) if selection["mode"] == "kiosk" else None
    exposure = (rev.exposure or {}) if (rev is not None and req.mode == "public") else None
    exposed_ids = set((exposure or {}).get("products") or [])

    ctx = ER.Context(
        channel=channel, service=req.service, services=list(profile.service_types or []),
        order_open=open_now["order"], published=exposure is not None,
        sold_out_display=display.get("soldOut") or ER.LABEL, blocked_display=display.get("blocked") or ER.LABEL, lang=lang,
        now=now, company_id=str(place.company_id) if place.company_id else None,
        shop_id=str(place.shop_id) if place.shop_id else None, area_id=str(place.area_id) if place.area_id else None,
    )
    overrides_public = content.get("productOverrides") or {}
    rows: Dict[str, Dict[str, Any]] = {}
    for p in products:
        pid = str(p.id)
        chain = chains.get(str(p.category_id), [str(p.category_id)] if p.category_id else [])
        sel = ER.select(selection, pid, chain, parent=parent(pid, chain) if parent else None, kiosk_hidden=hidden_kiosk)
        shop_row = shop_rows.get(pid)
        if menu is None:
            menu_state = None
        elif menu.get("mode") == "menu":
            menu_state = "in" if pid in menu_ids else "out"
        elif menu.get("mode") == "none":
            menu_state = "none"
        else:
            menu_state = None
        facts = ER.Facts(
            product_id=pid,
            category_chain=chain,
            available=available.get(pid, True),
            listed=(shop_row is None and place.shop_id is None) or bool(getattr(shop_row, "is_listed", False)),
            category_active=cat_active.get(str(p.category_id), True),
            # "מופיע ב": item-blocks' model (products.appears_in, product_channels.appears).
            channel_allowed=PC.appears(p, channel),
            selected=sel,
            exposed=pid in exposed_ids,
            menu=menu_state,
            blocks=blocks.get(pid, []),
            # Stock where this place sells from (a company page has none: no stock rule).
            track_stock=bool(p.track_stock) and place.shop_id is not None,
            stock=stock.get(pid),
            auto_setting=auto,
        )
        d = ER.decide(facts, ctx)
        public = overrides_public.get(pid) if isinstance(overrides_public.get(pid), Mapping) else {}

        def word(key: str, fallback: Any) -> Any:
            v = public.get(key)
            if isinstance(v, Mapping):
                return v.get(lang) or v.get(profile.default_language) or fallback
            return v or fallback

        base = shop_row.price if shop_row is not None and shop_row.price is not None else p.price
        price = price_list.get(pid) or menu_prices.get(pid) or _money(base)
        rows[pid] = {
            "id": pid,
            "categoryId": str(p.category_id) if p.category_id else None,
            "name": word("name", p.name),
            "description": word("description", p.description),
            "imageUrl": public.get("imageUrl") or p.image_url,
            "tags": list(public.get("tags") or []),
            "allergens": list(getattr(p, "allergens", None) or []),
            "dietaryTags": list(getattr(p, "dietary_tags", None) or []),
            "price": price,
            "display": d.display,
            "orderable": d.orderable,
            "publicReason": d.public_reason,
            "reasons": d.reasons,
            "appearsIn": list(PC.appears_in(p)),
            "selected": sel.selected,
        }

    # The order: the published revision's frozen one, else the channel's ordering for this profile (live).
    frozen = (exposure or {}).get("order") if exposure is not None else None
    if frozen is not None:
        ordering = frozen
    else:
        target = DO.Target("profile", profile.id, profile.tenant_id, profile.internal_name,
                           company_id=place.company_id, shop_id=place.shop_id, area_id=place.area_id)
        ordering = DO.effective_for(db, channel, target)["content"] if DO.tables_ready(db) else OR.empty()
    shown = {pid for pid, r in rows.items() if r["display"] != ER.HIDE}
    arranged = OR.arrange(
        ordering,
        [{"id": cid, "name": c.name, "sortOrder": c.sort_order or 0} for cid, c in cats.items()],
        [{"id": pid, "categoryId": r["categoryId"], "name": r["name"], "price": r["price"]} for pid, r in rows.items()],
        hidden=[pid for pid in rows if pid not in shown],
    )
    return {
        "profile": {
            "id": str(profile.id), "slug": profile.slug, "kind": profile.kind,
            "title": (profile.public_title or {}).get(lang) or (profile.public_title or {}).get(profile.default_language),
            "revision": rev.number if rev is not None else None, "status": profile.status,
            "template": (content.get("theme") or {}).get("template"),
        },
        "context": {
            "channel": channel, "service": req.service, "lang": lang, "mode": req.mode,
            "companyId": str(place.company_id) if place.company_id else None,
            "shopId": str(place.shop_id) if place.shop_id else None,
            "areaId": str(place.area_id) if place.area_id else None,
            "at": now.isoformat(), "localTime": local_at.isoformat(),
        },
        "open": open_now,
        "menu": {"mode": menu["mode"], "menuId": menu.get("menuId")} if menu is not None else None,
        "categories": [
            {"id": cid, "name": cats[cid].name if cid in cats else None, "products": arranged["products"].get(cid, [])}
            for cid in arranged["categories"]
        ],
        "products": rows,
        "theme": content.get("theme"),
        "texts": content.get("texts"),
        "sections": content.get("sections"),
        "flow": content.get("flow"),
    }


# ── Publication and the lists ────────────────────────────────────────────────


def exposure_for(db: Session, profile: Any, rev: Any) -> Dict[str, Any]:
    """
    What publishing this revision exposes: the products selected and allowed in the channel at the
    profile's place now (blocks and stock aside — they act live), the categories that take future
    products, those selected but switched off in the channel (a warning), and the order to freeze
    (None when the profile's order is linked to another channel's: it moves with it, live).
    """
    from app.services import display_ordering as DO

    view = resolve(db, Request(profile=profile, revision=rev, channel=profile.kind, mode="preview"))
    products = []
    channel_off = []
    for pid, r in view["products"].items():
        if not r["selected"]:
            continue
        if ER.R_CHANNEL_OFF in r["reasons"]:
            channel_off.append(pid)
            continue
        # Locks, the assortment, blocks and stock act live: a product locked today is still exposed.
        products.append(pid)
    selection = ER.clean_selection(((rev.content or {}) if rev is not None else {}).get("selection"))
    include_future = [c["id"] for c in selection["categories"] if c["includeFuture"]]
    order = None
    if DO.tables_ready(db):
        b = DO.binding_at(db, profile.tenant_id, "profile", profile.id, profile.kind)
        linked = b is not None and len(DO.bindings_of(db, b.ordering_id)) > 1
        if not linked:
            target = DO.Target("profile", profile.id, profile.tenant_id, profile.internal_name,
                               company_id=profile.company_id, shop_id=profile.shop_id, area_id=profile.area_id)
            order = DO.effective_for(db, profile.kind, target)["content"]
    return {
        "products": sorted(products),
        "includeFuture": include_future,
        "channelOff": sorted(channel_off),
        "order": order,
        "at": datetime.now(timezone.utc).isoformat(),
    }


def profile_counts(db: Session, profile: Any) -> Dict[str, int]:
    """The list's two numbers: selected, and effectively visible now (published revision, else the draft)."""
    from app.services import presentation_profiles as PP

    rev = PP.revision(db, profile.published_revision_id) or PP.revision(db, profile.draft_revision_id)
    try:
        view = resolve(db, Request(profile=profile, revision=rev, channel=profile.kind,
                                   mode="public" if profile.published_revision_id else "preview"))
    except HTTPException:
        return {"selected": 0, "visible": 0}
    rows = view["products"].values()
    return {
        "selected": sum(1 for r in rows if r["selected"]),
        "visible": sum(1 for r in rows if r["display"] != ER.HIDE),
    }


def public_view(view: Mapping[str, Any]) -> Dict[str, Any]:
    """Only what a customer may see: no hidden product, no reason codes, no internal source."""
    keep = ("id", "categoryId", "name", "description", "imageUrl", "tags", "allergens", "dietaryTags", "price",
            "display", "orderable", "publicReason")
    products = {pid: {k: r[k] for k in keep} for pid, r in view["products"].items() if r["display"] != ER.HIDE}
    return {
        "profile": view["profile"],
        "context": {k: view["context"][k] for k in ("channel", "service", "lang", "shopId", "areaId", "localTime")},
        "open": view["open"],
        "categories": [{**c, "products": [p for p in c["products"] if p in products]} for c in view["categories"]],
        "products": products,
        "theme": view.get("theme"),
        "texts": view.get("texts"),
        "sections": view.get("sections"),
        "flow": view.get("flow"),
    }
