"""
Blocks on a product — "אזל" (sold out) and "חסום" (blocked) — for any scope, for a while.

* **The blocks** — `sold_out_marks` (app/models/sold_out.py): `scope` (an enum) + `scope_id`,
  `kind`, `until`, `source`. A block is in force from `created_at` until `until`, or until removed.
  Removing stamps `cleared_at` and `updated_at` and never deletes, so a till's delta pull sees it and
  the screen can say who did what. Several blocks may cover one product; any one in force that
  covers a device stops it there.
* **Two axes** (specs/item-blocks-targets.md) — the level: company · shop · area · group (device
  groups, through app/services/device_groups.py) · event · machine (a till or a kiosk); and the
  target: all ("קופות וקיוסקים") · kiosks ("קיוסקים בלבד") · tills ("קופות בלבד"). The older scopes
  `kiosks` (every kiosk of a shop) and `kiosk` (one kiosk) stay readable as shop / machine + kiosks;
  new blocks are written as level + target. Which devices a block reaches: `devices_reached` (the
  cloud) and the shared `sold_out_rules.covers` (the cloud and the till, pinned by the golden fixture).
* **Channels** (the owner, 10.10) — a block stops the item on any of pos / kiosk / online / menu
  (`channels`; a new block: all four). `target` stays, written from the channels for the devices
  that read only it. Online ordering and the digital menu have no device: they ask
  `resolve_channel`, with the product's "מופיע ב" (app/services/product_channels.py).
* **What** — a product, or a category: every product in it or below it (`category_chains`). Each
  product row a device gets carries its category's blocks too, so the device needs no tree.
* **One list** — "מוסתר בקיוסקים" (app/services/kiosk_live.py) writes here as a shop-level,
  kiosks-only "חסום" that hides ("hide"); the kiosks also get every "hide" block reaching them in
  `catalog.hiddenProducts` / `hiddenCategories` (`kiosk_hidden`), which every kiosk applies.
* **What a till gets** — each product row of its catalog (app/services/sync.py) carries the blocks in
  force that cover it (`blocks`), the catalog lock's own answer (`lockAvailable`) and `isAvailable` =
  not locked and not blocked. So an older till, the web kiosk and the Windows kiosk — which read
  `isAvailable` only — stop selling it at once (the kiosks grey it "אזל" or hide it by
  `general.soldOutMode`), and a current till runs `decide` over `blocks` with its own clock: "אזל"
  (a manager may approve a sale with the manager code) or "חסום" (refused).
* **Fast** — a block, its removal, an extension and an automatic block wake the devices it reaches
  with the catalog signal (Ably) after the commit; each pulls its catalog within seconds. A block that
  ends by its `until` needs no signal: every device lifts it by its own clock, offline too, and the
  product's next delta carries it (the row's `updatedAt` moves to `until`).
* **Automatic** — `autoSoldOutAtZero` (POS settings, tenant → company → shop → area; on unless a layer
  turns it off): stock that a product is sold from reaching 0 sets an automatic "אזל" for the devices
  that sell from it, and stock back above 0 clears it (`on_stock_crossing`, called by
  app/services/stock.py — today for the shop's stock). Hand blocks are never touched by stock.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.report_event import ReportEvent, ReportEventMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.sold_out import (
    SOLD_OUT_CHANNELS, SOLD_OUT_DISPLAYS, SOLD_OUT_KINDS, SOLD_OUT_ORIGINS, SOLD_OUT_SCOPES, SOLD_OUT_TARGETS, SoldOutMark,
)
from app.services import device_groups
from app.services import sold_out_rules as rules

logger = logging.getLogger(__name__)

#: `reason` on the catalog signal the devices get.
NOTIFY_REASON = "sold_out"
SETTING_AUTO = rules.SETTING_AUTO
AUTO_BY = "מלאי אזל"
AUTO_CLEARED_BY = "מלאי חזר"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat() if value is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


_READY: "weakref.WeakKeyDictionary" = None  # type: ignore[assignment]


def tables_ready(db: Session) -> bool:
    """
    Whether `sold_out_marks` exists on this connection's database — always in production (the
    migration); the in-memory test worlds of other features create only the tables they test, and
    their catalog pulls must not fail over a feature they do not use. Asked once per engine.
    """
    global _READY
    import weakref

    if _READY is None:
        _READY = weakref.WeakKeyDictionary()
    try:
        engine = db.get_bind()
        engine = getattr(engine, "engine", engine)
    except Exception:  # noqa: BLE001 - an unbound session reads nothing
        return False
    known = _READY.get(engine)
    if known is None:
        from sqlalchemy import inspect as sa_inspect

        try:
            known = bool(sa_inspect(db.connection()).has_table(SoldOutMark.__tablename__))
        except Exception:  # noqa: BLE001
            known = False
        if known:
            _READY[engine] = True
    return bool(known)


def in_force_filter(now: datetime):
    """SQL: the block is in force at `now`."""
    return and_(
        SoldOutMark.cleared_at.is_(None),
        or_(SoldOutMark.until.is_(None), SoldOutMark.until > now),
    )


def is_in_force(mark: SoldOutMark, now: datetime) -> bool:
    return mark.cleared_at is None and rules.in_force(_aware(mark.until), now)


# ── Who a device is ──────────────────────────────────────────────────────────


def is_kiosk(db: Session, machine: POSMachine) -> bool:
    """A device converted to a self-order kiosk (and enabled as one)."""
    from app.models.kiosk import KioskDevice

    device = db.get(KioskDevice, machine.id)
    # A till's kiosk-mode row (home_role "till") is no kiosk role.
    return device is not None and bool(device.enabled) and getattr(device, "home_role", None) is None


def event_ids_of(db: Session, machine_id: Any) -> List[Any]:
    """The events this device is in now (assigned and not released)."""
    if machine_id is None:
        return []
    rows = (
        db.query(ReportEventMachine.event_id)
        .filter(ReportEventMachine.machine_id == machine_id, ReportEventMachine.released_at.is_(None))
        .all()
    )
    return [r[0] for r in rows]


@dataclass
class DeviceContext:
    company_id: Any
    shop_id: Any
    area_id: Any
    machine_id: Any
    is_kiosk: bool = False
    event_ids: List[Any] = field(default_factory=list)
    group_ids: List[Any] = field(default_factory=list)

    def till(self) -> rules.Till:
        return rules.Till(
            company_id=str(self.company_id) if self.company_id else None,
            shop_id=str(self.shop_id) if self.shop_id else None,
            area_id=str(self.area_id) if self.area_id else None,
            machine_id=str(self.machine_id) if self.machine_id else None,
            is_kiosk=self.is_kiosk,
            event_ids=tuple(str(e) for e in self.event_ids),
            group_ids=tuple(str(g) for g in self.group_ids),
        )

    def scope_pairs(self) -> List[Tuple[str, Any]]:
        pairs: List[Tuple[str, Any]] = [("shop", self.shop_id), ("machine", self.machine_id)]
        if self.company_id is not None:
            pairs.append(("company", self.company_id))
        if self.area_id is not None:
            pairs.append(("area", self.area_id))
        if self.is_kiosk:
            pairs += [("kiosk", self.machine_id), ("kiosks", self.shop_id)]
        pairs += [("event", e) for e in self.event_ids]
        pairs += [("group", g) for g in self.group_ids]
        return pairs


def device_context(db: Session, machine: POSMachine) -> DeviceContext:
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    return DeviceContext(
        company_id=shop.company_id if shop is not None else None,
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        machine_id=machine.id,
        is_kiosk=is_kiosk(db, machine),
        event_ids=event_ids_of(db, machine.id),
        group_ids=device_groups.groups_of(db, machine.id),
    )


def _scope_filter(ctx: DeviceContext):
    return or_(*[and_(SoldOutMark.scope == scope, SoldOutMark.scope_id == ident) for scope, ident in ctx.scope_pairs()])


# ── What a device is sent ────────────────────────────────────────────────────


@dataclass
class ProductBlocks:
    """The blocks of one product that reach one device."""

    #: In force now, covering the device.
    active: List[SoldOutMark] = field(default_factory=list)
    #: When what the device should show last changed (a block set, removed, extended or ended).
    changed_at: Optional[datetime] = None


def category_chains(db: Session, category_ids: Iterable[Any]) -> Dict[str, List[str]]:
    """`{category id: [it, its parent, …, the top]}` — a category block covers what is in it or below it."""
    wanted = {str(c) for c in category_ids if c is not None}
    parents: Dict[str, Optional[str]] = {}
    todo = set(wanted)
    while todo:
        ids = [i for i in (_uuid(c) for c in todo) if i is not None]
        found = set()
        if ids:
            for cid, pid in db.query(Category.id, Category.parent_id).filter(Category.id.in_(ids)).all():
                parents[str(cid)] = str(pid) if pid is not None else None
                found.add(str(cid))
        for c in todo - found:
            parents[c] = None
        todo = {pid for pid in parents.values() if pid is not None and pid not in parents}
    out: Dict[str, List[str]] = {}
    for c in wanted:
        chain: List[str] = []
        cur: Optional[str] = c
        while cur is not None and cur not in chain:
            chain.append(cur)
            cur = parents.get(cur)
        out[c] = chain
    return out


def product_category_chains(db: Session, product_ids: Iterable[Any]) -> Dict[str, List[str]]:
    """`{product id: its category and every one above it}` ([] for a product with no category)."""
    ids = [i for i in (_uuid(p) for p in product_ids) if i is not None]
    if not ids:
        return {}
    cats = {str(pid): (str(cid) if cid is not None else None) for pid, cid in db.query(Product.id, Product.category_id).filter(Product.id.in_(ids)).all()}
    chains = category_chains(db, [c for c in cats.values() if c])
    return {pid: (chains.get(cid, []) if cid else []) for pid, cid in cats.items()}


def blocks_for_machine(
    db: Session,
    machine: POSMachine,
    product_ids: Optional[Sequence[Any]] = None,
    *,
    now: Optional[datetime] = None,
    since: Optional[datetime] = None,
    ctx: Optional[DeviceContext] = None,
) -> Dict[str, ProductBlocks]:
    """
    `{str(product_id): ProductBlocks}` for the products whose blocks reach this device: those in
    force, and — for a delta pull — those set, removed or ended since `since`. A category's block is
    listed under every one of `product_ids` in it or below it (none without `product_ids`).
    """
    if machine.shop_id is None or not tables_ready(db):
        return {}
    now = now or utc_now()
    ctx = ctx or device_context(db, machine)
    q = db.query(SoldOutMark).filter(_scope_filter(ctx))
    chains: Dict[str, List[str]] = {}
    if product_ids is not None:
        ids = [i for i in product_ids if i is not None]
        if not ids:
            return {}
        chains = product_category_chains(db, ids)
        cats = {c for chain in chains.values() for c in chain}
        item = SoldOutMark.product_id.in_(ids)
        if cats:
            item = or_(item, SoldOutMark.category_id.in_([_uuid(c) for c in cats]))
        q = q.filter(item)
    else:
        q = q.filter(SoldOutMark.product_id.isnot(None))
    relevant = [in_force_filter(now)]
    if since is not None:
        relevant.append(SoldOutMark.updated_at > since)
        relevant.append(and_(SoldOutMark.until > since, SoldOutMark.until <= now))
    q = q.filter(or_(*relevant))
    till = ctx.till()
    grouped: Dict[str, List[SoldOutMark]] = {}
    sells_from: Dict[Any, Any] = {}
    for mark in q.all():
        if not rules.covers(mark, till):
            continue
        # An automatic "אזל" is about one stock location: it reaches only the devices that sell
        # the product from it (app/services/stock_locations.py `sell_from`).
        if mark.source == "auto" and not _sells_from(db, machine, mark, sells_from):
            continue
        if mark.product_id is not None:
            grouped.setdefault(str(mark.product_id), []).append(mark)
            continue
        cat = str(mark.category_id)
        for pid, chain in chains.items():
            if cat in chain:
                grouped.setdefault(pid, []).append(mark)
    out: Dict[str, ProductBlocks] = {}
    for pid, marks in grouped.items():
        stamps: List[datetime] = []
        for m in marks:
            stamps.append(_aware(m.updated_at) or now)
            until = _aware(m.until)
            if until is not None and until <= now:
                stamps.append(until)
        out[pid] = ProductBlocks(
            active=[m for m in marks if is_in_force(m, now)],
            changed_at=max(stamps) if stamps else None,
        )
    return out


def kiosk_hidden(db: Session, machine: POSMachine, now: Optional[datetime] = None) -> Tuple[List[str], List[str]]:
    """
    `(product ids, category ids)` that the blocks in force reaching this kiosk ask to hide ("הסתר"):
    a product as its global id and as this device's own row of it — whichever id its catalog row
    carries — for the kiosk config's `hiddenProducts` / `hiddenCategories` (app/services/kiosk_live.py).
    """
    if getattr(machine, "shop_id", None) is None or not tables_ready(db):
        return [], []
    now = now or utc_now()
    ctx = device_context(db, machine)
    if not ctx.is_kiosk:
        return [], []
    till = ctx.till()
    marks = [
        m for m in db.query(SoldOutMark).filter(
            _scope_filter(ctx), in_force_filter(now), SoldOutMark.kiosk_display == rules.DISPLAY_HIDE,
        ).order_by(SoldOutMark.created_at).all()
        if rules.covers(m, till)
    ]
    products: List[str] = []
    for m in marks:
        if m.product_id is not None and str(m.product_id) not in products:
            products.append(str(m.product_id))
    if products:
        own = db.query(Product.id).filter(
            Product.pos_machine_id == machine.id, Product.global_product_id.in_([_uuid(p) for p in products]),
        ).all()
        products += [str(r[0]) for r in own if str(r[0]) not in products]
    categories: List[str] = []
    for m in marks:
        if m.category_id is not None and str(m.category_id) not in categories:
            categories.append(str(m.category_id))
    return products, categories


def _sells_from(db: Session, machine: POSMachine, mark: SoldOutMark, cache: Dict[Any, Any]) -> bool:
    """The automatic block's location is where this device sells the product from."""
    from app.services import stock_locations as SL

    if "path" not in cache:
        cache["path"] = SL.path_of_machine(db, machine)
        cache["book"] = SL.rulebook_for_path(db, cache["path"])
    key = mark.product_id
    if key not in cache:
        product = db.get(Product, mark.product_id)
        if product is None:
            cache[key] = None
        else:
            managed = cache["book"].managed(company_id=cache["path"].company_id, shop_id=cache["path"].shop_id, product=product)
            cache[key] = SL.sell_from(cache["path"], managed)
    loc = cache[key]
    return loc is not None and loc.level == mark.scope and str(loc.target_id) == str(mark.scope_id)


