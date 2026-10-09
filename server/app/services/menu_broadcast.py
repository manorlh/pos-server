"""
"סקירת שינויים לפני שידור לקופות" — menu change review before broadcast
(docs/SPEC_MENU_BROADCAST_REVIEW.md).

**Who is in review mode** (`review_state`). A shop whose tables module is on — the till
parameter `tablesMode` other than «כבוי» for any of its active tills (for the shop itself
when it has none) — unless the shop's `menuBroadcastReview` says otherwise: «תמיד» /
«אף פעם»; the default «אוטומטי (לפי שולחנות)» follows the tables. It is not tied to the
order being rung up: a shop with tables, Take Away and quick orders is a tables shop, and
every menu change it makes is reviewed, the Take Away menu's too.

**What the tills get** (`catalog_pull`, `serve`). A shop in review mode serves its tills
the menu of its latest publication (`catalog_publications`), never the live catalog
tables: those are the draft. A publication is the shop-level catalog exactly as
`GET /sync/{m}/catalog` builds it — the shop's products with its prices and listing, its
categories with its own names for them, the menu block — made by the sync's own
serializers (`build_snapshot`). What is particular to one till is laid over it live at
every pull, so it never waits for a broadcast:

* gated (from the publication): everything a product, a category and the menu block
  *are* — names, prices (the shop's too), listing in the shop, category, tax, flags,
  allergens, course, limits, the category tree, its order and names, the tenant's on/off
  of a category, modifier groups and options, links, note chips, meals, upsells (and
  their hours), courses; and availability set at the product's own level or at its
  company's (the dashboard's alone);
* live (as today): availability at the shop, point-of-sale and till levels (the rows a
  till's "sold out" / lock toggles write, and the dashboard's switches for the same
  levels), a category switched off for the shop, area or till, stock flags and
  quantities, the product's picture (a photo taken at a till too), the till's own catalog
  list and mode, its own local products, customers and vouchers; and everything outside
  this payload (button order, settings, parameters, promotions, printers, tables).

**When.** A shop in review mode with no open publication gets one of its live catalog as
it stands (`KIND_INITIAL`, `ensure_publication`) — on its first pull or look from the
dashboard — so switching review on changes nothing on its tills. A broadcast
(`broadcast`) makes the next version and wakes the shop's tills. A till whose last pull
is older than the publication (with `RESEND_WINDOW` of slack for a pull racing the commit)
gets all of it, plus every product and category the version it had and this one dropped,
sent locked (as a delisted row is today; its next full pull delists it). Otherwise only
what changed live for it since.

**Leaving review mode.** The shop's newest publication is closed (`closed_at`) the first
time a till of it pulls out of review mode, and a till whose last pull is older than that
pulls the live catalog in full once, so the drafts it never got reach it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
import weakref
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import sqlalchemy as sa
from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.models.category import CatalogLevel as CategoryCatalogLevel
from app.models.category import Category
from app.models.menu_broadcast import (
    KIND_BROADCAST,
    KIND_INITIAL,
    CatalogPublication,
    ShopWorkTypes,
)
from app.models.pos_machine import POSMachine
from app.models.product import CatalogLevel, Product
from app.models.shop import Shop
from app.models.shop_category_override import ShopCategoryOverride
from app.models.shop_product_override import ShopProductOverride
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User, UserRole
from app.services import category_availability, machine_catalog
from app.services import dietary
from app.services import product_availability as availability

logger = logging.getLogger(__name__)

# ── The mode ─────────────────────────────────────────────────────────────────

#: The built-in till parameter (app/services/till_parameters.py) that overrides the
#: automatic rule for a shop (or a company: its shops inherit it).
REVIEW_KEY = "menuBroadcastReview"
REVIEW_AUTO = "אוטומטי (לפי שולחנות)"
REVIEW_ALWAYS = "תמיד"
REVIEW_NEVER = "אף פעם"
REVIEW_OPTIONS = (REVIEW_AUTO, REVIEW_ALWAYS, REVIEW_NEVER)

TABLES_MODE_KEY = "tablesMode"

#: Why a shop is (or is not) in review mode.
REASON_TABLES = "tables"
REASON_ALWAYS = "always"
REASON_NEVER = "never"
REASON_NO_TABLES = "no_tables"

#: A till whose last pull is up to this much after a publication still gets it whole:
#: a pull that read the old version while the new one was committing stamps a later
#: `serverTime`, and must not skip the new version for it. Re-sending is an upsert.
RESEND_WINDOW = timedelta(minutes=2)

#: Snapshots kept per shop; older versions keep their summary for the history list.
KEEP_SNAPSHOTS = 20

#: The catalog notify `reason` a broadcast wakes the shop's tills with.
NOTIFY_REASON = "menu_broadcast"

SNAPSHOT_FORMAT = 1

#: Refusals (`detail`, or `detail.code` with more).
REVIEW_OFF = "menu_review_off"
CHANGED_SINCE_PREVIEW = "menu_changed_since_preview"
NOTHING_TO_BROADCAST = "menu_nothing_to_broadcast"
BROADCAST_CONFLICT = "menu_broadcast_conflict"

#: The sections of a review, in the order the screen shows them.
SECTIONS = ("products", "prices", "categories", "modifiers", "availability", "hours", "menu")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _utc(value)
    return value.isoformat() if value is not None else None


def _parse(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        return _utc(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
    except ValueError:
        return None


def _uuids(keys: Iterable[str]) -> List[uuid.UUID]:
    out = []
    for key in keys:
        try:
            out.append(uuid.UUID(str(key)))
        except (TypeError, ValueError):
            continue
    return out


# ── Is the feature's storage there at all ────────────────────────────────────

_READY: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_NEEDED_TABLES = ("catalog_publications", "till_parameters", "till_parameter_values")


def tables_ready(db: Session) -> bool:
    """
    The tables this needs exist. Always so on a migrated database; a test world that
    builds only the tables it is about has none of them, and its pulls stay live. Asked
    on the session's own connection (a fresh one would reset an in-memory test
    database's open transaction), and remembered per engine once true.
    """
    try:
        bind = db.get_bind()
    except Exception:  # pragma: no cover - an unbound session
        return False
    engine = getattr(bind, "engine", bind)
    try:
        if _READY.get(engine):
            return True
    except TypeError:  # pragma: no cover - not weak-referenceable
        pass
    try:
        inspector = sa.inspect(db.connection())
        ok = all(inspector.has_table(name) for name in _NEEDED_TABLES)
    except Exception:  # pragma: no cover - nothing to inspect
        return False
    if ok:
        try:
            _READY[engine] = True
        except TypeError:  # pragma: no cover
            pass
    return ok


@dataclass
class ReviewState:
    enabled: bool
    #: `REASON_*`.
    reason: str
    #: The shop's `menuBroadcastReview`, one of `REVIEW_OPTIONS`.
    override: str
    #: The tables module is on in the shop.
    tables_enabled: bool
    #: `tablesMode` as it stands for the shop itself (its own value, else its company's,
    #: else the default).
    shop_tables_mode: Optional[str]
    #: The shop's active tills whose `tablesMode` is on: `{machineId, name, posNumber, mode}`.
    tables_tills: List[Dict[str, Any]] = field(default_factory=list)

    def out(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "reason": self.reason,
            "override": self.override,
            "tablesEnabled": self.tables_enabled,
            "shopTablesMode": self.shop_tables_mode,
            "tablesTills": self.tables_tills,
        }


def _tables_on(value: Any) -> bool:
    from app.services.tables import MODE_OFF, mode_of

    return mode_of(value) != MODE_OFF


def review_state(db: Session, shop: Shop) -> ReviewState:
    """
    Whether `shop` reviews menu changes before they reach its tills, and why.

    `MenuChangeReviewBeforeBroadcast = TablesEnabled`, where TablesEnabled is the shop's
    tables module: on for any of its active tills (each resolved through its own levels —
    the till, its area, the shop, the company), or for the shop itself when it has no
    till yet. `menuBroadcastReview` («תמיד» / «אף פעם», shop then company) overrides it.
    Three queries, whatever the size of the shop.
    """
    from app.services import till_parameters as TP

    params = (
        db.query(TillParameter)
        .filter(TillParameter.key.in_((TABLES_MODE_KEY, REVIEW_KEY)))
        .all()
    )
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )
    scope_ids: Set[uuid.UUID] = {shop.id}
    if shop.company_id is not None:
        scope_ids.add(shop.company_id)
    scope_ids |= {m.area_id for m in machines if m.area_id is not None}
    scope_ids |= {m.id for m in machines}
    values: List[TillParameterValue] = []
    if params:
        values = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id.in_([p.id for p in params]),
                TillParameterValue.scope_id.in_(list(scope_ids)),
            )
            .all()
        )
    at_shop = TP.resolve_till_parameters(
        params, values, TP.TillScopeChain(machine_id=None, shop_id=shop.id, company_id=shop.company_id)
    ).parameters
    override = at_shop.get(REVIEW_KEY)
    if override not in REVIEW_OPTIONS:
        override = REVIEW_AUTO
    shop_mode = at_shop.get(TABLES_MODE_KEY)

    tills: List[Dict[str, Any]] = []
    for m in machines:
        chain = TP.TillScopeChain(
            machine_id=m.id, area_id=m.area_id, shop_id=shop.id, company_id=shop.company_id
        )
        mode = TP.resolve_till_parameters(params, values, chain).parameters.get(TABLES_MODE_KEY)
        if _tables_on(mode):
            tills.append({
                "machineId": str(m.id), "name": m.name, "posNumber": m.pos_number, "mode": mode,
            })
    tables = bool(tills) if machines else _tables_on(shop_mode)

    if override == REVIEW_ALWAYS:
        enabled, reason = True, REASON_ALWAYS
    elif override == REVIEW_NEVER:
        enabled, reason = False, REASON_NEVER
    else:
        enabled, reason = tables, (REASON_TABLES if tables else REASON_NO_TABLES)
    return ReviewState(
        enabled=enabled,
        reason=reason,
        override=override,
        tables_enabled=tables,
        shop_tables_mode=shop_mode if isinstance(shop_mode, str) else None,
        tables_tills=tills,
    )


# ── A snapshot: the shop's catalog as its tills would be sent it ─────────────


def _virtual_till(shop: Shop) -> SimpleNamespace:
    """A till of `shop` with nothing of its own: no area, no local rows, no list."""
    return SimpleNamespace(
        id=None, shop_id=shop.id, tenant_id=shop.tenant_id, area_id=None, area_changed_at=None,
        catalog_mode=None,
    )


def _jsonable(value: Any) -> Any:
    """What the JSON column will hand back, so a fingerprint taken now matches it later."""
    return json.loads(json.dumps(value, default=str, ensure_ascii=False))


def build_snapshot(db: Session, shop: Shop) -> Dict[str, Any]:
    """
    The shop's catalog as `GET /sync/{m}/catalog` serves it, at shop level — through the
    sync's own serializers, so a publication made of the live state serves the tills
    exactly what they were getting:

    * `products` — `{global_id: row}` for every global product assigned to the shop (its
      price and listing), as `_serialize_merged_product` makes it with no till of its own;
    * `productGates` — the gated availability inputs: the product's own flag, its company
      level and (for a product the shop later drops) the shop level as it stood;
    * `categories` — `{id: row}` the shop's tills get (`_categories_for_shop`), with the
      shop's own names; `referencedCategories` — the others a product names (with their
      parents), which a delta pull merges in as the live one does; `categoryGates` — the
      tenant's own on/off of each;
    * `menu` — the menu block (groups, links, notes, meals, upsells, courses, limits).
    """
    from app.services import menu as menu_service
    from app.services import sync as S

    tid = shop.tenant_id
    rows = (
        db.query(ShopProductOverride, Product)
        .join(Product, Product.id == ShopProductOverride.global_product_id)
        .options(joinedload(Product.category))
        .filter(
            ShopProductOverride.shop_id == shop.id,
            Product.tenant_id == tid,
            Product.catalog_level == CatalogLevel.GLOBAL,
            Product.pos_machine_id.is_(None),
        )
        .order_by(Product.name, Product.id)
        .all()
    )
    company_rows = availability.company_overrides(
        db, availability.company_level_company_id(shop), [g.id for _, g in rows]
    )
    products: Dict[str, Any] = {}
    gates: Dict[str, Any] = {}
    for ovr, g in rows:
        key = str(g.id)
        company = company_rows.get(key)
        products[key] = S._serialize_merged_product(g, None, ovr, shop.id, None, company_override=company)
        gates[key] = {
            "product": bool(g.is_available),
            "company": None if company is None else company.is_available,
            "shop": ovr.is_available,
        }

    virtual = _virtual_till(shop)
    tenant_categories = (
        db.query(Category)
        .filter(
            Category.tenant_id == tid,
            Category.catalog_level == CategoryCatalogLevel.GLOBAL,
            Category.pos_machine_id.is_(None),
        )
        .order_by(Category.sort_order)
        .all()
    )
    shop_categories = S._categories_for_shop(db, virtual, tenant_categories)
    renames = {
        o.category_id: o
        for o in db.query(ShopCategoryOverride).filter(ShopCategoryOverride.shop_id == shop.id)
    }
    categories: Dict[str, Any] = {}
    category_gates: Dict[str, bool] = {}
    parent_of: Dict[str, Optional[str]] = {}
    for c in shop_categories:
        key = str(c.id)
        categories[key] = S._serialize_category(c, renames.get(c.id), None, None)
        category_gates[key] = bool(c.is_active)
        parent_of[key] = str(c.parent_id) if c.parent_id else None

    # Every category a product names, and its parents, that the shop's list leaves out.
    referenced: Dict[str, Any] = {}
    visited: Set[str] = set()
    frontier = {row["categoryId"] for row in products.values() if row.get("categoryId")}
    while frontier:
        nxt: Set[str] = set()
        missing: List[str] = []
        for key in frontier:
            if key in visited:
                continue
            visited.add(key)
            if key in parent_of:
                if parent_of[key]:
                    nxt.add(parent_of[key])
            else:
                missing.append(key)
        ids = _uuids(missing)
        if ids:
            for c in db.query(Category).filter(Category.id.in_(ids), Category.tenant_id == tid).all():
                key = str(c.id)
                referenced[key] = S._serialize_category(c, renames.get(c.id), None, None)
                category_gates[key] = bool(c.is_active)
                parent_of[key] = str(c.parent_id) if c.parent_id else None
                if c.parent_id:
                    nxt.add(str(c.parent_id))
        frontier = nxt - visited

    menu = menu_service.menu_block(db, virtual) if tid is not None else None
    snapshot = {
        "format": SNAPSHOT_FORMAT,
        "products": products,
        "productGates": gates,
        "categories": categories,
        "referencedCategories": referenced,
        "categoryGates": category_gates,
        "menu": menu,
    }
    # "תפריטים" (docs/SPEC_MENUS.md): the shop's menus, assignments and fallbacks are part of
    # what is published. Only when there are any, so a shop without menus keeps its fingerprint.
    from app.services import catalog_menus as catalog_menus_service

    catalog_menus = catalog_menus_service.snapshot_block(db, shop) if tid is not None else None
    if catalog_menus:
        snapshot["catalogMenus"] = catalog_menus
    return _jsonable(snapshot)


#: Product fields that are not the menu: what is laid over live per till, and stamps.
_PRODUCT_LIVE = frozenset({
    "id", "posMachineId", "catalogLevel", "isLocalOverride", "imageUrl", "inStock", "isAvailable",
    "stockQuantity", "inMachineCatalog", "createdAt", "updatedAt",
    # The deciding lock, laid over live with the levels it comes from (SPEC_AVAILABILITY).
    "availabilityLock",
    # "אזל" / "חסום": the floor of the day, never part of a publication (app/services/sold_out.py).
    "lockAvailable", "blocks",
})
_CATEGORY_LIVE = frozenset({"createdAt", "updatedAt", "activeLock"})


def content_of(snapshot: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The gated content of a snapshot: what a broadcast changes, nothing operational."""
    snapshot = snapshot or {}
    menu = dict(snapshot.get("menu") or {})
    menu.pop("updatedAt", None)
    content = {
        "products": {
            k: {f: v for f, v in row.items() if f not in _PRODUCT_LIVE}
            for k, row in (snapshot.get("products") or {}).items()
        },
        "productGates": {
            k: [g.get("product"), g.get("company")]
            for k, g in (snapshot.get("productGates") or {}).items()
        },
        "categories": {
            k: {f: v for f, v in row.items() if f not in _CATEGORY_LIVE}
            for k, row in (snapshot.get("categories") or {}).items()
        },
        "menu": menu,
    }
    # "תפריטים" — only when the shop has any, so a fingerprint taken before menus existed holds.
    if snapshot.get("catalogMenus"):
        from app.services import catalog_menus as catalog_menus_service

        content["catalogMenus"] = catalog_menus_service.content_of(snapshot["catalogMenus"])
    return content


