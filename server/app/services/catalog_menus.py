"""
"תפריטים" (docs/SPEC_MENUS.md): named sales menus by schedule — definitions, assignments,
what each till is sent, what is active where, and the report by menu.

* **Who** — read by anyone whose catalog reaches the menu's company; written by the
  catalog roles (`app/services/menu.check_company_write`: a company's menus by whoever
  covers the company, the whole organization's by a super admin or distributor).
  Assigning is a write at the target: a company, shop, point of sale or till the user
  manages (`till_messages.resolve_target`), and only a menu whose company is the target's
  own or one above it.
* **The rules** — app/services/catalog_menu_rules.py, pure, the same computation the till
  runs offline (golden fixtures). Nothing here decides which menu is active any other way.
* **The till's copy** — one `catalogMenus` block in `GET /sync/{m}/catalog`
  (`block_for_pull`): the active menus assigned along the till's own chain (itself, its
  point of sale, its shop, its company and the companies above), their assignments with
  the level each came from, and the fallback that applies to it. Sent whole on a full
  pull, and on a delta pull only when the organization's menus changed after `since` (or
  the till moved area) — absent means "keep what you have". A product the till holds as a
  local copy is named by the copy's id, as its catalog rows are.
* **Review mode** ("שידור תפריט", docs/SPEC_MENU_BROADCAST_REVIEW.md) — a shop in review
  mode serves its tills the menus of its latest publication: the publication snapshot
  carries the shop's menus data (`snapshot_block`), and a change waits for "אישור ושידור"
  like any other menu change (`diff` lists it under "menu").
* **Sold lines** — the till stamps each line with the menu active when it was added and
  where its price came from (`transaction_items.menu_id`, `menu_name`, `price_source`);
  `menu_sales_report` breaks the takings down by them.
"""
from __future__ import annotations

import logging
import uuid
import weakref
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import case, func
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from app.models.catalog_menu import (
    ASSIGNMENT_LEVELS,
    FALLBACK_CATALOG,
    CatalogMenu,
    CatalogMenuAssignment,
    CatalogMenuCategory,
    CatalogMenuFallback,
    CatalogMenuProduct,
    CatalogMenuSyncState,
)
from app.models.category import Category
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.schemas.catalog_menu import MenuIn, TargetAssignmentsIn
from app.services import catalog_menu_rules as R

logger = logging.getLogger(__name__)

#: `reason` on the catalog notify that makes the tills pull the menus now.
NOTIFY_REASON = "catalog_menus_updated"

#: 4xx details.
NOT_FOUND = "catalog_menu_not_found"
FORBIDDEN = "catalog_menu_forbidden"
UNKNOWN_CATEGORY = "catalog_menu_unknown_category"
UNKNOWN_PRODUCT = "catalog_menu_unknown_product"
OUT_OF_REACH = "catalog_menu_out_of_reach"
BAD_TIME = "catalog_menu_bad_time"

TENANT_WIDE_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _utc(value)
    return value.isoformat() if value is not None else None


def _as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _money(value) -> Optional[float]:
    if value is None:
        return None
    return float(Decimal(str(value)).quantize(Decimal("0.01")))


# ── Is the feature's storage there at all ────────────────────────────────────

_READY: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_NEEDED_TABLES = (
    "catalog_menus", "catalog_menu_categories", "catalog_menu_products",
    "catalog_menu_assignments", "catalog_menu_fallbacks", "catalog_menu_sync_state",
)


def tables_ready(db: Session) -> bool:
    """
    The tables exist — always on a migrated database; a test world that builds only the
    tables it is about has none of them, and its pulls carry no menus (as before menus).
    Asked on the session's own connection, remembered per engine once true.
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
        inspector = sa_inspect(db.connection())
        ok = all(inspector.has_table(name) for name in _NEEDED_TABLES)
    except Exception:  # pragma: no cover - nothing to inspect
        return False
    if ok:
        try:
            _READY[engine] = True
        except TypeError:  # pragma: no cover
            pass
    return ok


# ── Change tracking ───────────────────────────────────────────────────────────


def bump(db: Session, tenant_id) -> None:
    """The organization's menus changed: the next delta pull of each till carries them."""
    now = _now()
    row = db.query(CatalogMenuSyncState).filter(CatalogMenuSyncState.tenant_id == tenant_id).first()
    if row is None:
        db.add(CatalogMenuSyncState(tenant_id=tenant_id, changed_at=now))
    else:
        row.changed_at = now
    db.flush()


def changed_at(db: Session, tenant_id) -> Optional[datetime]:
    if tenant_id is None or not tables_ready(db):
        return None
    row = (
        db.query(CatalogMenuSyncState.changed_at)
        .filter(CatalogMenuSyncState.tenant_id == tenant_id)
        .first()
    )
    return _utc(row[0]) if row is not None else None


def notify_targets(db: Session, tenant_id) -> List[Tuple[str, str]]:
    return [
        (str(m.tenant_id), str(m.id))
        for m in db.query(POSMachine)
        .filter(POSMachine.tenant_id == tenant_id, POSMachine.is_active.is_(True))
        .all()
        if m.tenant_id
    ]


def publish_notify(targets: Iterable[Tuple[str, str]]) -> None:
    from app.services.ably_notify import publish_catalog_notify

    for tenant_id, machine_id in targets:
        try:
            publish_catalog_notify(tenant_id, machine_id, reason=NOTIFY_REASON)
        except Exception:  # pragma: no cover - best effort, the till also pulls on sync
            pass


# ── Who may ───────────────────────────────────────────────────────────────────


def _visible_companies(db: Session, user: User) -> Optional[Set[str]]:
    from app.services.menu import _visible_company_ids

    return _visible_company_ids(db, user)


def _menu_visible(m: CatalogMenu, visible: Optional[Set[str]]) -> bool:
    return visible is None or m.company_id is None or str(m.company_id) in visible


def check_menu_write(db: Session, user: User, tenant_id, company_id) -> None:
    from app.services.menu import check_company_write

    try:
        check_company_write(db, user, tenant_id, company_id)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_403_FORBIDDEN:
            raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN) from exc
        raise


def may_write(db: Session, user: User, tenant_id, company_id) -> bool:
    try:
        check_menu_write(db, user, tenant_id, company_id)
    except HTTPException:
        return False
    return True


def get_menu(db: Session, user: User, tenant_id, menu_id) -> CatalogMenu:
    ident = _as_uuid(menu_id)
    row = db.query(CatalogMenu).filter(CatalogMenu.id == ident).first() if ident else None
    if row is None or str(row.tenant_id) != str(tenant_id):
        raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
    if not _menu_visible(row, _visible_companies(db, user)):
        raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
    return row


# ── The chain a till sits in ─────────────────────────────────────────────────