def manual_in_force(blocks: Iterable[Any]) -> bool:
    """Any block set by hand among these (an automatic "אזל" is never folded into `isAvailable`)."""
    return any((getattr(b, "source", None) or "manual") != "auto" for b in blocks)


def kiosk_display(blocks: Iterable[Any]) -> Optional[str]:
    """The kiosks' own look among these blocks in force: "hide" wins, then "grey", else None."""
    return rules.display_of(list(blocks))


def channels_of(mark: Any) -> tuple:
    """The channels a block stops the item on (one written before channels: what its target meant)."""
    return rules.channels_of(mark)


def target_of(mark: Any) -> str:
    """What the block's channels mean for the devices: "all" / "kiosks" / "tills" / "none"."""
    return rules.target_for(channels_of(mark))


def level_of(mark: Any) -> str:
    """The level a block is at (an older kiosks / kiosk scope: shop / machine)."""
    return rules.level_of(mark)[0]


def block_out(mark: SoldOutMark) -> Dict[str, Any]:
    """One block as a device gets it (and the shared rule reads it). Older tills ignore the new keys."""
    return {
        "id": str(mark.id),
        "scope": mark.scope,
        "scopeId": str(mark.scope_id),
        "target": target_of(mark),
        "channels": list(channels_of(mark)),
        "kind": mark.kind or "sold_out",
        "source": mark.source,
        "until": _iso(mark.until),
        "createdAt": _iso(mark.created_at),
        "by": mark.created_by_name,
        "note": mark.note,
        "productId": str(mark.product_id) if mark.product_id is not None else None,
        "categoryId": str(mark.category_id) if mark.category_id is not None else None,
        "kioskDisplay": mark.kiosk_display,
    }