def fingerprint(snapshot: Optional[Dict[str, Any]]) -> str:
    raw = json.dumps(content_of(snapshot), sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ── Publications ─────────────────────────────────────────────────────────────


def latest_publication(db: Session, shop_id) -> Optional[CatalogPublication]:
    """The shop's newest version (its snapshot is loaded only when read)."""
    return (
        db.query(CatalogPublication)
        .filter(CatalogPublication.shop_id == shop_id)
        .order_by(CatalogPublication.version.desc())
        .first()
    )


def _user_name(user: Optional[User]) -> Optional[str]:
    if user is None:
        return None
    return (getattr(user, "username", None) or getattr(user, "email", None) or None)


def _summary(previous: Optional[CatalogPublication], snapshot: Dict[str, Any], kind: str) -> Dict[str, Any]:
    totals = {
        "products": sum(1 for r in (snapshot.get("products") or {}).values() if r.get("shopListed", True)),
        "categories": len(snapshot.get("categories") or {}),
    }
    old = previous.snapshot if previous is not None and previous.closed_at is None else None
    if kind == KIND_INITIAL or old is None:
        return {"initial": True, "totals": totals, "counts": {s: 0 for s in SECTIONS}, "total": 0}
    counts = {s: len(items) for s, items in diff(old, snapshot).items()}
    return {"initial": False, "totals": totals, "counts": counts, "total": sum(counts.values())}


def _new_publication(
    db: Session,
    shop: Shop,
    *,
    kind: str,
    snapshot: Dict[str, Any],
    previous: Optional[CatalogPublication],
    user: Optional[User] = None,
    note: Optional[str] = None,
) -> CatalogPublication:
    version = (previous.version if previous is not None else 0) + 1
    publication = CatalogPublication(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        shop_id=shop.id,
        version=version,
        kind=kind,
        snapshot=snapshot,
        summary=_summary(previous, snapshot, kind),
        fingerprint=fingerprint(snapshot),
        published_at=_now(),
        published_by_user_id=getattr(user, "id", None),
        published_by_name=_user_name(user),
        note=(note or None) and note[:500],
    )
    db.add(publication)
    db.flush()
    cutoff = version - KEEP_SNAPSHOTS
    if cutoff > 0:
        (
            db.query(CatalogPublication)
            .filter(
                CatalogPublication.shop_id == shop.id,
                CatalogPublication.version <= cutoff,
                CatalogPublication.snapshot.isnot(None),
            )
            .update({CatalogPublication.snapshot: sa.null()}, synchronize_session=False)
        )
    return publication


def ensure_publication(db: Session, shop: Shop) -> CatalogPublication:
    """
    The shop's open publication; made of its live catalog as it stands when there is
    none — the first time it is in review mode, or back in it after leaving. Commits.
    Two tills pulling at the same moment meet the (shop, version) unique key, and the
    loser reads the winner's.
    """
    current = latest_publication(db, shop.id)
    if current is not None and current.closed_at is None:
        return current
    made = _new_publication(db, shop, kind=KIND_INITIAL, snapshot=build_snapshot(db, shop), previous=current)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return latest_publication(db, shop.id)
    logger.info(
        "menu review: first publication v%s of shop %s (its live catalog as it stood)",
        made.version, shop.id,
    )
    return made


def note_live(db: Session, shop_id) -> Optional[datetime]:
    """
    The shop is out of review mode: close its newest publication if still open. When
    it was (closed now or before) — a till that last pulled before then pulls in full.
    """
    current = latest_publication(db, shop_id)
    if current is None:
        return None
    if current.closed_at is None:
        current.closed_at = _now()
        db.commit()
        logger.info("menu review: shop %s left review mode after v%s", shop_id, current.version)
    return _utc(current.closed_at)


def publication_out(p: Optional[CatalogPublication]) -> Optional[Dict[str, Any]]:
    if p is None:
        return None
    return {
        "id": str(p.id),
        "version": p.version,
        "kind": p.kind,
        "publishedAt": _iso(p.published_at),
        "publishedByName": p.published_by_name,
        "note": p.note,
        "summary": p.summary,
        "closedAt": _iso(p.closed_at),
    }


# ── The pull ─────────────────────────────────────────────────────────────────


@dataclass
class PublishedCatalog:
    products: List[Dict[str, Any]]
    categories: List[Dict[str, Any]]
    #: The menu block, or None ("keep what you have") on a delta pull it is not new to.
    menu: Optional[Dict[str, Any]]
    publication: CatalogPublication


@dataclass
class Pull:
    #: The catalog from the shop's publication; None = build it live as always.
    published: Optional[PublishedCatalog]
    #: The `since` the live catalog is built with: None after the shop left review mode
    #: and this till has not pulled in full since.
    live_since: Optional[datetime]


def catalog_pull(db: Session, machine: POSMachine, since: Optional[datetime]) -> Pull:
    """What `GET /sync/{m}/catalog` sends `machine` of its products, categories and menu."""
    if machine.shop_id is None or machine.tenant_id is None or not tables_ready(db):
        return Pull(None, since)
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
    if shop is None:
        return Pull(None, since)
    if not review_state(db, shop).enabled:
        closed = note_live(db, shop.id)
        if since is not None and closed is not None and _utc(since) < closed + RESEND_WINDOW:
            return Pull(None, None)
        return Pull(None, since)
    publication = ensure_publication(db, shop)
    return Pull(serve(db, machine, shop, publication, since), since)


def _products_for_till(
    db: Session, machine: POSMachine, shop: Shop, snapshot: Dict[str, Any], since: Optional[datetime]
) -> List[Dict[str, Any]]:
    """
    The publication's products as this till gets them: each published row, with what is
    the till's own laid over it live — its local copy's id, stock and picture, its
    catalog list, availability resolved from the published product and company levels
    and the live shop, area and till levels — the same values and the same `updatedAt`
    `_products_merged_for_shop_machine` would give. `since`: only rows whose live inputs
    moved after it. Then the till's own local products, as live.
    """
    from app.services import sync as S

    rows: Dict[str, Any] = snapshot.get("products") or {}
    gates: Dict[str, Any] = snapshot.get("productGates") or {}
    ids = _uuids(rows)
    live: Dict[str, Product] = {}
    overrides: Dict[str, ShopProductOverride] = {}
    if ids:
        live = {str(p.id): p for p in db.query(Product).filter(Product.id.in_(ids)).all()}
        overrides = {
            str(o.global_product_id): o
            for o in db.query(ShopProductOverride).filter(
                ShopProductOverride.shop_id == shop.id,
                ShopProductOverride.global_product_id.in_(ids),
            )
        }
    by_global: Dict[str, Product] = {}
    pos_only: List[Product] = []
    for loc in (
        db.query(Product)
        .options(joinedload(Product.category))
        .filter(Product.pos_machine_id == machine.id)
        .all()
    ):
        if loc.global_product_id:
            by_global[str(loc.global_product_id)] = loc
        else:
            pos_only.append(loc)
    company_rows = availability.company_overrides(db, availability.company_level_company_id(shop), ids)
    area_rows = availability.area_overrides(db, getattr(machine, "area_id", None), ids)
    machine_rows = availability.machine_overrides(db, machine.id, ids)
    items = machine_catalog.catalog_items(db, machine.id) if ids else {}
    moved = getattr(machine, "area_changed_at", None)
    moved = S._aware_utc(moved) if isinstance(moved, datetime) else None
    # "אזל" / "חסום" — live, as on a till pulling the live catalog (S._serialize_merged_product).
    from app.services import sold_out

    blocks_by = sold_out.blocks_for_machine(db, machine, ids, since=since) if ids else {}

    out: List[Dict[str, Any]] = []
    for key, published in sorted(rows.items(), key=lambda kv: ((kv[1].get("name") or ""), kv[0])):
        g = live.get(key)
        ovr = overrides.get(key)
        loc = by_global.get(key)
        company = company_rows.get(key)
        area = area_rows.get(key)
        mine = machine_rows.get(key)
        item = items.get(key)
        if g is not None:
            eff = S._effective_ts(g, loc, ovr, company, area, mine, item)
        else:
            stamps = [_parse(published.get("updatedAt"))] + [
                _utc(r.updated_at) for r in (loc, ovr, company, area, mine, item)
                if r is not None and getattr(r, "updated_at", None) is not None
            ]
            eff = max([s for s in stamps if s is not None], default=_now())
        if moved is not None and moved > eff:
            eff = moved
        blocks = blocks_by.get(key)
        blocked_at = S._aware_utc(getattr(blocks, "changed_at", None))
        if blocked_at is not None and blocked_at > S._aware_utc(eff):
            eff = blocked_at
        if since is not None and S._aware_utc(eff) <= S._aware_utc(since):
            continue
        active_blocks = list(getattr(blocks, "active", None) or [])

        gate = gates.get(key) or {}
        listed = bool(published.get("shopListed", True))
        levels = availability.resolve_levels(
            gate.get("product", True),
            gate.get("company"),
            ovr.is_available if ovr is not None else gate.get("shop"),
            None if mine is None else mine.is_available,
            area=None if area is None else area.is_available,
        )
        resolved = levels[availability.Level.MACHINE]
        if loc is not None:
            base_in_stock = loc.in_stock
        elif g is not None:
            base_in_stock = g.in_stock
        else:
            base_in_stock = bool(published.get("inStock", True))

        row = dict(published)
        row["id"] = str(loc.id) if loc is not None else key
        row["posMachineId"] = str(loc.pos_machine_id) if loc is not None and loc.pos_machine_id else None
        level = loc.catalog_level if loc is not None else (g.catalog_level if g is not None else None)
        if level is not None:
            row["catalogLevel"] = level.value if hasattr(level, "value") else level
        row["isLocalOverride"] = loc.is_local_override if loc is not None else False
        if loc is not None and loc.is_local_override and loc.image_url:
            row["imageUrl"] = loc.image_url
        elif g is not None:
            row["imageUrl"] = g.image_url
        row["inStock"] = bool(listed and base_in_stock)
        row["lockAvailable"] = bool(listed and resolved.available)
        row["isAvailable"] = row["lockAvailable"] and not sold_out.manual_in_force(active_blocks)
        row["blocks"] = [sold_out.block_out(b) for b in active_blocks]
        row["kioskDisplay"] = sold_out.kiosk_display(active_blocks)
        # The lock that decides, live like the levels it comes from (docs/SPEC_AVAILABILITY.md).
        row["availabilityLock"] = availability.lock_info(
            levels,
            {availability.Level.SHOP: ovr, availability.Level.AREA: area, availability.Level.MACHINE: mine},
        ) if listed else None
        if loc is not None:
            row["stockQuantity"] = loc.stock_quantity
        elif g is not None:
            row["stockQuantity"] = g.stock_quantity
        row["inMachineCatalog"] = bool(item is not None and item.is_included)
        created = loc.created_at if loc is not None else (g.created_at if g is not None else None)
        if created is not None:
            row["createdAt"] = created.isoformat()
        row["updatedAt"] = eff.isoformat()
        out.append(row)

    for loc in pos_only:
        if since is not None and loc.updated_at is not None:
            if S._aware_utc(loc.updated_at) <= S._aware_utc(since):
                continue
        out.append(S._serialize_product(loc))
    return out


def _latest_stamp(*stamps):
    """The newest of `stamps`, as given (the live serializer prints it as stored)."""
    best = None
    for stamp in stamps:
        if stamp is None:
            continue
        if best is None or _utc(stamp) > _utc(best):
            best = stamp
    return best


def _categories_for_till(
    db: Session, machine: POSMachine, shop: Shop, snapshot: Dict[str, Any]
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]], Dict[str, datetime]]:
    """
    `(the shop's categories, the referenced others by id, each one's live stamp)` as this
    till gets them: the published row, `isActive` from the published tenant flag and the
    live shop / area / till levels, `updatedAt` as `_serialize_category` stamps it.
    """
    main: Dict[str, Any] = snapshot.get("categories") or {}
    referenced: Dict[str, Any] = snapshot.get("referencedCategories") or {}
    gates: Dict[str, Any] = snapshot.get("categoryGates") or {}
    keys = list(main) + [k for k in referenced if k not in main]
    ids = _uuids(keys)
    live: Dict[str, Category] = {}
    renames: Dict[str, ShopCategoryOverride] = {}
    activity: Dict[str, Dict[str, Any]] = {}
    if ids:
        live = {str(c.id): c for c in db.query(Category).filter(Category.id.in_(ids)).all()}
        renames = {
            str(o.category_id): o
            for o in db.query(ShopCategoryOverride).filter(
                ShopCategoryOverride.shop_id == shop.id,
                ShopCategoryOverride.category_id.in_(ids),
            )
        }
        activity = category_availability.overrides_for_machine(db, machine, ids)
    moved = getattr(machine, "area_changed_at", None)
    moved = moved if isinstance(moved, datetime) else None

    def level(rows, name):
        row = (rows or {}).get(name)
        return None if row is None else row.is_active

    stamps: Dict[str, datetime] = {}

    def overlay(key: str, published: Dict[str, Any]) -> Dict[str, Any]:
        c = live.get(key)
        rows = activity.get(key)
        rename = renames.get(key)
        updated = _latest_stamp(
            c.updated_at if c is not None else _parse(published.get("updatedAt")),
            rename.updated_at if rename is not None else None,
            category_availability.latest_change(rows),
            moved,
        )
        row = dict(published)
        row["isActive"] = category_availability.resolve(
            gates.get(key, published.get("isActive", True)),
            level(rows, category_availability.SHOP),
            level(rows, category_availability.AREA),
            level(rows, category_availability.MACHINE),
        )
        row["activeLock"] = category_availability.lock_info(
            gates.get(key, published.get("isActive", True)), rows
        )
        if updated is not None:
            row["updatedAt"] = updated.isoformat()
            stamps[key] = _utc(updated)
        return row

    ordered = sorted(main.items(), key=lambda kv: kv[1].get("sortOrder") or 0)
    main_rows = [overlay(k, r) for k, r in ordered]
    others = {k: overlay(k, r) for k, r in referenced.items() if k not in main}
    return main_rows, others, stamps


