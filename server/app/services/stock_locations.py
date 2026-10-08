"""
Stock locations along the hierarchy, and "אופן ניהול מלאי" — which of them hold stock.

**Locations** (`stock_levels.level` + `target_id`), top down:

    company (central warehouse) → shop → area (point of sale) → group (device group) → machine (till / kiosk)

**The setting** (`stock_level_settings`): for a company, overridden per shop, and per category or
product, the managed levels — any combination ("shop" only, the default and what every shop had;
"shop" + "area"; "company" + "shop" + "machine"; "machine" only…). The rule for a product in a shop
is the most specific one: shop + product → company + product → shop + category → company +
category → shop → company → shop only.

**Sales** take from the lowest managed location that contains the selling device (`sell_from`);
a device under no managed location (an "area only" product sold by a till in no area) sells from
its shop. **Receiving** goes into any managed location, by default the highest. **Transfers** go
between any two managed locations. **Totals** at a node are its own location plus every managed
location below it. **Updating from a node that holds no stock** (a till under "shop" only) goes to
the nearest managed location above it (`update_location`), and the screen says which.

**Device groups** are wired through `group_hook`, the one place that reads `machine_groups` — absent
from this base, so no device is in a group and no group can be chosen yet.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

LEVELS: Tuple[str, ...] = ("company", "shop", "area", "group", "machine")
DEFAULT_LEVELS: Tuple[str, ...] = ("shop",)
LEVEL_LABELS = {"company": "חברה", "shop": "סניף", "area": "נקודת מכירה", "group": "קבוצת מכשירים", "machine": "קופה"}


class NotManaged(Exception):
    """No managed location at or above the node chosen: pick a lower one."""

    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code = code
        self.message = message


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class Location:
    level: str
    target_id: uuid.UUID

    @property
    def key(self) -> str:
        return f"{self.level}:{self.target_id}"

    def out(self) -> Dict[str, Any]:
        return {"level": self.level, "targetId": str(self.target_id)}


@dataclass(frozen=True)
class Path:
    """Where a device (or any node) stands: the ids above it, whichever exist."""

    company_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None
    area_id: Optional[uuid.UUID] = None
    machine_id: Optional[uuid.UUID] = None
    group_ids: Tuple[uuid.UUID, ...] = field(default_factory=tuple)
    #: The level of the node itself (a shop's path has no area or machine).
    node_level: str = "machine"

    def chain_up(self) -> List[Location]:
        """Its own location and every one above it, nearest first."""
        out: List[Location] = []
        if self.machine_id is not None:
            out.append(Location("machine", self.machine_id))
        out += [Location("group", g) for g in self.group_ids]
        if self.area_id is not None:
            out.append(Location("area", self.area_id))
        if self.shop_id is not None:
            out.append(Location("shop", self.shop_id))
        if self.company_id is not None:
            out.append(Location("company", self.company_id))
        return out

    def contains(self, loc: Location) -> bool:
        """Whether `loc` is this node or above it."""
        return loc in self.chain_up()

    @property
    def node(self) -> Location:
        return self.chain_up()[0]


# ── The setting ──────────────────────────────────────────────────────────────


def normalize_levels(raw: Any) -> Tuple[str, ...]:
    """Known levels, deduped, top down. Raises ValueError on an empty or unknown set."""
    if not isinstance(raw, (list, tuple)):
        raise ValueError("levels_must_be_a_list")
    picked = set()
    for item in raw:
        if item not in LEVELS:
            raise ValueError(f"unknown_level:{item}")
        picked.add(item)
    if not picked:
        raise ValueError("levels_empty")
    return tuple(level for level in LEVELS if level in picked)


@dataclass(frozen=True)
class Rule:
    scope_level: str
    scope_id: Any
    item_kind: Optional[str]
    item_id: Any
    levels: Tuple[str, ...]


def rule_key(scope_level: str, scope_id: Any, item_kind: Optional[str], item_id: Any) -> str:
    return f"{scope_level}:{scope_id}:{item_kind or '-'}:{item_id or '-'}"


def resolve_managed(
    rules: Iterable[Rule], *, company_id: Any, shop_id: Any, product_id: Any, category_id: Any,
) -> Tuple[str, ...]:
    """The managed levels for one product in one shop (see the module docstring for the order)."""
    by_key = {rule_key(r.scope_level, r.scope_id, r.item_kind, r.item_id): r for r in rules}
    for scope_level, scope_id, kind, item in (
        ("shop", shop_id, "product", product_id),
        ("company", company_id, "product", product_id),
        ("shop", shop_id, "category", category_id),
        ("company", company_id, "category", category_id),
        ("shop", shop_id, None, None),
        ("company", company_id, None, None),
    ):
        if scope_id is None or (kind is not None and item is None):
            continue
        hit = by_key.get(rule_key(scope_level, scope_id, kind, item))
        if hit is not None and hit.levels:
            return hit.levels
    return DEFAULT_LEVELS


def sell_from(path: Path, managed: Sequence[str]) -> Location:
    """The location a device's sale takes from: the lowest managed one containing it."""
    for loc in path.chain_up():
        if loc.level in managed:
            return loc
    if path.shop_id is not None:
        return Location("shop", path.shop_id)
    return Location("company", path.company_id)