@dataclass(frozen=True)
class Target:
    level: str
    id: uuid.UUID
    #: For a company: how far above the till's own company (0: its own).
    depth: int = 0

    @property
    def key(self) -> Tuple[str, str]:
        return (self.level, str(self.id))


def company_chain(db: Session, company_id) -> List[uuid.UUID]:
    """The company and the companies above it, nearest first."""
    from app.services.company_hierarchy import ancestor_company_ids

    if company_id is None:
        return []
    return [company_id, *ancestor_company_ids(db, company_id)]


def chain_for(
    db: Session, shop: Optional[Shop], *, area_id=None, machine_id=None, company_id=None,
) -> List[Target]:
    """Most specific first: the till, its point of sale, its shop, its company and above."""
    out: List[Target] = []
    if machine_id is not None:
        out.append(Target("machine", machine_id))
    if area_id is not None:
        out.append(Target("area", area_id))
    if shop is not None:
        out.append(Target("shop", shop.id))
        company_id = shop.company_id
    for depth, cid in enumerate(company_chain(db, company_id)):
        out.append(Target("company", cid, depth))
    return out


def chain_for_machine(db: Session, machine: POSMachine) -> List[Target]:
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
    if shop is None:
        return [Target("machine", machine.id)] if machine.id is not None else []
    return chain_for(db, shop, area_id=getattr(machine, "area_id", None), machine_id=machine.id)


# ── The data: menus and their assignments for a set of targets ───────────────


def _schedule_of(m: CatalogMenu) -> Dict[str, Any]:
    return {
        "always": bool(m.always),
        "days": sorted(int(d) for d in m.weekdays) if m.weekdays is not None else None,
        "ranges": [
            [r.get("start"), r.get("end")]
            for r in (m.time_ranges or [])
            if isinstance(r, dict) and r.get("start") and r.get("end")
        ],
        "from": m.valid_from.isoformat() if m.valid_from else None,
        "to": m.valid_to.isoformat() if m.valid_to else None,
    }


def _items(db: Session, menu_ids: Sequence) -> Tuple[Dict[str, List[Tuple]], Dict[str, List[Tuple]]]:
    """`({menu: [(row, category name)]}, {menu: [(row, product name, catalog price, category id)]})`, in order."""
    cats: Dict[str, List[Tuple]] = {}
    prods: Dict[str, List[Tuple]] = {}
    if not menu_ids:
        return cats, prods
    for row, name in (
        db.query(CatalogMenuCategory, Category.name)
        .join(Category, Category.id == CatalogMenuCategory.category_id)
        .filter(CatalogMenuCategory.menu_id.in_(list(menu_ids)))
        .order_by(CatalogMenuCategory.menu_id, CatalogMenuCategory.sort_order)
        .all()
    ):
        cats.setdefault(str(row.menu_id), []).append((row, name))
    for row, name, price, category_id in (
        db.query(CatalogMenuProduct, Product.name, Product.price, Product.category_id)
        .join(Product, Product.id == CatalogMenuProduct.product_id)
        .filter(CatalogMenuProduct.menu_id.in_(list(menu_ids)))
        .order_by(CatalogMenuProduct.menu_id, CatalogMenuProduct.sort_order)
        .all()
    ):
        prods.setdefault(str(row.menu_id), []).append((row, name, price, category_id))
    return cats, prods


def _wire_menu(m: CatalogMenu, cats: List[Tuple], prods: List[Tuple]) -> Dict[str, Any]:
    """A menu as the data carries it — names included, for the review's diff only."""
    products = []
    for row, name, _price, _cat in prods:
        entry: Dict[str, Any] = {"id": str(row.product_id), "name": name}
        if row.price is not None:
            entry["price"] = _money(row.price)
        products.append(entry)
    return {
        "id": str(m.id),
        "name": m.name,
        "channel": m.channel or "both",
        "schedule": _schedule_of(m),
        "categories": [
            {"id": str(row.category_id), "all": bool(row.all_products), "name": name} for row, name in cats
        ],
        "products": products,
    }


def _data(db: Session, tenant_id, targets: Optional[Sequence[Target]]) -> Dict[str, Any]:
    """
    The active menus assigned to `targets` (None: anywhere in the organization), the
    assignments and the fallbacks set on them: `{"menus": {id: menu}, "assignments":
    [{menuId, level, targetId, priority}], "fallbacks": [{level, targetId, mode}]}`.
    """
    a_q = db.query(CatalogMenuAssignment).filter(CatalogMenuAssignment.tenant_id == tenant_id)
    f_q = db.query(CatalogMenuFallback).filter(CatalogMenuFallback.tenant_id == tenant_id)
    keys: Optional[Set[Tuple[str, str]]] = None
    if targets is not None:
        ids = list({t.id for t in targets})
        if not ids:
            return {"menus": {}, "assignments": [], "fallbacks": []}
        a_q = a_q.filter(CatalogMenuAssignment.target_id.in_(ids))
        f_q = f_q.filter(CatalogMenuFallback.target_id.in_(ids))
        keys = {t.key for t in targets}
    rows = [r for r in a_q.all() if keys is None or (r.level, str(r.target_id)) in keys]
    fallbacks = [f for f in f_q.all() if keys is None or (f.level, str(f.target_id)) in keys]
    menu_ids = list({r.menu_id for r in rows})
    menus = (
        db.query(CatalogMenu)
        .filter(CatalogMenu.id.in_(menu_ids), CatalogMenu.is_active.is_(True))
        .all()
        if menu_ids else []
    )
    cats, prods = _items(db, [m.id for m in menus])
    wire = {str(m.id): _wire_menu(m, cats.get(str(m.id), []), prods.get(str(m.id), [])) for m in menus}
    rows = [r for r in rows if str(r.menu_id) in wire]
    # Named for the review's diff only (`content_of` leaves the names out).
    names = _target_names(db, [(r.level, r.target_id) for r in rows] + [(f.level, f.target_id) for f in fallbacks])
    return {
        "menus": wire,
        "assignments": sorted(
            (
                {
                    "menuId": str(r.menu_id), "level": r.level, "targetId": str(r.target_id),
                    "priority": r.priority or 0, "targetName": names.get((r.level, str(r.target_id))),
                }
                for r in rows
            ),
            key=lambda a: (a["level"], a["targetId"], a["menuId"]),
        ),
        "fallbacks": sorted(
            (
                {
                    "level": f.level, "targetId": str(f.target_id), "mode": f.mode,
                    "targetName": names.get((f.level, str(f.target_id))),
                }
                for f in fallbacks
            ),
            key=lambda f: (f["level"], f["targetId"]),
        ),
    }