def _baseline(db: Session, publication: CatalogPublication, since: datetime) -> Optional[CatalogPublication]:
    """
    The version a till whose last pull was at `since` most likely holds: the newest one
    before `publication` it had surely pulled, else the oldest one still kept.
    """
    q = db.query(CatalogPublication).filter(
        CatalogPublication.shop_id == publication.shop_id,
        CatalogPublication.version < publication.version,
        CatalogPublication.snapshot.isnot(None),
    )
    held = (
        q.filter(CatalogPublication.published_at <= _utc(since) - RESEND_WINDOW)
        .order_by(CatalogPublication.version.desc())
        .first()
    )
    return held or q.order_by(CatalogPublication.version.asc()).first()


def _dropped(
    db: Session,
    machine: POSMachine,
    publication: CatalogPublication,
    snapshot: Dict[str, Any],
    since: datetime,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    What the version the till held had and this one does not, as locked rows: a product
    out of stock and unavailable (how a delisted product is sent today), a category
    inactive. The till keeps them so until its next full pull delists them.
    """
    base = _baseline(db, publication, since)
    old = base.snapshot if base is not None else None
    if not old:
        return [], []
    stamp = _iso(publication.published_at)
    gone = [k for k in (old.get("products") or {}) if k not in (snapshot.get("products") or {})]
    products: List[Dict[str, Any]] = []
    if gone:
        ids = _uuids(gone)
        locals_by_global = {
            str(p.global_product_id): p
            for p in db.query(Product).filter(
                Product.pos_machine_id == machine.id, Product.global_product_id.in_(ids)
            )
        }
        items = machine_catalog.catalog_items(db, machine.id, ids)
        for key in gone:
            row = dict(old["products"][key])
            loc = locals_by_global.get(key)
            item = items.get(key)
            row["id"] = str(loc.id) if loc is not None else key
            row["shopListed"] = False
            row["inStock"] = False
            row["isAvailable"] = False
            row["lockAvailable"] = False
            row["blocks"] = []
            row["availabilityLock"] = None
            row["inMachineCatalog"] = bool(item is not None and item.is_included)
            row["updatedAt"] = stamp
            products.append(row)
    categories = []
    for key, published in (old.get("categories") or {}).items():
        if key in (snapshot.get("categories") or {}):
            continue
        row = dict(published)
        row["isActive"] = False
        row["activeLock"] = None
        row["updatedAt"] = stamp
        categories.append(row)
    return products, categories


def serve(
    db: Session, machine: POSMachine, shop: Shop, publication: CatalogPublication, since: Optional[datetime]
) -> PublishedCatalog:
    """The catalog pull of a till of a shop in review mode — see the module docstring."""
    snapshot = publication.snapshot or {}
    fresh = since is None or _utc(since) < _utc(publication.published_at) + RESEND_WINDOW
    products = _products_for_till(db, machine, shop, snapshot, None if fresh else since)
    main_categories, referenced, stamps = _categories_for_till(db, machine, shop, snapshot)
    if fresh:
        categories = list(main_categories)
    else:
        cut = _utc(since)
        categories = [c for c in main_categories if stamps.get(c["id"]) is not None and stamps[c["id"]] > cut]
    if since is not None and fresh:
        dropped_products, dropped_categories = _dropped(db, machine, publication, snapshot, since)
        products.extend(dropped_products)
        categories.extend(dropped_categories)
    if since is not None and products:
        # Every category a sent product names, with its parents — as the live delta
        # merges them (`merge_categories_referenced_by_products`).
        everything = {c["id"]: c for c in main_categories}
        everything.update(referenced)
        have = {c["id"] for c in categories}
        for p in products:
            key = p.get("categoryId")
            guard = 0
            while key and key not in have and guard < 50:
                guard += 1
                row = everything.get(key)
                if row is None:
                    break
                categories.append(row)
                have.add(key)
                key = row.get("parentId")
    menu = snapshot.get("menu") if fresh else None
    return PublishedCatalog(products=products, categories=categories, menu=menu, publication=publication)


# ── The review: draft against the latest publication ─────────────────────────

_PRODUCT_FIELDS = (
    "name", "description", "categoryId", "sku", "globalSku", "barcode", "taxRate", "voucherId",
    "ticketMode", "ticketEntries", "trackStock", "isOpenPrice", "isWeighed", "unitLabel",
    "noDiscount", "allergens", "courseId", "maxPerOrder", "refillable", "maxRefills",
)
#: Compared only when both snapshots carry them: a publication made before the field
#: existed has none, and that is not a change the merchant made.
_PRODUCT_NEW_FIELDS = ("dietaryTags", "salesChannel", "requiresManagerApproval")
_CATEGORY_FIELDS = (
    "name", "description", "parentId", "sortOrder", "isActive", "color", "imageUrl", "courseId",
    "ticketMode",
)
#: Compared only when both snapshots carry them (as _PRODUCT_NEW_FIELDS).
_CATEGORY_NEW_FIELDS = ("requiresManagerApproval",)
_GROUP_FIELDS = ("name", "kind", "minSelect", "maxSelect", "freeCount", "allowQuantity", "allowPre")
_OPTION_FIELDS = ("name", "price", "isDefault", "kitchenName", "linkedProductId", "maxQty", "allergens")
_UPSELL_HOURS = ("startTime", "endTime", "weekdays")
_UPSELL_FIELDS = ("name", "triggerType", "triggerIds", "action", "productId", "message", "showPrice", "priority")
#: "חלון בחירה": compared only when both snapshots carry them (an older one does not).
_UPSELL_NEW_FIELDS = ("options", "prompt", "display", "where", "skipIfPresent", "oncePerOrder")


def _item(kind: str, ident: Any, name: Any, changes=None, detail: Optional[str] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {"type": kind, "id": str(ident), "name": name}
    if detail:
        out["detail"] = detail
    out["changes"] = changes or []
    return out


def _change(field_name: str, before: Any, after: Any, label: Optional[str] = None) -> Dict[str, Any]:
    out = {"field": field_name, "before": before, "after": after}
    if label:
        out["label"] = label
    return out


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return round(float(a), 4) == round(float(b), 4)
    return a == b


def _on_menu(row: Optional[Dict[str, Any]]) -> bool:
    return row is not None and bool(row.get("shopListed", True))


def _gate_available(gate: Optional[Dict[str, Any]]) -> Optional[bool]:
    if gate is None:
        return None
    return availability.resolve(gate.get("product", True), gate.get("company")).available


def diff(old: Optional[Dict[str, Any]], new: Optional[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """
    What a broadcast of `new` changes against `old`, per section (`SECTIONS`). Ids are
    named (a category, a product, a group) so the screen shows names, not ids.
    Operational fields (stock, pictures, the shop's / till's own availability) are not
    compared: they never wait for a broadcast.
    """
    old = old or {}
    new = new or {}
    out: Dict[str, List[Dict[str, Any]]] = {s: [] for s in SECTIONS}

    op, np_ = old.get("products") or {}, new.get("products") or {}
    og, ng = old.get("productGates") or {}, new.get("productGates") or {}
    oc_all = {**(old.get("referencedCategories") or {}), **(old.get("categories") or {})}
    nc_all = {**(new.get("referencedCategories") or {}), **(new.get("categories") or {})}
    om, nm = old.get("menu") or {}, new.get("menu") or {}
    courses = {c.get("id"): c.get("name") for c in (om.get("courses") or []) + (nm.get("courses") or [])}

    def category_name(key, old_side=False):
        if not key:
            return None
        row = (oc_all.get(key) or nc_all.get(key)) if old_side else (nc_all.get(key) or oc_all.get(key))
        return (row or {}).get("name") or key

    def product_name(key, old_side=False):
        if not key:
            return None
        row = (op.get(key) or np_.get(key)) if old_side else (np_.get(key) or op.get(key))
        return (row or {}).get("name") or key

    def shown(field_name, value, old_side=False):
        if field_name in ("categoryId", "parentId"):
            return category_name(value, old_side)
        if field_name in ("productId", "linkedProductId"):
            return product_name(value, old_side)
        if field_name == "courseId":
            return courses.get(value, value) if value else None
        if field_name == "voucherId":
            return bool(value)
        if field_name == "dietaryTags":
            return dietary.labels(value)
        return value

    def by_name(keys, *maps):
        def name_of(k):
            for m in maps:
                if k in m and isinstance(m[k], dict):
                    return m[k].get("name") or ""
            return ""
        return sorted(keys, key=lambda k: (name_of(k), k))

    # Products: on the menu (assigned and listed) or not; then what changed.
    for key in by_name(set(op) | set(np_), np_, op):
        a, b = op.get(key), np_.get(key)
        name = (b or a or {}).get("name")
        if _on_menu(b) and not _on_menu(a):
            out["products"].append(_item(
                "added", key, name, [_change("price", None, b.get("price"))],
                detail=category_name(b.get("categoryId")),
            ))
            continue
        if _on_menu(a) and not _on_menu(b):
            out["products"].append(_item("removed", key, name, detail=category_name(a.get("categoryId"))))
            continue
        if not (_on_menu(a) and _on_menu(b)):
            continue
        if not _same(a.get("price"), b.get("price")):
            out["prices"].append(_item("changed", key, name, [_change("price", a.get("price"), b.get("price"))]))
        changes = [
            _change(f, shown(f, a.get(f), True), shown(f, b.get(f)))
            for f in _PRODUCT_FIELDS
            if not _same(a.get(f), b.get(f))
        ]
        changes += [
            _change(f, shown(f, a.get(f), True), shown(f, b.get(f)))
            for f in _PRODUCT_NEW_FIELDS
            if f in a and f in b and not _same(a.get(f), b.get(f))
        ]
        if changes:
            out["products"].append(_item("changed", key, name, changes))
        before, after = _gate_available(og.get(key)), _gate_available(ng.get(key))
        if before is not None and after is not None and before != after:
            out["availability"].append(_item("changed", key, name, [_change("available", before, after)]))

    # Categories the shop's tills get.
    oc, nc = old.get("categories") or {}, new.get("categories") or {}
    for key in by_name(set(oc) | set(nc), nc, oc):
        a, b = oc.get(key), nc.get(key)
        name = (b or a or {}).get("name")
        if b is not None and a is None:
            out["categories"].append(_item("added", key, name, detail=category_name(b.get("parentId"))))
        elif a is not None and b is None:
            out["categories"].append(_item("removed", key, name))
        else:
            changes = [
                _change(f, shown(f, a.get(f), True), shown(f, b.get(f)))
                for f in _CATEGORY_FIELDS
                if not _same(a.get(f), b.get(f))
            ]
            changes += [
                _change(f, shown(f, a.get(f), True), shown(f, b.get(f)))
                for f in _CATEGORY_NEW_FIELDS
                if f in a and f in b and not _same(a.get(f), b.get(f))
            ]
            if changes:
                out["categories"].append(_item("changed", key, name, changes))

    # Modifier groups and their options.
    ogr = {g["id"]: g for g in om.get("groups") or [] if g.get("id")}
    ngr = {g["id"]: g for g in nm.get("groups") or [] if g.get("id")}
    group_names = {**{k: g.get("name") for k, g in ogr.items()}, **{k: g.get("name") for k, g in ngr.items()}}
    for key in by_name(set(ogr) | set(ngr), ngr, ogr):
        a, b = ogr.get(key), ngr.get(key)
        if b is not None and a is None:
            out["modifiers"].append(_item(
                "added", key, b.get("name"),
                [_change("option", None, o.get("price"), label=o.get("name")) for o in b.get("options") or []],
                detail="group",
            ))
            continue
        if a is not None and b is None:
            out["modifiers"].append(_item("removed", key, a.get("name"), detail="group"))
            continue
        changes = [_change(f, a.get(f), b.get(f)) for f in _GROUP_FIELDS if not _same(a.get(f), b.get(f))]
        oo = {o["id"]: o for o in a.get("options") or [] if o.get("id")}
        no = {o["id"]: o for o in b.get("options") or [] if o.get("id")}
        for oid in [o for o in no if o not in oo] + [o for o in oo if o not in no] + [o for o in no if o in oo]:
            x, y = oo.get(oid), no.get(oid)
            if y is not None and x is None:
                changes.append(_change("optionAdded", None, y.get("price"), label=y.get("name")))
            elif x is not None and y is None:
                changes.append(_change("optionRemoved", x.get("price"), None, label=x.get("name")))
            else:
                for f in _OPTION_FIELDS:
                    if not _same(x.get(f), y.get(f)):
                        changes.append(_change(
                            f"option.{f}", shown(f, x.get(f), True), shown(f, y.get(f)), label=y.get("name"),
                        ))
        if changes:
            out["modifiers"].append(_item("changed", key, b.get("name"), changes, detail="group"))

    # Which groups a category / product offers (absent = inherits, [] = none) — for the
    # categories and products this shop has.
    relevant_products = set(op) | set(np_)
    relevant_categories = set(oc_all) | set(nc_all)

    def groups_shown(ids):
        return None if ids is None else [group_names.get(g, g) for g in ids]

    for kind, relevant, namer in (
        ("categories", relevant_categories, category_name),
        ("products", relevant_products, product_name),
    ):
        ol = (om.get("links") or {}).get(kind) or {}
        nl = (nm.get("links") or {}).get(kind) or {}
        for key in sorted((set(ol) | set(nl)) & relevant, key=lambda k: (namer(k) or "", k)):
            if ol.get(key) != nl.get(key):
                out["modifiers"].append(_item(
                    "changed", key, namer(key),
                    [_change("groups", groups_shown(ol.get(key)), groups_shown(nl.get(key)))],
                    detail="links_category" if kind == "categories" else "links_product",
                ))

    # Note chips: for every dish, and per category / product.
    def chips(rows):
        return None if rows is None else [r.get("text") for r in rows]

    on, nn = om.get("notes") or {}, nm.get("notes") or {}
    if (on.get("all") or []) != (nn.get("all") or []):
        out["modifiers"].append(_item(
            "changed", "all", None, [_change("notes", chips(on.get("all") or []), chips(nn.get("all") or []))],
            detail="notes_all",
        ))
    for kind, relevant, namer in (
        ("categories", relevant_categories, category_name),
        ("products", relevant_products, product_name),
    ):
        ol, nl = on.get(kind) or {}, nn.get(kind) or {}
        for key in sorted((set(ol) | set(nl)) & relevant, key=lambda k: (namer(k) or "", k)):
            if ol.get(key) != nl.get(key):
                out["modifiers"].append(_item(
                    "changed", key, namer(key), [_change("notes", chips(ol.get(key)), chips(nl.get(key)))],
                    detail="notes_category" if kind == "categories" else "notes_product",
                ))

    # Meals: a product's slots and what each offers.
    def slots_shown(slots):
        if slots is None:
            return None
        return [
            f"{s.get('name')} ({', '.join(product_name(o.get('productId')) or '' for o in s.get('options') or [])})"
            for s in slots
        ]

    oml, nml = om.get("meals") or {}, nm.get("meals") or {}
    for key in sorted((set(oml) | set(nml)) & relevant_products, key=lambda k: (product_name(k) or "", k)):
        if oml.get(key) != nml.get(key):
            out["modifiers"].append(_item(
                "changed" if key in oml and key in nml else ("added" if key in nml else "removed"),
                key, product_name(key), [_change("meal", slots_shown(oml.get(key)), slots_shown(nml.get(key)))],
                detail="meal",
            ))

    # Upsells: their hours apart from the rest.
    ou = {u["id"]: u for u in om.get("upsells") or [] if u.get("id")}
    nu = {u["id"]: u for u in nm.get("upsells") or [] if u.get("id")}
    for key in by_name(set(ou) | set(nu), nu, ou):
        a, b = ou.get(key), nu.get(key)
        if b is not None and a is None:
            out["menu"].append(_item("added", key, b.get("name"), detail="upsell"))
            continue
        if a is not None and b is None:
            out["menu"].append(_item("removed", key, a.get("name"), detail="upsell"))
            continue
        hours = [_change(f, a.get(f), b.get(f)) for f in _UPSELL_HOURS if not _same(a.get(f), b.get(f))]
        if hours:
            out["hours"].append(_item("changed", key, b.get("name"), hours, detail="upsell"))
        others = []
        for f in _UPSELL_FIELDS:
            if _same(a.get(f), b.get(f)):
                continue
            if f == "triggerIds":
                namer = category_name if b.get("triggerType") == "category" else product_name
                others.append(_change(
                    f, [namer(i, True) for i in a.get(f) or []], [namer(i) for i in b.get(f) or []],
                ))
            else:
                others.append(_change(f, shown(f, a.get(f), True), shown(f, b.get(f))))
        for f in _UPSELL_NEW_FIELDS:
            if f not in a or f not in b or _same(a.get(f), b.get(f)):
                continue
            if f == "options":
                def option_names(opts, old_side=False):
                    return [
                        (category_name if (o or {}).get("type") == "category" else product_name)((o or {}).get("id"), old_side)
                        for o in opts or []
                    ]
                others.append(_change(f, option_names(a.get(f), True), option_names(b.get(f))))
            else:
                others.append(_change(f, a.get(f), b.get(f)))
        if others:
            out["menu"].append(_item("changed", key, b.get("name"), others, detail="upsell"))

    # Courses.
    oco = {c["id"]: c for c in om.get("courses") or [] if c.get("id")}
    nco = {c["id"]: c for c in nm.get("courses") or [] if c.get("id")}
    for key in by_name(set(oco) | set(nco), nco, oco):
        a, b = oco.get(key), nco.get(key)
        if b is not None and a is None:
            out["menu"].append(_item("added", key, b.get("name"), detail="course"))
        elif a is not None and b is None:
            out["menu"].append(_item("removed", key, a.get("name"), detail="course"))
        else:
            changes = [_change(f, a.get(f), b.get(f)) for f in ("name", "sortOrder") if not _same(a.get(f), b.get(f))]
            if changes:
                out["menu"].append(_item("changed", key, b.get("name"), changes, detail="course"))
    # "תפריטים" (docs/SPEC_MENUS.md): menus, their assignments and fallbacks.
    if old.get("catalogMenus") or new.get("catalogMenus"):
        from app.services import catalog_menus as catalog_menus_service

        out["menu"].extend(catalog_menus_service.diff(old.get("catalogMenus"), new.get("catalogMenus")))
    return out


def counts_of(sections: Dict[str, List[Any]]) -> Dict[str, int]:
    return {s: len(sections.get(s) or []) for s in SECTIONS}


def targets(db: Session, shop: Shop) -> List[Dict[str, Any]]:
    """The tills a broadcast reaches: the shop's active ones."""
    from app.services.machine_status import is_online

    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
    )
    return [
        {
            "machineId": str(m.id),
            "name": m.name,
            "posNumber": m.pos_number,
            "areaName": getattr(m, "area_name", None),
            "online": is_online(m.last_heartbeat_at),
            "lastSyncAt": _iso(m.last_sync_at),
        }
        for m in machines
    ]