def update_location(path: Path, managed: Sequence[str]) -> Location:
    """
    Where an update chosen at the node `path` goes: the node itself when its level holds stock,
    else the nearest managed location above it. NotManaged when there is none (the node is above
    every managed level — pick a lower one).
    """
    for loc in path.chain_up():
        if loc.level in managed:
            return loc
    raise NotManaged("not_managed_here", "ברמה הזו אין מלאי — בחרו רמה נמוכה יותר")


def receive_location(path: Path, managed: Sequence[str]) -> Location:
    """
    Goods received at the node `path`: the node when it holds stock, else the highest managed
    location at or under it is ambiguous — so the nearest above (as `update_location`).
    """
    return update_location(path, managed)


def highest_managed(path: Path, managed: Sequence[str]) -> Optional[Location]:
    """The highest managed location on the node's path (receiving's default)."""
    for loc in reversed(path.chain_up()):
        if loc.level in managed:
            return loc
    return None


def parents_managed(path: Path, managed: Sequence[str]) -> List[Location]:
    """The managed locations strictly above the node, nearest first (where a top-up comes from)."""
    return [loc for loc in path.chain_up()[1:] if loc.level in managed]


# ── The database ─────────────────────────────────────────────────────────────


def group_hook(db: Session, *, machine_id: Any = None, group_id: Any = None) -> Any:
    """
    Device groups ("קבוצת מכשירים"), the one place that reads them. With `machine_id`: the ids of
    the groups the device is in. With `group_id`: `{"name", "shopId", "machineIds"}` or None. The
    `machine_groups` model is not in this base: no device is in a group, and no group exists.
    Wire it here at merge (and nowhere else): stock locations, blocks and their tills follow.
    """
    try:
        from app.models.machine_group import MachineGroup, MachineGroupMember  # type: ignore  # noqa: F401
    except Exception:  # noqa: BLE001 - not in this base
        return [] if machine_id is not None else None
    if machine_id is not None:  # pragma: no cover - wired at merge
        rows = db.query(MachineGroupMember.group_id).filter(MachineGroupMember.machine_id == machine_id).all()
        return [r[0] for r in rows]
    group = db.get(MachineGroup, _uuid(group_id))  # pragma: no cover - wired at merge
    if group is None:  # pragma: no cover
        return None
    members = db.query(MachineGroupMember.machine_id).filter(MachineGroupMember.group_id == group.id).all()  # pragma: no cover
    return {"name": group.name, "shopId": getattr(group, "shop_id", None), "machineIds": [m[0] for m in members]}  # pragma: no cover


def path_of_machine(db: Session, machine: Any) -> Path:
    from app.models.shop import Shop

    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    return Path(
        company_id=shop.company_id if shop is not None else None,
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        machine_id=machine.id,
        group_ids=tuple(group_hook(db, machine_id=machine.id) or ()),
        node_level="machine",
    )


def path_of(db: Session, level: str, target_id: Any) -> Path:
    """The path of any node (company, shop, area, group, machine). Raises LookupError when it is gone."""
    from app.models.company import Company
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea

    ident = _uuid(target_id)
    if ident is None:
        raise LookupError("target_id")
    if level == "company":
        if db.get(Company, ident) is None:
            raise LookupError("company")
        return Path(company_id=ident, node_level="company")
    if level == "shop":
        shop = db.get(Shop, ident)
        if shop is None:
            raise LookupError("shop")
        return Path(company_id=shop.company_id, shop_id=shop.id, node_level="shop")
    if level == "area":
        area = db.get(ShopArea, ident)
        shop = db.get(Shop, area.shop_id) if area is not None else None
        if area is None or shop is None:
            raise LookupError("area")
        return Path(company_id=shop.company_id, shop_id=shop.id, area_id=area.id, node_level="area")
    if level == "machine":
        machine = db.get(POSMachine, ident)
        if machine is None:
            raise LookupError("machine")
        return path_of_machine(db, machine)
    if level == "group":
        group = group_hook(db, group_id=ident)
        if not group:
            raise LookupError("group")
        shop = db.get(Shop, _uuid(group.get("shopId"))) if group.get("shopId") else None  # pragma: no cover
        return Path(  # pragma: no cover - wired at merge
            company_id=shop.company_id if shop is not None else None,
            shop_id=shop.id if shop is not None else None,
            group_ids=(ident,), node_level="group",
        )
    raise LookupError("level")