def content_of(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """What of the menus data a broadcast changes: everything but the targets' names."""
    data = data or _empty_data()
    return {
        "menus": data.get("menus") or {},
        "assignments": [{k: v for k, v in a.items() if k != "targetName"} for a in data.get("assignments") or []],
        "fallbacks": [{k: v for k, v in f.items() if k != "targetName"} for f in data.get("fallbacks") or []],
    }


def _empty_data() -> Dict[str, Any]:
    return {"menus": {}, "assignments": [], "fallbacks": []}


def block_of(
    data: Optional[Dict[str, Any]],
    chain: Sequence[Target],
    *,
    local_ids: Optional[Dict[str, str]] = None,
    updated_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    The `catalogMenus` block of a till standing in `chain`, from `data` (live or a
    publication's): only what is assigned along the chain, each assignment with its level
    and depth, the fallback of the most specific level that sets one, and no names.
    """
    data = data or _empty_data()
    local_ids = local_ids or {}
    where = {t.key: (i, t) for i, t in enumerate(chain)}
    assignments = []
    for a in data.get("assignments") or []:
        hit = where.get((a.get("level"), a.get("targetId")))
        if hit is None:
            continue
        assignments.append({
            "menuId": a["menuId"], "level": a["level"], "depth": hit[1].depth, "priority": a.get("priority") or 0,
        })
    assignments.sort(key=lambda a: (-R.rank(a), -a["priority"], a["menuId"]))
    menus_data = data.get("menus") or {}
    menus = []
    for mid in sorted({a["menuId"] for a in assignments}):
        m = menus_data.get(mid)
        if m is None:
            continue
        menus.append({
            "id": m["id"],
            "name": m.get("name"),
            "channel": m.get("channel") or "both",
            "schedule": m.get("schedule") or {},
            "categories": [{"id": c["id"], "all": bool(c.get("all", True))} for c in m.get("categories") or []],
            "products": [
                {"id": local_ids.get(p["id"], p["id"]), **({"price": p["price"]} if p.get("price") is not None else {})}
                for p in m.get("products") or []
            ],
        })
    known = {m["id"] for m in menus}
    assignments = [a for a in assignments if a["menuId"] in known]
    fallback, best = FALLBACK_CATALOG, None
    for f in data.get("fallbacks") or []:
        hit = where.get((f.get("level"), f.get("targetId")))
        if hit is not None and (best is None or hit[0] < best):
            best, fallback = hit[0], f.get("mode") or FALLBACK_CATALOG
    return {
        "updatedAt": _iso(updated_at),
        "fallback": fallback,
        "menus": menus,
        "assignments": assignments,
    }


def _local_ids(db: Session, machine_id, data: Dict[str, Any]) -> Dict[str, str]:
    """The till's own copies of the menus' products: `{global id: the copy's id}`."""
    if machine_id is None:
        return {}
    wanted = [_as_uuid(p["id"]) for m in (data.get("menus") or {}).values() for p in m.get("products") or []]
    wanted = [w for w in wanted if w is not None]
    if not wanted:
        return {}
    return {
        str(g): str(i)
        for i, g in db.query(Product.id, Product.global_product_id).filter(
            Product.pos_machine_id == machine_id, Product.global_product_id.in_(wanted)
        )
    }


def block_for_machine(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """The live `catalogMenus` block of a till (whatever its shop's review mode)."""
    if machine.tenant_id is None or not tables_ready(db):
        return block_of(None, [])
    chain = chain_for_machine(db, machine)
    data = _data(db, machine.tenant_id, chain)
    return block_of(
        data, chain, local_ids=_local_ids(db, machine.id, data), updated_at=changed_at(db, machine.tenant_id),
    )


def snapshot_block(db: Session, shop: Shop) -> Optional[Dict[str, Any]]:
    """
    The shop's menus data for a publication (app/services/menu_broadcast.build_snapshot):
    everything assigned to the shop, its points of sale, its tills, its company and the
    companies above. None when there is nothing at all, so a shop without menus keeps the
    fingerprint it had before menus existed.
    """
    if not tables_ready(db):
        return None
    targets = chain_for(db, shop)
    targets += [
        Target("area", a) for (a,) in db.query(ShopArea.id).filter(ShopArea.shop_id == shop.id).all()
    ]
    targets += [
        Target("machine", m) for (m,) in db.query(POSMachine.id).filter(POSMachine.shop_id == shop.id).all()
    ]
    data = _data(db, shop.tenant_id, targets)
    if not data["assignments"] and not data["fallbacks"]:
        return None
    return data


def block_for_pull(db: Session, machine: POSMachine, since: Optional[datetime], review_pull) -> Optional[Dict[str, Any]]:
    """
    What `GET /sync/{m}/catalog` sends of the menus: the block, or None ("keep what you
    have") on a delta pull it is not new to. `review_pull` is menu_broadcast's answer for
    this pull — a shop in review mode serves its publication's menus.
    """
    if machine.tenant_id is None or not tables_ready(db):
        return None
    moved = _utc(getattr(machine, "area_changed_at", None)) if isinstance(
        getattr(machine, "area_changed_at", None), datetime
    ) else None
    published = getattr(review_pull, "published", None) if review_pull is not None else None
    if published is not None:
        from app.services.menu_broadcast import RESEND_WINDOW

        publication = published.publication
        stamp = _utc(publication.published_at)
        fresh = since is None or _utc(since) < stamp + RESEND_WINDOW
        if not fresh and not (moved is not None and moved > _utc(since)):
            return None
        data = (publication.snapshot or {}).get("catalogMenus") or _empty_data()
        chain = chain_for_machine(db, machine)
        return block_of(data, chain, local_ids=_local_ids(db, machine.id, data), updated_at=stamp)
    live_since = getattr(review_pull, "live_since", since) if review_pull is not None else since
    if live_since is not None:
        cut = _utc(live_since)
        changed = changed_at(db, machine.tenant_id)
        if not ((changed is not None and changed > cut) or (moved is not None and moved > cut)):
            return None
    return block_for_machine(db, machine)


def _review_data(db: Session, shop: Shop) -> Tuple[Optional[Dict[str, Any]], str]:
    """`(the shop's data as its tills have it, "live" | "published")`."""
    from app.services import menu_broadcast as B

    try:
        if B.tables_ready(db) and B.review_state(db, shop).enabled:
            publication = B.latest_publication(db, shop.id)
            if publication is not None and publication.closed_at is None:
                return (publication.snapshot or {}).get("catalogMenus") or _empty_data(), "published"
    except HTTPException:  # pragma: no cover - defensive
        pass
    return None, "live"


# ── Local time ───────────────────────────────────────────────────────────────


def tenant_zone(db: Session, tenant_id):
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    return _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))


def local_moment(db: Session, tenant_id, at: Optional[str]) -> datetime:
    """
    `at` as a local wall-clock moment (naive): an ISO time with an offset is converted to
    the organization's zone; one without is taken as local already; none — now.
    """
    zone = tenant_zone(db, tenant_id)
    if not at:
        return datetime.now(timezone.utc).astimezone(zone).replace(tzinfo=None, second=0, microsecond=0)
    try:
        value = datetime.fromisoformat(str(at).strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise _bad(BAD_TIME) from exc
    if value.tzinfo is not None:
        value = value.astimezone(zone).replace(tzinfo=None)
    return value.replace(second=0, microsecond=0)


def resolve_at(
    db: Session, machine: POSMachine, at_utc: datetime, surface: str = R.SURFACE_POS,
) -> Dict[str, Any]:
    """The menu active on `machine` at the instant `at_utc` — the till's own answer, live data."""
    zone = tenant_zone(db, machine.tenant_id)
    local = _utc(at_utc).astimezone(zone).replace(tzinfo=None)
    return R.resolve(block_for_machine(db, machine), local, surface)


# ── Dashboard: menus ──────────────────────────────────────────────────────────


def _company_names(db: Session, ids: Iterable) -> Dict[str, str]:
    wanted = [i for i in {_as_uuid(x) for x in ids} if i is not None]
    if not wanted:
        return {}
    return {str(c.id): c.name for c in db.query(Company).filter(Company.id.in_(wanted)).all()}


def _target_names(db: Session, rows: Iterable[Tuple[str, Any]]) -> Dict[Tuple[str, str], str]:
    by_level: Dict[str, Set[uuid.UUID]] = {}
    for level, ident in rows:
        u = _as_uuid(ident)
        if u is not None:
            by_level.setdefault(level, set()).add(u)
    out: Dict[Tuple[str, str], str] = {}
    models = {"company": Company, "shop": Shop, "area": ShopArea, "machine": POSMachine}
    for level, ids in by_level.items():
        model = models.get(level)
        if model is None:
            continue
        for row in db.query(model).filter(model.id.in_(list(ids))).all():
            out[(level, str(row.id))] = row.name
    return out


def menu_out(
    db: Session,
    user: User,
    m: CatalogMenu,
    cats: List[Tuple],
    prods: List[Tuple],
    assignments: List[CatalogMenuAssignment],
    names: Dict[Tuple[str, str], str],
    companies: Dict[str, str],
    can_edit: Optional[bool] = None,
) -> Dict[str, Any]:
    if can_edit is None:
        can_edit = may_write(db, user, m.tenant_id, m.company_id)
    return {
        "id": str(m.id),
        "name": m.name,
        "companyId": str(m.company_id) if m.company_id else None,
        "companyName": companies.get(str(m.company_id)) if m.company_id else None,
        "channel": m.channel or "both",
        "isActive": bool(m.is_active),
        "always": bool(m.always),
        "days": sorted(int(d) for d in m.weekdays) if m.weekdays is not None else None,
        "ranges": [
            {"start": r.get("start"), "end": r.get("end")}
            for r in (m.time_ranges or []) if isinstance(r, dict)
        ],
        "validFrom": m.valid_from.isoformat() if m.valid_from else None,
        "validTo": m.valid_to.isoformat() if m.valid_to else None,
        "color": m.color,
        "sortOrder": m.sort_order or 0,
        "categories": [
            {"categoryId": str(row.category_id), "name": name, "allProducts": bool(row.all_products)}
            for row, name in cats
        ],
        "products": [
            {
                "productId": str(row.product_id),
                "name": name,
                "categoryId": str(category_id) if category_id else None,
                "price": _money(row.price),
                "catalogPrice": _money(price),
            }
            for row, name, price, category_id in prods
        ],
        "assignments": [
            {
                "level": a.level,
                "targetId": str(a.target_id),
                "targetName": names.get((a.level, str(a.target_id))),
                "priority": a.priority or 0,
            }
            for a in sorted(assignments, key=lambda a: (ASSIGNMENT_LEVELS.index(a.level), -(a.priority or 0)))
        ],
        "canEdit": bool(can_edit),
        "updatedAt": _iso(m.updated_at),
    }


def _menus_out(db: Session, user: User, menus: List[CatalogMenu]) -> List[Dict[str, Any]]:
    ids = [m.id for m in menus]
    cats, prods = _items(db, ids)
    assignments: Dict[str, List[CatalogMenuAssignment]] = {}
    if ids:
        for a in db.query(CatalogMenuAssignment).filter(CatalogMenuAssignment.menu_id.in_(ids)).all():
            assignments.setdefault(str(a.menu_id), []).append(a)
    names = _target_names(db, [(a.level, a.target_id) for rows in assignments.values() for a in rows])
    companies = _company_names(db, [m.company_id for m in menus if m.company_id])
    return [
        menu_out(
            db, user, m, cats.get(str(m.id), []), prods.get(str(m.id), []),
            assignments.get(str(m.id), []), names, companies,
        )
        for m in menus
    ]


def list_menus(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    visible = _visible_companies(db, user)
    menus = [
        m for m in db.query(CatalogMenu)
        .filter(CatalogMenu.tenant_id == tenant_id)
        .order_by(CatalogMenu.sort_order, CatalogMenu.name)
        .all()
        if _menu_visible(m, visible)
    ]
    return {
        "menus": _menus_out(db, user, menus),
        "canCreate": user.role in TENANT_WIDE_ROLES or may_write(db, user, tenant_id, getattr(user, "company_id", None)),
        "timezone": str(tenant_zone(db, tenant_id)),
    }


def one_menu_out(db: Session, user: User, m: CatalogMenu) -> Dict[str, Any]:
    return _menus_out(db, user, [m])[0]


def _apply(db: Session, tenant_id, m: CatalogMenu, body: MenuIn) -> None:
    category_ids = [c.category_id for c in body.categories]
    if category_ids:
        found = {
            r[0] for r in db.query(Category.id).filter(Category.id.in_(category_ids), Category.tenant_id == tenant_id).all()
        }
        if len(found) != len(set(category_ids)):
            raise _bad(UNKNOWN_CATEGORY)
    product_ids = [p.product_id for p in body.products]
    if product_ids:
        found = set()
        for chunk_start in range(0, len(product_ids), 500):
            chunk = product_ids[chunk_start:chunk_start + 500]
            found |= {
                r[0] for r in db.query(Product.id).filter(
                    Product.id.in_(chunk), Product.tenant_id == tenant_id, Product.pos_machine_id.is_(None),
                ).all()
            }
        if len(found) != len(set(product_ids)):
            raise _bad(UNKNOWN_PRODUCT)

    m.name = body.name
    m.company_id = body.company_id
    m.channel = body.channel
    m.is_active = body.is_active
    m.always = body.always
    m.weekdays = body.days
    m.time_ranges = [{"start": r.start, "end": r.end} for r in body.ranges] or None
    m.valid_from = body.valid_from
    m.valid_to = body.valid_to
    m.color = body.color
    m.updated_at = _now()
    db.flush()
    db.query(CatalogMenuCategory).filter(CatalogMenuCategory.menu_id == m.id).delete(synchronize_session=False)
    db.query(CatalogMenuProduct).filter(CatalogMenuProduct.menu_id == m.id).delete(synchronize_session=False)
    for i, c in enumerate(body.categories):
        db.add(CatalogMenuCategory(
            id=uuid.uuid4(), menu_id=m.id, category_id=c.category_id, sort_order=i, all_products=c.all_products,
        ))
    for i, p in enumerate(body.products):
        db.add(CatalogMenuProduct(id=uuid.uuid4(), menu_id=m.id, product_id=p.product_id, sort_order=i, price=p.price))
    db.flush()


def create_menu(db: Session, user: User, tenant_id, body: MenuIn) -> CatalogMenu:
    check_menu_write(db, user, tenant_id, body.company_id)
    last = (
        db.query(func.max(CatalogMenu.sort_order)).filter(CatalogMenu.tenant_id == tenant_id).scalar()
    )
    m = CatalogMenu(
        id=uuid.uuid4(), tenant_id=tenant_id, name=body.name, company_id=body.company_id,
        sort_order=(last or 0) + 1, created_by=getattr(user, "id", None),
    )
    db.add(m)
    db.flush()
    _apply(db, tenant_id, m, body)
    bump(db, tenant_id)
    return m


def update_menu(db: Session, user: User, tenant_id, m: CatalogMenu, body: MenuIn) -> CatalogMenu:
    # Both: whoever moves a menu to another company must cover the one it leaves too.
    check_menu_write(db, user, tenant_id, m.company_id)
    if body.company_id != m.company_id:
        check_menu_write(db, user, tenant_id, body.company_id)
    _apply(db, tenant_id, m, body)
    bump(db, tenant_id)
    return m


def delete_menu(db: Session, user: User, tenant_id, m: CatalogMenu) -> None:
    check_menu_write(db, user, tenant_id, m.company_id)
    for model in (CatalogMenuCategory, CatalogMenuProduct, CatalogMenuAssignment):
        db.query(model).filter(model.menu_id == m.id).delete(synchronize_session=False)
    db.delete(m)
    db.flush()
    bump(db, tenant_id)


def reorder_menus(db: Session, user: User, tenant_id, ids: List[uuid.UUID]) -> None:
    visible = _visible_companies(db, user)
    rows = {str(m.id): m for m in db.query(CatalogMenu).filter(CatalogMenu.tenant_id == tenant_id).all()}
    for i, ident in enumerate(ids):
        m = rows.get(str(ident))
        if m is None or not _menu_visible(m, visible):
            continue
        if not may_write(db, user, tenant_id, m.company_id):
            continue
        m.sort_order = i
    db.flush()


# ── Dashboard: assignments ────────────────────────────────────────────────────


def _target_companies(db: Session, level: str, entity) -> Set[str]:
    """The target's company and every company above it (what a menu must be placed on)."""
    if level == "company":
        company_id = entity.id
    elif level == "shop":
        company_id = entity.company_id
    elif level == "area":
        shop = db.query(Shop).filter(Shop.id == entity.shop_id).first()
        company_id = shop.company_id if shop else None
    else:
        shop = db.query(Shop).filter(Shop.id == entity.shop_id).first() if entity.shop_id else None
        company_id = shop.company_id if shop else None
    return {str(c) for c in company_chain(db, company_id)}


def set_target(db: Session, user: User, tenant_id, body: TargetAssignmentsIn) -> None:
    """Replace the menus assigned at one company / shop / point of sale / till, and its fallback."""
    from app.services.menu import _require_writer
    from app.services.till_messages import resolve_target

    _require_writer(user)
    entity = resolve_target(db, user, tenant_id, body.level, body.target_id)
    reach = _target_companies(db, body.level, entity)
    visible = _visible_companies(db, user)
    wanted = [m.menu_id for m in body.menus]
    menus = {
        str(m.id): m for m in (
            db.query(CatalogMenu).filter(CatalogMenu.id.in_(wanted), CatalogMenu.tenant_id == tenant_id).all()
            if wanted else []
        )
    }
    for item in body.menus:
        m = menus.get(str(item.menu_id))
        if m is None or not _menu_visible(m, visible):
            raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
        if m.company_id is not None and str(m.company_id) not in reach:
            raise _bad(OUT_OF_REACH)

    now = _now()
    existing = {
        str(a.menu_id): a for a in db.query(CatalogMenuAssignment).filter(
            CatalogMenuAssignment.tenant_id == tenant_id,
            CatalogMenuAssignment.level == body.level,
            CatalogMenuAssignment.target_id == body.target_id,
        ).all()
    }
    keep = set()
    for item in body.menus:
        key = str(item.menu_id)
        keep.add(key)
        row = existing.get(key)
        if row is None:
            db.add(CatalogMenuAssignment(
                id=uuid.uuid4(), tenant_id=tenant_id, menu_id=item.menu_id, level=body.level,
                target_id=body.target_id, priority=item.priority, created_by=getattr(user, "id", None),
                created_at=now, updated_at=now,
            ))
        elif (row.priority or 0) != item.priority:
            row.priority = item.priority
            row.updated_at = now
    for key, row in existing.items():
        if key not in keep:
            db.delete(row)

    fallback = (
        db.query(CatalogMenuFallback)
        .filter(CatalogMenuFallback.level == body.level, CatalogMenuFallback.target_id == body.target_id)
        .first()
    )
    if body.fallback is None:
        if fallback is not None:
            db.delete(fallback)
    elif fallback is None:
        db.add(CatalogMenuFallback(
            id=uuid.uuid4(), tenant_id=tenant_id, level=body.level, target_id=body.target_id,
            mode=body.fallback, updated_by=getattr(user, "id", None), updated_at=now,
        ))
    elif fallback.mode != body.fallback:
        fallback.mode = body.fallback
        fallback.updated_by = getattr(user, "id", None)
        fallback.updated_at = now
    db.flush()
    bump(db, tenant_id)


def _kiosk_ids(db: Session, machine_ids: Sequence) -> Set[str]:
    from app.models.kiosk import KioskDevice

    if not machine_ids:
        return set()
    return {
        str(r[0]) for r in db.query(KioskDevice.machine_id).filter(
            KioskDevice.machine_id.in_(list(machine_ids)), KioskDevice.enabled.is_(True),
        ).all()
    }


def targets_overview(
    db: Session, user: User, tenant_id, *, company_id=None, shop_id=None,
) -> Dict[str, Any]:
    """
    The tree the assignments page edits: the companies, shops, points of sale and tills
    the user sees, each with its menus, priorities and fallback, and whether they may
    change it.
    """
    from app.services import menu_broadcast as B
    from app.services.company_hierarchy import catalog_company_ids

    shops = B.shops_in_scope(db, user, tenant_id, company_id=company_id, shop_id=shop_id)
    visible = catalog_company_ids(db, user)
    company_q = db.query(Company).filter(Company.tenant_id == tenant_id)
    if visible is not None:
        company_q = company_q.filter(Company.id.in_(list(visible) or [uuid.uuid4()]))
    companies = company_q.order_by(Company.name).all()
    if company_id is not None or shop_id is not None:
        # Narrowed: the companies these shops sit under (theirs and those above), and the
        # company asked for with its subsidiaries.
        from app.services.company_hierarchy import descendant_company_ids

        wanted = {str(c) for s in shops for c in company_chain(db, s.company_id)}
        if company_id is not None:
            wanted |= {str(c) for c in descendant_company_ids(db, company_id)}
        companies = [c for c in companies if str(c.id) in wanted]
    shop_ids = [s.id for s in shops]
    areas = (
        db.query(ShopArea)
        .filter(ShopArea.shop_id.in_(shop_ids), ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
        if shop_ids else []
    )
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id.in_(shop_ids), POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
        if shop_ids else []
    )
    kiosks = _kiosk_ids(db, [m.id for m in machines])
    company_edit = user.role in TENANT_WIDE_ROLES or user.role == UserRole.COMPANY_MANAGER
    from app.services.company_hierarchy import user_covers_company
    from app.services.menu import WRITE_ROLES

    writer = user.role in WRITE_ROLES

    def company_editable(c: Company) -> bool:
        if not writer or not company_edit:
            return False
        return user.role in TENANT_WIDE_ROLES or user_covers_company(db, user, c.id)

    targets: List[Dict[str, Any]] = []
    for c in companies:
        targets.append({
            "level": "company", "id": str(c.id), "name": c.name,
            "parentId": str(c.parent_company_id) if getattr(c, "parent_company_id", None) else None,
            "canEdit": company_editable(c),
        })
    for s in shops:
        targets.append({
            "level": "shop", "id": str(s.id), "name": s.name,
            "parentId": str(s.company_id) if s.company_id else None, "canEdit": writer,
        })
    for a in areas:
        targets.append({
            "level": "area", "id": str(a.id), "name": a.name, "parentId": str(a.shop_id), "canEdit": writer,
        })
    for m in machines:
        targets.append({
            "level": "machine", "id": str(m.id), "name": m.name, "posNumber": m.pos_number,
            "parentId": str(m.area_id) if m.area_id else str(m.shop_id),
            "shopId": str(m.shop_id), "isKiosk": str(m.id) in kiosks, "canEdit": writer,
        })
    ids = [uuid.UUID(t["id"]) for t in targets]
    assignments = (
        db.query(CatalogMenuAssignment)
        .filter(CatalogMenuAssignment.tenant_id == tenant_id, CatalogMenuAssignment.target_id.in_(ids))
        .all()
        if ids else []
    )
    fallbacks = (
        db.query(CatalogMenuFallback)
        .filter(CatalogMenuFallback.tenant_id == tenant_id, CatalogMenuFallback.target_id.in_(ids))
        .all()
        if ids else []
    )
    return {
        "targets": targets,
        "assignments": [
            {"level": a.level, "targetId": str(a.target_id), "menuId": str(a.menu_id), "priority": a.priority or 0}
            for a in assignments
        ],
        "fallbacks": [{"level": f.level, "targetId": str(f.target_id), "mode": f.mode} for f in fallbacks],
    }


# ── Dashboard: what is active, and the simulator ─────────────────────────────


def _resolution_out(r: Dict[str, Any], nxt: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(r)
    out["next"] = None if nxt is None else {
        "at": nxt["at"].isoformat(timespec="minutes"),
        "mode": nxt["mode"],
        "menuId": nxt["menuId"],
        "menuName": nxt["menuName"],
    }
    return out


def now_overview(
    db: Session, user: User, tenant_id, *, company_id=None, shop_id=None, at: Optional[str] = None,
) -> Dict[str, Any]:
    """
    "פעיל עכשיו": for every shop, point of sale and till in scope, the menu active on its
    tills (`pos`) and kiosks (`kiosk`) at `at` (local; default now) — from what the tills
    are actually served (a shop in review mode: its publication) — and when that changes.
    """
    from app.services import menu_broadcast as B

    local = local_moment(db, tenant_id, at)
    shops = B.shops_in_scope(db, user, tenant_id, company_id=company_id, shop_id=shop_id)
    tenant_data = _data(db, tenant_id, None)
    shop_ids = [s.id for s in shops]
    areas = (
        db.query(ShopArea)
        .filter(ShopArea.shop_id.in_(shop_ids), ShopArea.archived_at.is_(None))
        .order_by(ShopArea.sort_order, ShopArea.name)
        .all()
        if shop_ids else []
    )
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id.in_(shop_ids), POSMachine.is_active.is_(True))
        .order_by(POSMachine.pos_number, POSMachine.name)
        .all()
        if shop_ids else []
    )
    kiosks = _kiosk_ids(db, [m.id for m in machines])
    rows: List[Dict[str, Any]] = []

    def both(data, chain) -> Dict[str, Any]:
        block = block_of(data, chain)
        out = {}
        for surface in R.SURFACES:
            out[surface] = _resolution_out(R.resolve(block, local, surface), R.next_change(block, local, surface))
        return out

    for s in shops:
        published, source = _review_data(db, s)
        data = published if published is not None else tenant_data
        # The shop's chain once (its companies are one query); a till's is its own on top.
        base = chain_for(db, s)
        rows.append({
            "level": "shop", "id": str(s.id), "name": s.name, "parentId": None, "source": source,
            **both(data, base),
        })
        for a in [a for a in areas if a.shop_id == s.id]:
            rows.append({
                "level": "area", "id": str(a.id), "name": a.name, "parentId": str(s.id), "source": source,
                **both(data, [Target("area", a.id), *base]),
            })
        for m in [m for m in machines if m.shop_id == s.id]:
            own = [Target("machine", m.id)] + ([Target("area", m.area_id)] if m.area_id else [])
            rows.append({
                "level": "machine", "id": str(m.id), "name": m.name, "posNumber": m.pos_number,
                "parentId": str(m.area_id) if m.area_id else str(s.id), "isKiosk": str(m.id) in kiosks,
                "source": source,
                **both(data, own + base),
            })
    return {"at": local.isoformat(timespec="minutes"), "timezone": str(tenant_zone(db, tenant_id)), "rows": rows}


def _catalog_rows(db: Session, level: str, entity) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """`(products as the target's tills hold them, {category id: {name, isActive}})`."""
    from app.services import sync as S

    if level == "machine":
        tid = str(entity.tenant_id) if entity.tenant_id else None
        products = S.get_products_for_sync(db, tid, str(entity.id))
        categories = S.get_categories_for_sync(db, tid, str(entity.id))
        return products, {c["id"]: c for c in categories}
    shop = entity if level == "shop" else db.query(Shop).filter(Shop.id == entity.shop_id).first()
    if shop is None:
        return [], {}
    from app.services.menu_broadcast import build_snapshot

    snap = build_snapshot(db, shop)
    cats = {**(snap.get("referencedCategories") or {}), **(snap.get("categories") or {})}
    products = sorted((snap.get("products") or {}).values(), key=lambda p: (p.get("name") or "", p.get("id")))
    return products, cats


def simulate(
    db: Session, user: User, tenant_id, *, level: str, target_id, at: Optional[str] = None,
    surface: Optional[str] = None, preview: bool = True,
) -> Dict[str, Any]:
    """
    "מה יהיה פעיל ביום ג׳ ב-18:00": the menu a company / shop / point of sale / till gets at
    the local moment `at`, why, when that changes next, and — with a menu — what it sells
    there: in order, at what price and from where, blocked items marked.
    """
    from app.services.till_messages import resolve_target

    if level not in ASSIGNMENT_LEVELS:
        raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
    entity = resolve_target(db, user, tenant_id, level, target_id)
    local = local_moment(db, tenant_id, at)
    if level == "machine":
        shop = db.query(Shop).filter(Shop.id == entity.shop_id).first() if entity.shop_id else None
        chain = chain_for(db, shop, area_id=entity.area_id, machine_id=entity.id) if shop else [Target("machine", entity.id)]
        if surface is None:
            surface = R.SURFACE_KIOSK if str(entity.id) in _kiosk_ids(db, [entity.id]) else R.SURFACE_POS
    elif level == "area":
        shop = db.query(Shop).filter(Shop.id == entity.shop_id).first()
        chain = chain_for(db, shop, area_id=entity.id)
    elif level == "shop":
        shop = entity
        chain = chain_for(db, shop)
    else:
        shop = None
        chain = chain_for(db, None, company_id=entity.id)
    surface = surface if surface in R.SURFACES else R.SURFACE_POS

    data, source = (None, "live")
    if shop is not None:
        data, source = _review_data(db, shop)
    if data is None:
        data = _data(db, tenant_id, chain)
    local_ids = _local_ids(db, entity.id, data) if level == "machine" else {}
    block = block_of(data, chain, local_ids=local_ids)
    resolution = R.resolve(block, local, surface)
    out: Dict[str, Any] = {
        "at": local.isoformat(timespec="minutes"),
        "weekday": R.weekday(local.date()),
        "surface": surface,
        "source": source,
        "level": level,
        "targetId": str(entity.id),
        "resolution": _resolution_out(resolution, R.next_change(block, local, surface)),
        "candidates": [],
        "preview": None,
    }
    # Every menu along the chain and whether it is on at that moment — the "why".
    menus = {m["id"]: m for m in block["menus"]}
    for a in block["assignments"]:
        m = menus.get(a["menuId"])
        if m is None:
            continue
        out["candidates"].append({
            "menuId": m["id"], "menuName": m.get("name"), "level": a["level"], "depth": a["depth"],
            "priority": a["priority"], "channel": m.get("channel"),
            "onChannel": R.channel_accepts(m.get("channel"), surface),
            "activeNow": R.schedule_active(m.get("schedule"), local),
            "chosen": m["id"] == resolution.get("menuId"),
        })
    if not preview or resolution["mode"] != R.MODE_MENU or shop is None:
        return out
    products, categories = _catalog_rows(db, level, entity)
    off_channel = "kiosk_only" if surface == R.SURFACE_POS else "pos_only"
    rows = [p for p in products if p.get("salesChannel") != off_channel and not p.get("isGeneral")]
    applied = R.apply(R.menu_by_id(block, resolution["menuId"]), rows)
    by_id = {p.get("id"): p for p in rows}
    shown = []
    for cid in applied["categories"]:
        c = categories.get(cid) or {}
        items = []
        for p in applied["products"]:
            if p["categoryId"] != cid:
                continue
            row = by_id.get(p["id"]) or {}
            items.append({
                "id": p["id"],
                "name": row.get("name"),
                "price": float(p["price"]),
                "catalogPrice": _money(row.get("price")),
                "priceSource": p["priceSource"],
                "blocked": not (row.get("isAvailable", True) and row.get("inStock", True) and c.get("isActive", True)),
            })
        shown.append({"id": cid, "name": c.get("name"), "isActive": c.get("isActive", True), "products": items})
    out["preview"] = {"categories": shown, "products": len(applied["products"])}
    return out


# ── The review ("שידור תפריט") ────────────────────────────────────────────────


def _item(kind: str, ident: Any, name: Any, changes=None, detail: str = "catalog_menu") -> Dict[str, Any]:
    return {"type": kind, "id": str(ident), "name": name, "detail": detail, "changes": changes or []}


def _change(field_name: str, before: Any, after: Any, label: Optional[str] = None) -> Dict[str, Any]:
    out = {"field": field_name, "before": before, "after": after}
    if label:
        out["label"] = label
    return out


def _schedule_text(s: Optional[Dict[str, Any]]) -> Optional[str]:
    if s is None:
        return None
    names = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"]
    parts = []
    if s.get("always"):
        parts.append("תמיד")
    else:
        d = s.get("days")
        parts.append("כל יום" if d is None else " ".join(names[i] for i in d if 0 <= i <= 6))
        ranges = s.get("ranges") or []
        parts.append(", ".join(f"{a}–{b}" for a, b in ranges) if ranges else "כל היום")
    if s.get("from") or s.get("to"):
        parts.append(f"{s.get('from') or '…'} – {s.get('to') or '…'}")
    return " · ".join(parts)


def diff(old: Optional[Dict[str, Any]], new: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    What a broadcast changes in the shop's menus: menus added / removed / changed (name,
    channel, schedule, categories, products, prices), and the assignments and fallbacks
    of each level. For the review's "menu" section (detail `catalog_menu`, and
    `catalog_menu_assignment` / `catalog_menu_fallback`).
    """
    old = old or _empty_data()
    new = new or _empty_data()
    target_names: Dict[Tuple[str, str], str] = {}
    for side in (old, new):
        for r in list(side.get("assignments") or []) + list(side.get("fallbacks") or []):
            if r.get("targetName"):
                target_names[(r.get("level"), r.get("targetId"))] = r["targetName"]
    out: List[Dict[str, Any]] = []
    om, nm = old.get("menus") or {}, new.get("menus") or {}

    def label(menus, mid):
        return (menus.get(mid) or {}).get("name") or mid

    for mid in sorted(set(om) | set(nm), key=lambda k: ((nm.get(k) or om.get(k) or {}).get("name") or "", k)):
        a, b = om.get(mid), nm.get(mid)
        if b is not None and a is None:
            out.append(_item("added", mid, b.get("name"), [_change("schedule", None, _schedule_text(b.get("schedule")))]))
            continue
        if a is not None and b is None:
            out.append(_item("removed", mid, a.get("name")))
            continue
        changes = []
        for f in ("name", "channel"):
            if a.get(f) != b.get(f):
                changes.append(_change(f, a.get(f), b.get(f)))
        if a.get("schedule") != b.get("schedule"):
            changes.append(_change("schedule", _schedule_text(a.get("schedule")), _schedule_text(b.get("schedule"))))
        ac = [(c["id"], c.get("all", True)) for c in a.get("categories") or []]
        bc = [(c["id"], c.get("all", True)) for c in b.get("categories") or []]
        if ac != bc:
            changes.append(_change(
                "categories",
                [c.get("name") for c in a.get("categories") or []],
                [c.get("name") for c in b.get("categories") or []],
            ))
        ap = {p["id"]: p for p in a.get("products") or []}
        bp = {p["id"]: p for p in b.get("products") or []}
        if [p["id"] for p in a.get("products") or []] != [p["id"] for p in b.get("products") or []]:
            added = [bp[k].get("name") for k in bp if k not in ap]
            removed = [ap[k].get("name") for k in ap if k not in bp]
            changes.append(_change("products", removed or None, added or None))
        for k in bp:
            if k in ap and ap[k].get("price") != bp[k].get("price"):
                changes.append(_change("price", ap[k].get("price"), bp[k].get("price"), label=bp[k].get("name")))
        if changes:
            out.append(_item("changed", mid, b.get("name"), changes))

    def grouped(rows):
        by: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for r in rows or []:
            by.setdefault((r.get("level"), r.get("targetId")), []).append(r)
        return by

    oa, na = grouped(old.get("assignments")), grouped(new.get("assignments"))
    for key in sorted(set(oa) | set(na)):
        before = sorted((label(om, r["menuId"]), r.get("priority") or 0) for r in oa.get(key, []))
        after = sorted((label(nm, r["menuId"]), r.get("priority") or 0) for r in na.get(key, []))
        if before != after:
            out.append(_item(
                "changed", f"{key[0]}:{key[1]}", target_names.get(key) or key[0],
                [_change(
                    "menus",
                    [f"{n} ({p})" if p else n for n, p in before] or None,
                    [f"{n} ({p})" if p else n for n, p in after] or None,
                    label=key[0],
                )],
                detail="catalog_menu_assignment",
            ))
    of = {(f.get("level"), f.get("targetId")): f.get("mode") for f in old.get("fallbacks") or []}
    nf = {(f.get("level"), f.get("targetId")): f.get("mode") for f in new.get("fallbacks") or []}
    for key in sorted(set(of) | set(nf)):
        if of.get(key) != nf.get(key):
            out.append(_item(
                "changed", f"{key[0]}:{key[1]}", target_names.get(key) or key[0],
                [_change("fallback", of.get(key), nf.get(key), label=key[0])],
                detail="catalog_menu_fallback",
            ))
    return out


# ── The report: sales by menu ─────────────────────────────────────────────────


def menu_sales_report(
    db: Session, user: User, tenant_id, window, *, shop_id=None, machine_id=None,
) -> Dict[str, Any]:
    """
    דוח מכירות לפי תפריט: per menu that was active when lines were added (and "no menu"),
    units and money sold and refunded, and how much of it was at the menu's own price.
    """
    from app.services.menu import _empty, _scoped_tx

    out = _empty(window)
    out.update({
        "totals": {
            "units": 0.0, "unitsRefunded": 0.0, "gross": 0.0, "discounts": 0.0, "refunds": 0.0, "net": 0.0,
            "menuPricedUnits": 0.0, "menuPricedGross": 0.0,
        },
        "rows": [],
    })
    tx = _scoped_tx(db, user, tenant_id, window, shop_id, machine_id)
    if tx is None:
        return out
    T = TransactionItem
    is_refund = tx.c.is_refund
    discount = func.coalesce(T.discount, 0) + func.coalesce(T.promotion_discount, 0) + func.coalesce(T.voucher_discount, 0)
    rows = (
        db.query(
            T.menu_id, T.menu_name, T.price_source,
            func.coalesce(func.sum(case((is_refund.is_(False), T.quantity), else_=0)), 0),
            func.coalesce(func.sum(case((is_refund.is_(True), T.quantity), else_=0)), 0),
            func.coalesce(func.sum(case((is_refund.is_(False), T.total_price), else_=0)), 0),
            func.coalesce(func.sum(case((is_refund.is_(False), discount), else_=0)), 0),
            func.coalesce(func.sum(case((is_refund.is_(True), T.total_price), else_=0)), 0),
            func.count(T.id),
        )
        .join(tx, tx.c.tx_id == T.transaction_id)
        .group_by(T.menu_id, T.menu_name, T.price_source)
        .all()
    )
    merged: Dict[str, Dict[str, Any]] = {}
    for menu_id, menu_name, source, sold, refunded, gross, discounts, refunds, lines in rows:
        key = str(menu_id) if menu_id else ""
        row = merged.setdefault(key, {
            "menuId": str(menu_id) if menu_id else None, "menuName": menu_name,
            "unitsSold": 0.0, "unitsRefunded": 0.0, "gross": 0.0, "discounts": 0.0, "refunds": 0.0,
            "menuPricedUnits": 0.0, "menuPricedGross": 0.0, "lines": 0,
        })
        if menu_name and not row["menuName"]:
            row["menuName"] = menu_name
        row["unitsSold"] += float(sold or 0)
        row["unitsRefunded"] += float(refunded or 0)
        row["gross"] += float(gross or 0)
        row["discounts"] += float(discounts or 0)
        row["refunds"] += float(refunds or 0)
        row["lines"] += int(lines or 0)
        if source == R.PRICE_MENU:
            row["menuPricedUnits"] += float(sold or 0)
            row["menuPricedGross"] += float(gross or 0)
    live = {}
    ids = [_as_uuid(k) for k in merged if k]
    if ids:
        live = {str(m.id): m.name for m in db.query(CatalogMenu).filter(CatalogMenu.id.in_(ids)).all()}
    totals = out["totals"]
    result = []
    for key, row in merged.items():
        if key in live:
            row["menuName"] = live[key]
        for f in ("gross", "discounts", "refunds", "menuPricedGross"):
            row[f] = round(row[f], 2)
        row["net"] = round(row["gross"] - row["discounts"] - row["refunds"], 2)
        row["unitsNet"] = row["unitsSold"] - row["unitsRefunded"]
        totals["units"] += row["unitsSold"]
        totals["unitsRefunded"] += row["unitsRefunded"]
        totals["gross"] += row["gross"]
        totals["discounts"] += row["discounts"]
        totals["refunds"] += row["refunds"]
        totals["net"] += row["net"]
        totals["menuPricedUnits"] += row["menuPricedUnits"]
        totals["menuPricedGross"] += row["menuPricedGross"]
        result.append(row)
    for f in ("gross", "discounts", "refunds", "net", "menuPricedGross"):
        totals[f] = round(totals[f], 2)
    result.sort(key=lambda r: (r["menuId"] is None, -r["gross"], r["menuName"] or ""))
    out["rows"] = result
    return out