# ── Whom a block reaches ─────────────────────────────────────────────────────


def _kiosk_ids(db: Session, machine_ids: Iterable[Any]) -> set:
    from app.models.kiosk import KioskDevice

    ids = [i for i in machine_ids if i is not None]
    if not ids:
        return set()
    return {
        r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None))
        .filter(KioskDevice.machine_id.in_(ids), KioskDevice.enabled.is_(True)).all()
    }


def devices_reached(
    db: Session, scope: str, scope_id: Any, target: Optional[str] = None, channels: Any = None,
) -> List[POSMachine]:
    """The active devices a block of this scope and channels (or, before channels, target) reaches now."""
    named = set(rules.channels_of({"scope": scope, "target": target, "channels": channels}))
    if rules.CH_POS not in named and rules.CH_KIOSK not in named:
        return []
    rows = _level_devices(db, rules.level_name({"scope": scope}), scope_id)
    if (rules.CH_POS in named and rules.CH_KIOSK in named) or not rows:
        return rows
    kiosks = _kiosk_ids(db, [m.id for m in rows])
    want = rules.CH_KIOSK if rules.CH_KIOSK in named else rules.CH_POS
    return [m for m in rows if (rules.CH_KIOSK if m.id in kiosks else rules.CH_POS) == want]


def mark_devices(db: Session, mark: SoldOutMark) -> List[POSMachine]:
    return devices_reached(db, mark.scope, mark.scope_id, mark.target, mark.channels)