def preview(db: Session, shop: Shop) -> Dict[str, Any]:
    """
    The review screen of one shop: its mode and why, the version its tills have, every
    change the draft would broadcast (`diff`), and the tills it would reach. In review
    mode with no publication yet, makes the first one (its live catalog) — as its first
    pull would.
    """
    state = review_state(db, shop)
    publication = ensure_publication(db, shop) if state.enabled else None
    live = build_snapshot(db, shop) if state.enabled else None
    sections = diff(publication.snapshot, live) if publication is not None else {s: [] for s in SECTIONS}
    counts = counts_of(sections)
    current = fingerprint(live) if live is not None else None
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        "companyId": str(shop.company_id) if shop.company_id else None,
        "review": state.out(),
        "publication": publication_out(publication),
        "fingerprint": current,
        "hasChanges": publication is not None and current != publication.fingerprint,
        "sections": sections,
        "counts": counts,
        "total": sum(counts.values()),
        "targets": targets(db, shop),
    }


def broadcast(
    db: Session,
    shop: Shop,
    user: Optional[User],
    *,
    expected_fingerprint: Optional[str] = None,
    note: Optional[str] = None,
    notify: bool = True,
) -> CatalogPublication:
    """
    "אישור ושידור": the draft as it stands becomes the shop's next version, and the shop's
    tills are woken to pull it. 409 `menu_review_off` out of review mode (its tills get
    every change already); 409 `{code: menu_changed_since_preview}` when the draft moved
    after the review the user approved (`expected_fingerprint`); 409
    `menu_nothing_to_broadcast` when the draft is the version the tills have.
    """
    from app.services.catalog_notify import notify_machines_for_shop

    if not review_state(db, shop).enabled:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=REVIEW_OFF)
    current = ensure_publication(db, shop)
    snapshot = build_snapshot(db, shop)
    draft = fingerprint(snapshot)
    if expected_fingerprint and draft != expected_fingerprint:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": CHANGED_SINCE_PREVIEW, "shopId": str(shop.id)},
        )
    if current is not None and current.fingerprint == draft:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NOTHING_TO_BROADCAST)
    made = _new_publication(db, shop, kind=KIND_BROADCAST, snapshot=snapshot, previous=current, user=user, note=note)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=BROADCAST_CONFLICT)
    logger.info("menu review: shop %s broadcast v%s by %s", shop.id, made.version, _user_name(user))
    if notify:
        notify_machines_for_shop(db, str(shop.id), reason=NOTIFY_REASON)
    return made