def location_path(db: Session, loc: Location) -> Path:
    return path_of(db, loc.level, loc.target_id)


class RuleBook:
    """The managed-level rules of one tenant's company and shops, read once."""

    def __init__(self, db: Session, *, company_ids: Iterable[Any] = (), shop_ids: Iterable[Any] = ()):
        from app.models.stock_setting import StockLevelSetting
        from sqlalchemy import and_, or_

        clauses = []
        companies = [c for c in company_ids if c is not None]
        shops = [s for s in shop_ids if s is not None]
        if not _rules_ready(db):
            companies, shops = [], []
        if companies:
            clauses.append(and_(StockLevelSetting.scope_level == "company", StockLevelSetting.scope_id.in_(companies)))
        if shops:
            clauses.append(and_(StockLevelSetting.scope_level == "shop", StockLevelSetting.scope_id.in_(shops)))
        rows = db.query(StockLevelSetting).filter(or_(*clauses)).all() if clauses else []
        self.rules = [
            Rule(r.scope_level, str(r.scope_id), r.item_kind, str(r.item_id) if r.item_id else None, _safe_levels(r.levels))
            for r in rows
        ]
        self.updated_at = max((r.updated_at for r in rows if r.updated_at is not None), default=None)

    def managed(self, *, company_id: Any, shop_id: Any, product: Any) -> Tuple[str, ...]:
        return resolve_managed(
            self.rules,
            company_id=str(company_id) if company_id else None,
            shop_id=str(shop_id) if shop_id else None,
            product_id=str(product.id) if product is not None else None,
            category_id=str(product.category_id) if product is not None and product.category_id else None,
        )


_READY: Any = None


def table_ready(db: Session, name: str) -> bool:
    """
    The table exists on this session's database — always in production (the migrations); an
    in-memory test world of another feature creates only the tables it tests. Asked once per
    engine and table (only a yes is remembered).
    """
    global _READY
    import weakref

    from sqlalchemy import inspect as sa_inspect

    if _READY is None:
        _READY = weakref.WeakKeyDictionary()
    try:
        engine = db.get_bind()
        engine = getattr(engine, "engine", engine)
    except Exception:  # noqa: BLE001
        return False
    known = _READY.get(engine)
    if known is not None and name in known:
        return True
    try:
        ok = bool(sa_inspect(db.connection()).has_table(name))
    except Exception:  # noqa: BLE001
        ok = False
    if ok:
        _READY.setdefault(engine, set()).add(name)
    return ok


def _rules_ready(db: Session) -> bool:
    return table_ready(db, "stock_level_settings")


def _safe_levels(raw: Any) -> Tuple[str, ...]:
    try:
        return normalize_levels(raw)
    except ValueError:
        return DEFAULT_LEVELS


def rulebook_for_path(db: Session, path: Path) -> RuleBook:
    return RuleBook(db, company_ids=[path.company_id], shop_ids=[path.shop_id])


def managed_for(db: Session, path: Path, product: Any, book: Optional[RuleBook] = None) -> Tuple[str, ...]:
    book = book or rulebook_for_path(db, path)
    return book.managed(company_id=path.company_id, shop_id=path.shop_id, product=product)


def location_name(db: Session, loc: Location) -> Optional[str]:
    from app.models.company import Company
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea

    model = {"company": Company, "shop": Shop, "area": ShopArea, "machine": POSMachine}.get(loc.level)
    if model is None:
        group = group_hook(db, group_id=loc.target_id)
        return group.get("name") if group else None
    row = db.get(model, loc.target_id)
    return getattr(row, "name", None) if row is not None else None


def location_out(db: Session, loc: Location) -> Dict[str, Any]:
    return {**loc.out(), "name": location_name(db, loc), "levelLabel": LEVEL_LABELS.get(loc.level, loc.level)}