def _level_devices(db: Session, scope: str, scope_id: Any) -> List[POSMachine]:
    """The active devices a level reaches, kiosks and tills alike."""
    q = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if scope == "shop":
        return q.filter(POSMachine.shop_id == scope_id).all()
    if scope == "company":
        return q.join(Shop, Shop.id == POSMachine.shop_id).filter(Shop.company_id == scope_id).all()
    if scope == "area":
        return q.filter(POSMachine.area_id == scope_id).all()
    if scope == "machine":
        return q.filter(POSMachine.id == scope_id).all()
    if scope == "event":
        return (
            q.join(ReportEventMachine, ReportEventMachine.machine_id == POSMachine.id)
            .filter(ReportEventMachine.event_id == scope_id, ReportEventMachine.released_at.is_(None))
            .all()
        )
    if scope == "group":
        group = device_groups.group(db, scope_id)
        ids = list((group or {}).get("machineIds") or [])
        return q.filter(POSMachine.id.in_(ids)).all() if ids else []
    return []


def signal_after_commit(db: Session, devices: Iterable[POSMachine]) -> None:
    from app.services.commit_signals import catalog_signal_after_commit

    catalog_signal_after_commit(
        db, [(str(m.tenant_id), str(m.id)) for m in devices if m.tenant_id is not None], NOTIFY_REASON
    )


# ── The scope a block is written for ─────────────────────────────────────────


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@dataclass(frozen=True)
class Target:
    scope: str
    scope_id: uuid.UUID
    name: str
    company_id: Optional[uuid.UUID]
    shop_id: Optional[uuid.UUID]
    #: The point of sale it lies in (an area, or a device standing in one), for area-scoped managers.
    area_id: Optional[uuid.UUID] = None


def resolve_target(db: Session, scope: str, scope_id: Any, tenant_id: Any) -> Target:
    """The scope's entity, checked to be this tenant's; 422 / 404 otherwise."""
    if scope not in SOLD_OUT_SCOPES:
        raise _bad("invalid_scope", "היקף לא מוכר")
    ident = _uuid(scope_id)
    if ident is None:
        raise _bad("scope_id_required", "חסר מזהה להיקף")

    def same(entity_tenant) -> None:
        if tenant_id is not None and str(entity_tenant) != str(tenant_id):
            raise _bad("scope_not_found", "ההיקף לא נמצא", status.HTTP_404_NOT_FOUND)

    if scope == "company":
        company = db.get(Company, ident)
        if company is None:
            raise _bad("scope_not_found", "החברה לא נמצאה", status.HTTP_404_NOT_FOUND)
        same(company.tenant_id)
        return Target(scope, company.id, company.name, company.id, None)
    if scope in ("shop", "kiosks"):
        shop = db.get(Shop, ident)
        if shop is None:
            raise _bad("scope_not_found", "הסניף לא נמצא", status.HTTP_404_NOT_FOUND)
        same(shop.tenant_id)
        return Target(scope, shop.id, shop.name, shop.company_id, shop.id)
    if scope == "area":
        area = db.get(ShopArea, ident)
        if area is None or area.archived_at is not None:
            raise _bad("scope_not_found", "נקודת המכירה לא נמצאה", status.HTTP_404_NOT_FOUND)
        same(area.tenant_id)
        shop = db.get(Shop, area.shop_id)
        return Target(scope, area.id, area.name, shop.company_id if shop else None, area.shop_id, area.id)
    if scope in ("machine", "kiosk"):
        machine = db.get(POSMachine, ident)
        if machine is None or machine.shop_id is None:
            raise _bad("scope_not_found", "המכשיר לא נמצא", status.HTTP_404_NOT_FOUND)
        same(machine.tenant_id)
        if scope == "kiosk" and not _kiosk_ids(db, [machine.id]):
            raise _bad("not_a_kiosk", "המכשיר אינו קיוסק")
        shop = db.get(Shop, machine.shop_id)
        return Target(scope, machine.id, machine.name, shop.company_id if shop else None, machine.shop_id, machine.area_id)
    if scope == "event":
        event = db.get(ReportEvent, ident)
        if event is None:
            raise _bad("scope_not_found", "האירוע לא נמצא", status.HTTP_404_NOT_FOUND)
        same(event.tenant_id)
        return Target(scope, event.id, event.name, event.company_id, event.shop_id)
    if not device_groups.available():
        raise _bad("groups_unavailable", "קבוצות מכשירים עדיין לא זמינות")
    # A device group (feat/menu-groups, app/services/device_groups.py): this tenant's only. Its company
    # is the group's; its shop the one all its members stand in, else None — a group across shops is
    # then a company-wide target for the scope checks (app/routers/item_blocks.py `_check_target`).
    group = device_groups.group(db, ident, tenant_id)
    if group is None:
        raise _bad("scope_not_found", "הקבוצה לא נמצאה", status.HTTP_404_NOT_FOUND)
    return Target(scope, group["id"], group.get("name") or "", group.get("companyId"), group.get("shopId"))