def history(db: Session, shop: Shop, limit: int = 50) -> List[Dict[str, Any]]:
    rows = (
        db.query(CatalogPublication)
        .filter(CatalogPublication.shop_id == shop.id)
        .order_by(CatalogPublication.version.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )
    return [publication_out(p) for p in rows]


# ── Who may ──────────────────────────────────────────────────────────────────


def check_read(db: Session, user: User, shop: Shop) -> None:
    """Those in charge of the shop: the super admin, a distributor, its company's managers, its own."""
    from app.services.company_hierarchy import user_covers_shop
    from app.services.permission_matrix import SHOP_SCOPED_ROLES

    role = getattr(user, "role", None)
    if role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return
    if role == UserRole.COMPANY_MANAGER and user_covers_shop(db, user, shop):
        return
    if role in SHOP_SCOPED_ROLES and str(getattr(user, "shop_id", None)) == str(shop.id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def check_broadcast(db: Session, user: User, shop: Shop) -> None:
    """Broadcasting is a catalog write: whoever may edit the shop's catalog."""
    from app.services.permission_matrix import Action, Resource, roles_for

    if getattr(user, "role", None) not in roles_for(Resource.CATALOG, Action.WRITE):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    check_read(db, user, shop)


def shops_in_scope(
    db: Session, user: User, tenant_id, *, company_id=None, shop_id=None
) -> List[Shop]:
    """The active shops of the tenant this user sees, narrowed to a company (and its subsidiaries) or a shop."""
    from app.services.company_hierarchy import descendant_company_ids, visible_shop_ids
    from app.services.permission_matrix import SHOP_SCOPED_ROLES

    q = db.query(Shop).filter(Shop.tenant_id == tenant_id)
    role = getattr(user, "role", None)
    if role == UserRole.COMPANY_MANAGER:
        q = q.filter(Shop.id.in_(visible_shop_ids(db, user)))
    elif role in SHOP_SCOPED_ROLES:
        q = q.filter(Shop.id == user.shop_id)
    elif role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return []
    if shop_id is not None:
        q = q.filter(Shop.id == shop_id)
    elif company_id is not None:
        ids = list({*descendant_company_ids(db, company_id), company_id})
        q = q.filter(Shop.company_id.in_(ids))
    return [s for s in q.order_by(Shop.name).all() if getattr(s, "is_active", True) is not False]


def status_for(db: Session, shops: Sequence[Shop]) -> Dict[str, Any]:
    """For the catalog pages' banner: the shops in review mode, and what each has not broadcast."""
    out = []
    for shop in shops:
        state = review_state(db, shop)
        if not state.enabled:
            continue
        publication = ensure_publication(db, shop)
        live = build_snapshot(db, shop)
        current = fingerprint(live)
        has_changes = current != publication.fingerprint
        pending = sum(counts_of(diff(publication.snapshot, live)).values()) if has_changes else 0
        out.append({
            "shopId": str(shop.id),
            "shopName": shop.name,
            "reason": state.reason,
            "version": publication.version,
            "publishedAt": _iso(publication.published_at),
            "hasChanges": has_changes,
            "pending": pending,
        })
    return {"shops": out, "pending": sum(s["pending"] for s in out)}


# ── "סוגי עבודה" on the shop page ─────────────────────────────────────────────


def _parameter(db: Session, key: str) -> Optional[TillParameter]:
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    return db.query(TillParameter).filter(TillParameter.key == key).first()


def _tables_options(parameter: Optional[TillParameter]) -> Tuple[List[str], Optional[str], Optional[str]]:
    """`(the modes that are on, the "off" option, the default on — «קופה אחת»)`."""
    from app.services.tables import MODE_OFF, MODE_SINGLE, mode_of

    options = list(parameter.enum_options or []) if parameter is not None else []
    off = next((o for o in options if mode_of(o) == MODE_OFF), None)
    on = [o for o in options if mode_of(o) != MODE_OFF]
    single = next((o for o in on if mode_of(o) == MODE_SINGLE), on[0] if on else None)
    return on, off, single


def work_types_out(db: Session, shop: Shop, user: User) -> Dict[str, Any]:
    parameter = _parameter(db, TABLES_MODE_KEY)
    on_modes, _off, default_on = _tables_options(parameter)
    state = review_state(db, shop)
    row = db.query(ShopWorkTypes).filter(ShopWorkTypes.shop_id == shop.id).first()
    return {
        "shopId": str(shop.id),
        "tables": state.tables_enabled,
        "tablesMode": state.shop_tables_mode,
        "tablesModeOptions": on_modes,
        "tablesModeDefault": default_on,
        "tablesTills": state.tables_tills,
        "takeAway": None if row is None else row.take_away,
        "quickOrder": None if row is None else row.quick_order,
        "delivery": None if row is None else row.delivery,
        "review": state.out(),
        "reviewOverrideOptions": list(REVIEW_OPTIONS),
        "canEdit": getattr(user, "role", None) == UserRole.SUPER_ADMIN,
    }


def _upsert_value(db: Session, parameter: TillParameter, scope_type: str, scope_id, value: Any, now: datetime) -> None:
    row = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == scope_id,
        )
        .first()
    )
    if row is None:
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=scope_id,
            value=value, created_at=now, updated_at=now,
        ))
    else:
        row.value = value
        row.updated_at = now


def set_work_types(
    db: Session,
    shop: Shop,
    user: User,
    *,
    tables: Optional[bool] = None,
    tables_mode: Optional[str] = None,
    take_away: Optional[bool] = None,
    quick_order: Optional[bool] = None,
    delivery: Optional[bool] = None,
    review_override: Optional[str] = None,
) -> bool:
    """
    Save the card. `tables` writes the shop's own `tablesMode`: off — «כבוי» for the shop,
    and the shop's points of sale and tills let go of their own value (or they would keep
    tables on); on — `tables_mode` (default «קופה אחת») when the shop has no tables yet, or
    when another mode is asked for. `review_override` writes the shop's own
    `menuBroadcastReview`. Take Away, quick order and deliveries are stored as they are:
    nothing reads them yet. Entering review mode makes the first publication now (the live
    catalog as it stands); leaving it closes the open one. Commits. True when a till
    parameter changed (the tills are told by the caller).
    """
    from app.models.shop_area import ShopArea

    if getattr(user, "role", None) != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    now = _now()
    before = review_state(db, shop)
    parameters_changed = False

    if tables is not None or tables_mode is not None:
        parameter = _parameter(db, TABLES_MODE_KEY)
        if parameter is None:  # pragma: no cover - created just above
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="tablesMode_parameter_missing")
        on_modes, off, default_on = _tables_options(parameter)
        if tables is False:
            if off is None:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bad_tables_mode")
            _upsert_value(db, parameter, "shop", shop.id, off, now)
            area_ids = [a for (a,) in db.query(ShopArea.id).filter(ShopArea.shop_id == shop.id).all()]
            till_ids = [m for (m,) in db.query(POSMachine.id).filter(POSMachine.shop_id == shop.id).all()]
            below = [*area_ids, *till_ids]
            if below:
                db.query(TillParameterValue).filter(
                    TillParameterValue.parameter_id == parameter.id,
                    TillParameterValue.scope_type.in_(("area", "machine")),
                    TillParameterValue.scope_id.in_(below),
                ).delete(synchronize_session=False)
            parameter.updated_at = now
            parameters_changed = True
        else:
            wanted = tables_mode or (None if before.tables_enabled else default_on)
            if wanted is not None:
                if wanted not in on_modes:
                    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bad_tables_mode")
                if not (before.shop_tables_mode == wanted and before.tables_enabled):
                    _upsert_value(db, parameter, "shop", shop.id, wanted, now)
                    parameters_changed = True

    if review_override is not None:
        if review_override not in REVIEW_OPTIONS:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bad_review_override")
        parameter = _parameter(db, REVIEW_KEY)
        if parameter is None:  # pragma: no cover - created just above
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="menuBroadcastReview_parameter_missing")
        if review_override != before.override:
            _upsert_value(db, parameter, "shop", shop.id, review_override, now)
            parameters_changed = True

    if take_away is not None or quick_order is not None or delivery is not None:
        row = db.query(ShopWorkTypes).filter(ShopWorkTypes.shop_id == shop.id).first()
        if row is None:
            row = ShopWorkTypes(shop_id=shop.id, tenant_id=shop.tenant_id)
            db.add(row)
        if take_away is not None:
            row.take_away = take_away
        if quick_order is not None:
            row.quick_order = quick_order
        if delivery is not None:
            row.delivery = delivery
        row.updated_at = now
        row.updated_by_user_id = getattr(user, "id", None)

    db.flush()
    after = review_state(db, shop)
    db.commit()
    if after.enabled and not before.enabled:
        ensure_publication(db, shop)
    elif before.enabled and not after.enabled:
        note_live(db, shop.id)
    return parameters_changed