def global_product(db: Session, product_id: Any, tenant_id: Any) -> Product:
    ident = _uuid(product_id)
    p = db.get(Product, ident) if ident is not None else None
    if p is not None and p.global_product_id:
        p = db.get(Product, p.global_product_id)
    if p is None or (tenant_id is not None and str(p.tenant_id) != str(tenant_id)):
        raise _bad("product_not_found", "המוצר לא נמצא", status.HTTP_404_NOT_FOUND)
    return p


def _user_name(user: Any) -> Optional[str]:
    if user is None:
        return None
    return getattr(user, "username", None) or getattr(user, "email", None)


# ── Writing ──────────────────────────────────────────────────────────────────


def tenant_category(db: Session, category_id: Any, tenant_id: Any) -> Category:
    """The tenant's category, or 404."""
    ident = _uuid(category_id)
    c = db.get(Category, ident) if ident is not None else None
    if c is None or (tenant_id is not None and str(c.tenant_id) != str(tenant_id)):
        raise _bad("category_not_found", "המחלקה לא נמצאה", status.HTTP_404_NOT_FOUND)
    return c


def block(
    db: Session,
    *,
    tenant_id: Any,
    product: Optional[Product] = None,
    target: Target,
    kind: str = "sold_out",
    until: Optional[datetime] = None,
    until_mode: Optional[str] = None,
    note: Optional[str] = None,
    user: Any = None,
    by_name: Optional[str] = None,
    source: str = "manual",
    now: Optional[datetime] = None,
    category: Optional[Category] = None,
    reach: Optional[str] = None,
    display: Optional[str] = None,
    origin: Optional[str] = None,
    channels: Optional[Sequence[str]] = None,
) -> SoldOutMark:
    """
    Block `product` — or every product of `category` — at the target's level on `channels` (pos /
    kiosk / online / menu; none given: what `reach` meant — "all" pos + kiosk, "kiosks", "tills" —
    else all four; an older kiosks / kiosk target means the kiosks) — the caller commits. A block in
    force of the same item, level, channels, kind and source is updated (new end, reason and look)
    rather than doubled. 422 for an end that has passed already, or channels the target contradicts.
    """
    now = now or utc_now()
    if kind not in SOLD_OUT_KINDS:
        raise _bad("invalid_kind", "סוג חסימה לא מוכר")
    if (product is None) == (category is None):
        raise _bad("item_required", "בחרו פריט או מחלקה")
    if display is not None and display not in SOLD_OUT_DISPLAYS:
        raise _bad("invalid_display", "תצוגה בקיוסק לא מוכרת")
    if origin is not None and origin not in SOLD_OUT_ORIGINS:
        origin = None
    if channels is not None:
        unknown = [c for c in channels if c not in SOLD_OUT_CHANNELS]
        if unknown:
            raise _bad("invalid_channel", "ערוץ לא מוכר")
        wanted = tuple(channels)
    elif reach is not None:
        if reach not in rules.TARGETS:
            raise _bad("invalid_target", "יעד לא מוכר")
        wanted = rules.TARGET_CHANNELS[reach]
    else:
        wanted = rules.CHANNELS
    try:
        level, named = rules.normalize_channels(target.scope, wanted)
    except ValueError as refused:
        if str(refused) == "channels_required":
            raise _bad("channels_required", "בחרו לפחות ערוץ אחד: קופה, קיוסק, הזמנות אונליין או תפריט דיגיטלי")
        raise _bad("target_conflict", "\"כל הקיוסקים\" לא יכול להיות \"קופות בלבד\"")
    reach = rules.target_for(named)
    if reach not in SOLD_OUT_TARGETS:
        raise _bad("invalid_target", "יעד לא מוכר")
    until = _aware(until)
    if until is not None and until <= now:
        raise _bad("until_passed", "שעת הסיום כבר עברה")
    # The same block written under an older scope ("כל הקיוסקים" / "קיוסק") is the same block.
    older = {"shop": "kiosks", "machine": "kiosk"}.get(level) if named == (rules.CH_KIOSK,) else None
    item = SoldOutMark.product_id == product.id if product is not None else SoldOutMark.category_id == category.id
    existing = next(
        (
            m for m in db.query(SoldOutMark)
            .filter(
                item,
                SoldOutMark.scope.in_([level] + ([older] if older else [])),
                SoldOutMark.scope_id == target.scope_id,
                SoldOutMark.kind == kind,
                SoldOutMark.source == source,
                in_force_filter(now),
            )
            .all()
            if channels_of(m) == named
        ),
        None,
    )
    who = by_name or _user_name(user)
    text = (note or "").strip()[:200] or None
    if existing is not None:
        existing.until = until
        existing.until_mode = until_mode
        existing.note = text
        existing.kiosk_display = display
        existing.updated_at = now
        row = existing
    else:
        row = SoldOutMark(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            company_id=target.company_id,
            shop_id=target.shop_id,
            product_id=product.id if product is not None else None,
            category_id=category.id if category is not None else None,
            scope=level,
            scope_id=target.scope_id,
            target=reach,
            channels=list(named),
            kind=kind,
            kiosk_display=display,
            origin=origin,
            until=until,
            until_mode=until_mode,
            source=source,
            note=text,
            created_by_user_id=getattr(user, "id", None),
            created_by_name=(who or None) and who[:200],
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    db.flush()
    signal_after_commit(db, mark_devices(db, row))
    return row


def clear(db: Session, mark: SoldOutMark, *, user: Any = None, by_name: Optional[str] = None, now: Optional[datetime] = None) -> SoldOutMark:
    """Remove one block ("בטל עכשיו"; the caller commits)."""
    now = now or utc_now()
    if mark.cleared_at is None:
        who = by_name or _user_name(user)
        mark.cleared_at = now
        mark.cleared_by_user_id = getattr(user, "id", None)
        mark.cleared_by_name = (who or None) and who[:200]
        mark.updated_at = now
        db.flush()
        signal_after_commit(db, mark_devices(db, mark))
    return mark


def extend(db: Session, mark: SoldOutMark, minutes: int, *, now: Optional[datetime] = None) -> SoldOutMark:
    """"הארך": the end moved by `minutes` (the caller commits). 422 for an open-ended or removed block."""
    from app.services import block_durations

    now = now or utc_now()
    if not is_in_force(mark, now):
        raise _bad("not_in_force", "החסימה כבר לא בתוקף")
    try:
        mark.until = block_durations.extend(_aware(mark.until), now, minutes)
    except block_durations.DurationRefused as refused:
        raise _bad(refused.code, refused.message) from refused
    mark.updated_at = now
    db.flush()
    signal_after_commit(db, mark_devices(db, mark))
    return mark


def clear_product(
    db: Session,
    *,
    product: Optional[Product] = None,
    category: Optional[Category] = None,
    scopes: Optional[Sequence[Tuple[str, Any]]] = None,
    shop_ids: Optional[Sequence[Any]] = None,
    sources: Sequence[str] = ("manual", "auto"),
    user: Any = None,
    by_name: Optional[str] = None,
    now: Optional[datetime] = None,
) -> List[SoldOutMark]:
    """Remove the blocks in force of a product (or a category) — of these scopes, or of these shops. The caller commits."""
    now = now or utc_now()
    item = SoldOutMark.product_id == product.id if product is not None else SoldOutMark.category_id == category.id
    q = db.query(SoldOutMark).filter(
        item,
        SoldOutMark.source.in_(list(sources)),
        in_force_filter(now),
    )
    if scopes:
        q = q.filter(or_(*[and_(SoldOutMark.scope == s, SoldOutMark.scope_id == i) for s, i in scopes]))
    if shop_ids is not None:
        q = q.filter(SoldOutMark.shop_id.in_([s for s in shop_ids if s is not None]))
    rows = q.all()
    for row in rows:
        clear(db, row, user=user, by_name=by_name, now=now)
    return rows


# ── Automatic: stock reached 0, or came back ─────────────────────────────────


def auto_setting_on(db: Session, shop_id: Any, area_id: Any = None, *, company_id: Any = None) -> bool:
    """
    `autoSoldOutAtZero` for the shop (or its point of sale), or — stock held at the company — for the
    company itself: on unless a layer turns it off.
    """
    from types import SimpleNamespace

    from app.models.tenant import Tenant
    from app.services.settings_merge import merge_all_settings_layers

    shop = db.get(Shop, shop_id) if shop_id is not None else None
    if shop is None:
        company = db.get(Company, company_id) if company_id is not None else None
        if company is None:
            return True
        tenant = db.get(Tenant, company.tenant_id) if company.tenant_id else None
        return rules.auto_on(merge_all_settings_layers(company, None, tenant).get(SETTING_AUTO))
    company = db.get(Company, shop.company_id) if shop.company_id else None
    tenant = db.get(Tenant, shop.tenant_id) if shop.tenant_id else None
    area = db.get(ShopArea, area_id) if area_id is not None else None
    merged = merge_all_settings_layers(company or SimpleNamespace(settings={}), shop, tenant, None, area)
    return rules.auto_on(merged.get(SETTING_AUTO))


def on_stock_crossing(
    db: Session,
    *,
    tenant_id: Any,
    scope: str,
    scope_id: Any,
    product_id: Any,
    ran_out: bool,
    now: Optional[datetime] = None,
) -> Optional[str]:
    """
    The hook stock calls when a tracked product's stock that devices sell from crossed 0: `scope` /
    `scope_id` is that stock's place ("shop" + the shop today; any location level later). Ran out →
    an automatic "אזל" for it (the setting on, none already in force); came back → its automatic
    blocks removed. Returns "blocked" / "cleared" / None.
    """
    now = now or utc_now()
    product = db.get(Product, product_id)
    if product is None or not tables_ready(db):
        return None
    try:
        target = resolve_target(db, scope, scope_id, tenant_id)
    except HTTPException:
        return None
    if ran_out:
        # The layers down to the stock's own place: the company's for company stock, a point of
        # sale's for its stock and its tills' own.
        area_for_setting = getattr(target, "area_id", None) if scope in ("area", "machine", "kiosk") else None
        if not auto_setting_on(db, target.shop_id, area_for_setting, company_id=target.company_id):
            return None
        existing = (
            db.query(SoldOutMark.id)
            .filter(
                SoldOutMark.product_id == product.id,
                SoldOutMark.scope == target.scope,
                SoldOutMark.scope_id == target.scope_id,
                SoldOutMark.source == "auto",
                in_force_filter(now),
            )
            .first()
        )
        if existing is not None:
            return None
        block(db, tenant_id=tenant_id, product=product, target=target, by_name=AUTO_BY, source="auto", now=now, origin="stock")
        return "blocked"
    cleared = clear_product(
        db, product=product, scopes=[(target.scope, target.scope_id)], sources=("auto",), by_name=AUTO_CLEARED_BY, now=now,
    )
    return "cleared" if cleared else None


# ── The dashboard ────────────────────────────────────────────────────────────


def _scope_names(db: Session, marks: Sequence[SoldOutMark]) -> Dict[Tuple[str, str], str]:
    names: Dict[Tuple[str, str], str] = {}
    by_scope: Dict[str, set] = {}
    for m in marks:
        by_scope.setdefault(m.scope, set()).add(m.scope_id)
    model = {
        "company": Company, "shop": Shop, "kiosks": Shop, "area": ShopArea,
        "machine": POSMachine, "kiosk": POSMachine, "event": ReportEvent,
    }
    for scope, ids in by_scope.items():
        cls = model.get(scope)
        if cls is None:
            for gid in ids:
                group = device_groups.group(db, gid)
                names[(scope, str(gid))] = (group or {}).get("name") or ""
            continue
        for row in db.query(cls).filter(cls.id.in_(list(ids))).all():
            names[(scope, str(row.id))] = getattr(row, "name", None) or ""
    return names


def mark_view(
    m: SoldOutMark,
    *,
    product: Optional[Product],
    names: Dict[Tuple[str, str], str],
    shops: Dict[Any, str],
    now: datetime,
    category: Optional[Category] = None,
) -> Dict[str, Any]:
    until = _aware(m.until)
    is_category = m.product_id is None and m.category_id is not None
    return {
        **block_out(m),
        "untilMode": m.until_mode,
        # The level and whom at it, an older kiosks / kiosk scope read as shop / machine + kiosks.
        "level": level_of(m),
        "target": target_of(m),
        "channels": list(channels_of(m)),
        "itemType": "category" if is_category else "product",
        "itemName": (category.name if category is not None else None) if is_category else (product.name if product is not None else None),
        "origin": m.origin,
        "productId": str(m.product_id) if m.product_id is not None else None,
        "productName": product.name if product is not None else None,
        "imageUrl": product.image_url if product is not None else None,
        # A product block: the product's category; a category block: the category itself.
        "categoryId": (
            str(m.category_id) if is_category
            else (str(product.category_id) if product is not None and product.category_id else None)
        ),
        "categoryName": category.name if category is not None else None,
        "shopId": str(m.shop_id) if m.shop_id else None,
        "shopName": shops.get(m.shop_id),
        "companyId": str(m.company_id) if m.company_id else None,
        "scopeName": names.get((m.scope, str(m.scope_id))),
        "secondsLeft": int((until - now).total_seconds()) if until is not None else None,
        "inForce": is_in_force(m, now),
        "clearedAt": _iso(m.cleared_at),
        "clearedBy": m.cleared_by_name,
    }


def views(db: Session, marks: Sequence[SoldOutMark], now: datetime) -> List[Dict[str, Any]]:
    """The dashboard's (and a device's) rows for these blocks, with names."""
    names = _scope_names(db, marks)
    pids = list({m.product_id for m in marks if m.product_id is not None})
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(pids)).all()} if pids else {}
    cids = list({m.category_id for m in marks if m.category_id is not None})
    categories = {c.id: c for c in db.query(Category).filter(Category.id.in_(cids)).all()} if cids else {}
    sids = list({m.shop_id for m in marks if m.shop_id is not None})
    shops = {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(sids)).all()} if sids else {}
    return [
        mark_view(
            m, product=products.get(m.product_id), names=names, shops=shops, now=now,
            category=categories.get(m.category_id),
        )
        for m in marks
    ]


def reaches_area(db: Session, mark: SoldOutMark, area: ShopArea, *, company_id: Any = None, cache: Optional[Dict[Any, Any]] = None) -> bool:
    """
    The block reaches a device of this point of sale: the company or the shop it lies in, the point
    of sale itself, a device standing in it, or an event / a group with a device in it.
    """
    level = level_of(mark)
    sid = str(mark.scope_id)
    if level == "company":
        return company_id is not None and sid == str(company_id)
    if level == "shop":
        return sid == str(area.shop_id)
    if level == "area":
        return sid == str(area.id)
    cache = cache if cache is not None else {}
    if level == "machine":
        key = ("m", sid)
        if key not in cache:
            machine = db.get(POSMachine, mark.scope_id)
            cache[key] = machine.area_id if machine is not None else None
        return cache[key] is not None and str(cache[key]) == str(area.id)
    if level in ("event", "group"):
        key = (level, sid)
        if key not in cache:
            cache[key] = {str(m.area_id) for m in _level_devices(db, level, mark.scope_id) if m.area_id is not None}
        return str(area.id) in cache[key]
    return False


def list_blocks(
    db: Session,
    *,
    tenant_id: Any,
    shop_ids: Optional[Sequence[Any]] = None,
    company_ids: Optional[Sequence[Any]] = None,
    product_id: Any = None,
    now: Optional[datetime] = None,
    include_ended: bool = False,
    limit: int = 500,
    category_id: Any = None,
    area_id: Any = None,
    target: Optional[str] = None,
    channel: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    The blocks in force (or, `include_ended`, also those removed or ended in the last day) of these
    shops — and of their companies (company-wide blocks) — newest first, with names. `product_id`:
    its own blocks and its category's (and above); `category_id`: that category's blocks; `area_id`:
    those that reach a device of that point of sale (`reaches_area`); `target`: "all" / "kiosks" /
    "tills" as the block means it.
    """
    now = now or utc_now()
    q = db.query(SoldOutMark).filter(SoldOutMark.tenant_id == tenant_id)
    places = []
    if shop_ids is not None:
        ids = [s for s in shop_ids if s is not None]
        places.append(SoldOutMark.shop_id.in_(ids) if ids else SoldOutMark.id.is_(None))
    if company_ids is not None:
        cids = [c for c in company_ids if c is not None]
        if cids:
            places.append(and_(SoldOutMark.scope == "company", SoldOutMark.company_id.in_(cids)))
    if places:
        q = q.filter(or_(*places))
    if product_id is not None:
        chain = product_category_chains(db, [product_id]).get(str(product_id), [])
        item = SoldOutMark.product_id == product_id
        if chain:
            item = or_(item, SoldOutMark.category_id.in_([_uuid(c) for c in chain]))
        q = q.filter(item)
    if category_id is not None:
        q = q.filter(SoldOutMark.category_id == category_id)
    if include_ended:
        from datetime import timedelta

        q = q.filter(or_(in_force_filter(now), SoldOutMark.updated_at > now - timedelta(days=1)))
    else:
        q = q.filter(in_force_filter(now))
    marks = q.order_by(SoldOutMark.created_at.desc()).limit(limit).all()
    # As the block means it now: its channels (one written before channels: what its target meant).
    if target is not None:
        marks = [m for m in marks if target_of(m) == target]
    if channel is not None:
        marks = [m for m in marks if channel in channels_of(m)]
    if area_id is not None:
        area = db.get(ShopArea, _uuid(area_id))
        if area is None:
            return []
        shop = db.get(Shop, area.shop_id)
        cache: Dict[Any, Any] = {}
        marks = [m for m in marks if reaches_area(db, m, area, company_id=shop.company_id if shop else None, cache=cache)]
    return views(db, marks, now)


# ── The channels with no device: online ordering, the digital menu ────────────


def resolve_channel(
    db: Session,
    *,
    tenant_id: Any,
    shop_id: Any,
    channel: str,
    product_ids: Sequence[Any],
    area_id: Any = None,
    now: Optional[datetime] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    What one channel shows of these products at a shop (and, `area_id`, a point of sale): for each,
    `appears` — its "מופיע ב" names the channel (app/services/product_channels.py) — and what the
    blocks in force that reach that channel there decide (the shared rule, with a `Till` of that
    channel: the shop's and its company's blocks, the point of sale's, a category's too). For online
    ordering and the digital menu, which call this; any channel works (pos / kiosk: what a till /
    a kiosk of the shop with no device-level block would see).

    `{product id: {appears, state, sellable, overridable, reason, until, display, block}}`.
    """
    from app.services import product_channels

    now = now or utc_now()
    if channel not in rules.CHANNELS:
        raise _bad("invalid_channel", "ערוץ לא מוכר")
    shop = db.get(Shop, _uuid(shop_id)) if shop_id is not None else None
    if shop is None or (tenant_id is not None and str(shop.tenant_id) != str(tenant_id)):
        raise _bad("shop_not_found", "הסניף לא נמצא", status.HTTP_404_NOT_FOUND)
    ids = [i for i in (_uuid(p) for p in product_ids) if i is not None]
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(ids)).all()} if ids else {}
    chains = product_category_chains(db, list(products))
    marks: List[SoldOutMark] = []
    if products and tables_ready(db):
        places = [SoldOutMark.shop_id == shop.id]
        if shop.company_id is not None:
            places.append(and_(SoldOutMark.scope == "company", SoldOutMark.company_id == shop.company_id))
        cats = {c for chain in chains.values() for c in chain}
        item = SoldOutMark.product_id.in_(list(products))
        if cats:
            item = or_(item, SoldOutMark.category_id.in_([_uuid(c) for c in cats]))
        marks = db.query(SoldOutMark).filter(or_(*places), item, in_force_filter(now)).all()
    till = rules.Till(
        company_id=str(shop.company_id) if shop.company_id else None,
        shop_id=str(shop.id),
        area_id=str(area_id) if area_id is not None else None,
        channel=channel,
    )
    out: Dict[str, Dict[str, Any]] = {}
    for pid, product in products.items():
        decision = rules.decide(
            marks, now, till=till, item=rules.Item(str(pid), tuple(chains.get(str(pid), ()))),
        )
        shown = decision.block
        out[str(pid)] = {
            "appears": product_channels.appears(product, channel),
            "state": decision.state,
            "sellable": decision.sellable,
            "overridable": decision.overridable,
            "reason": decision.reason,
            "until": _iso(decision.until),
            "display": decision.display,
            "block": block_out(shown) if shown is not None else None,
        }
    return out
