"""
"פתיחת פריטים אוטומטית אחרי Z" — reopen locked and sold-out items when a Z closes the
trading day (docs/SPEC_AVAILABILITY.md).

**The setting** (`autoReopenAfterZ`, in the POS settings layers tenant → company → shop →
point of sale → till, so it inherits like every other one):

* ``off`` (the default) — nothing is reopened;
* ``day`` — reopen what was locked or marked sold out **during the day** the Z closes: a
  lock that began after the scope's previous day close (or in the 24 hours before the Z,
  when the scope has none on record yet);
* ``all`` — reopen every lock, whenever it began.

Never a lock marked **"חסימה קבועה"** (`block_permanent`), whatever the mode. And an item
that tracks stock and has none (on hand ≤ 0 in the shop) is kept closed — reopening it would
only show "sold out" by stock instead — unless `autoReopenIgnoreStock` is on.

**What a Z reopens.** Only locks inside what it closes: the shop's, a point of sale's (area)
and a till's own levels of product availability (`product_availability`) and of category
activity (`category_availability`). The company level and the product's / category's own
flag are catalog decisions across shops; no Z touches them. Each lock is judged by the
setting in force at its own level: a shop lock by the shop's settings, an area lock by the
area's, a till's lock by the till's.

**Which Z closes a scope's day** — the Z after which no till of the scope is still in its
day:

* a till: any Z that includes it — its own Z (per-till / independent / the kiosk's
  automatic Z) or the shop Z that takes its shifts;
* a point of sale, and the shop: a Z that includes some of their tills, once **every other**
  till of theirs has nothing left in the day — no shift opened before this Z's close that no
  Z has taken yet. In a shop Z shop that is the shop Z itself; in a shop where every till
  makes its own Z, the last one to close; a kiosk still selling after the shop Z holds the
  shop's locks until its own Z. A shift opened more than 48 hours before is not counted (a
  till that died with its shift open does not hold its shop's day for ever). The day ends
  at the latest of the Zs it waited for.

Only locks that began before the day ended are reopened: a Z uploaded late (closed with no
connection) never opens a lock set after it.

**Idempotent.** One `AvailabilityDayClose` per (Z, level, target), unique: a Z applied again
— a retried upload, a second hook — finds its row and does nothing; and an opened lock is
no lock any more. Every item looked at is logged (`AvailabilityReopen`: which item, which
Z, reopened or kept for stock).

The tills hear of it as of any availability change (a catalog signal, after the commit).
A Z closed at a till with no connection reopens the till's own locks there and then (the
till's `AvailabilityAfterZ`); the cloud does the same here when that Z arrives, and the
next pull is the cloud's word.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.availability_reopen import AvailabilityDayClose, AvailabilityReopen
from app.models.category import Category
from app.models.category_availability_override import CategoryAvailabilityOverride
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.product_availability_override import AreaProductOverride, MachineProductOverride
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_product_override import ShopProductOverride
from app.models.stock_level import StockLevel
from app.models.tenant import Tenant
from app.models.z_report import ZReport
from app.services import category_availability
from app.services import product_availability as availability
from app.services.settings_merge import merge_all_settings_layers

logger = logging.getLogger(__name__)

OFF, DAY, ALL = "off", "day", "all"
MODES = (OFF, DAY, ALL)

SETTING_MODE = "autoReopenAfterZ"
SETTING_IGNORE_STOCK = "autoReopenIgnoreStock"

SHOP, AREA, MACHINE = "shop", "area", "machine"
PRODUCT, CATEGORY = "product", "category"
REOPENED, KEPT_STOCK = "reopened", "kept_stock"

#: A shift opened this long before a Z no longer holds its scope's day open.
STALE_SHIFT = timedelta(hours=48)
#: "During the day" for a scope with no earlier close on record.
FIRST_DAY = timedelta(hours=24)

#: `reason` on the catalog signal the tills get.
NOTIFY_REASON = "availability_reopened"


# ── The setting ──────────────────────────────────────────────────────────────


def mode_of(settings) -> str:
    value = (settings or {}).get(SETTING_MODE)
    return value if value in MODES else OFF


def ignores_stock(settings) -> bool:
    return (settings or {}).get(SETTING_IGNORE_STOCK) is True


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@dataclass
class _Scope:
    level: str
    target_id: uuid.UUID
    settings: dict
    #: The active tills a change here reaches (whom to wake).
    members: List[POSMachine]
    #: When the scope's day ended.
    end: datetime


class _Layers:
    """Tenant, company, shop and the shop's areas, read once per Z."""

    def __init__(self, db: Session, shop: Shop):
        self.shop = shop
        company = db.query(Company).filter(Company.id == shop.company_id).first() if shop.company_id else None
        self.company = company if company is not None else SimpleNamespace(settings={})
        self.tenant = db.query(Tenant).filter(Tenant.id == shop.tenant_id).first() if shop.tenant_id else None
        self.areas: Dict[uuid.UUID, ShopArea] = {
            a.id: a for a in db.query(ShopArea).filter(ShopArea.shop_id == shop.id).all()
        }

    def settings(self, area_id=None, machine=None) -> dict:
        area = self.areas.get(area_id) if area_id is not None else None
        return merge_all_settings_layers(self.company, self.shop, self.tenant, machine, area)


# ── When a scope's day ends ──────────────────────────────────────────────────


def day_end(db: Session, shop_id, others: Sequence[POSMachine], closed_at: datetime) -> Optional[datetime]:
    """
    When the day of a scope ends with a Z closed at `closed_at` that includes some of its
    tills — None while any of its `others` still has a shift of the day no Z has taken.
    """
    if not others:
        return closed_at
    rows = (
        db.query(Shift.z_report_id)
        .filter(
            Shift.machine_id.in_([m.id for m in others]),
            Shift.shop_id == shop_id,
            Shift.opened_at <= closed_at,
            Shift.opened_at >= closed_at - STALE_SHIFT,
        )
        .all()
    )
    if any(r.z_report_id is None for r in rows):
        return None
    taken = {r.z_report_id for r in rows}
    if not taken:
        return closed_at
    latest = _utc(db.query(func.max(ZReport.closed_at)).filter(ZReport.id.in_(taken)).scalar())
    return max(closed_at, latest) if latest is not None else closed_at


def _day_start(db: Session, z: ZReport, scope: _Scope) -> datetime:
    """The previous close of the same scope, or 24 hours before this one."""
    previous = (
        db.query(func.max(AvailabilityDayClose.closed_at))
        .filter(
            AvailabilityDayClose.level == scope.level,
            AvailabilityDayClose.target_id == scope.target_id,
            AvailabilityDayClose.z_report_id != z.id,
            AvailabilityDayClose.closed_at < scope.end,
        )
        .scalar()
    )
    return _utc(previous) if previous is not None else scope.end - FIRST_DAY


def scopes_of(db: Session, z: ZReport, tills: Sequence[POSMachine], layers: _Layers) -> List[_Scope]:
    """Every scope whose day this Z closes: its tills, their areas and the shop, as due."""
    shop = layers.shop
    closed_at = _utc(z.closed_at) or datetime.now(timezone.utc)
    shop_tills = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop.id, POSMachine.is_active.is_(True))
        .all()
    )
    mine = [m for m in tills if m is not None and str(m.shop_id) == str(shop.id)]
    mine_ids = {m.id for m in mine}
    out: List[_Scope] = []
    # A scope whose setting is off is left out before anything else is read: with the
    # setting off everywhere (the default) a Z costs only the settings it reads.
    for m in mine:
        settings = layers.settings(m.area_id, m)
        if mode_of(settings) != OFF:
            out.append(_Scope(MACHINE, m.id, settings, [m], closed_at))
    for area_id in dict.fromkeys(m.area_id for m in mine if m.area_id is not None):
        settings = layers.settings(area_id)
        if mode_of(settings) == OFF:
            continue
        members = [m for m in shop_tills if m.area_id == area_id]
        end = day_end(db, shop.id, [m for m in members if m.id not in mine_ids], closed_at)
        if end is not None:
            out.append(_Scope(AREA, area_id, settings, members, end))
    settings = layers.settings()
    if mine and mode_of(settings) != OFF:
        end = day_end(db, shop.id, [m for m in shop_tills if m.id not in mine_ids], closed_at)
        if end is not None:
            out.append(_Scope(SHOP, shop.id, settings, shop_tills, end))
    return out


# ── The locks of a scope ─────────────────────────────────────────────────────


def _due(row, mode: str, start: Optional[datetime], end: datetime) -> bool:
    """A temporary lock that began before the day ended — and during it, for "day"."""
    if getattr(row, "block_permanent", False):
        return False
    began = _utc(getattr(row, "blocked_at", None))
    if began is not None and began > end:
        return False
    if mode == DAY:
        return began is not None and start is not None and began > start
    return True


def _product_locks(db: Session, scope: _Scope) -> List[Tuple[object, uuid.UUID]]:
    """`(row, product id)` of every product lock at this scope's own level."""
    if scope.level == SHOP:
        rows = db.query(ShopProductOverride).filter(
            ShopProductOverride.shop_id == scope.target_id, ShopProductOverride.is_available.is_(False)
        ).all()
        return [(r, r.global_product_id) for r in rows]
    if scope.level == AREA:
        rows = db.query(AreaProductOverride).filter(
            AreaProductOverride.area_id == scope.target_id, AreaProductOverride.is_available.is_(False)
        ).all()
    else:
        rows = db.query(MachineProductOverride).filter(
            MachineProductOverride.machine_id == scope.target_id,
            MachineProductOverride.is_available.is_(False),
        ).all()
    return [(r, r.product_id) for r in rows]


def _category_locks(db: Session, scope: _Scope) -> List[CategoryAvailabilityOverride]:
    return db.query(CategoryAvailabilityOverride).filter(
        CategoryAvailabilityOverride.level == scope.level,
        CategoryAvailabilityOverride.target_id == scope.target_id,
        CategoryAvailabilityOverride.is_active.is_(False),
    ).all()


def _out_of_stock(db: Session, shop_id, product: Optional[Product], scope: Optional["_Scope"] = None) -> bool:
    """
    Tracks stock and has none where the scope sells from (no row is none): a point of sale or a till
    — the location its sales take from; the shop — its managed locations together, with the
    company's store when stock is held there too.
    """
    from sqlalchemy import and_, or_

    from app.services import stock as stock_service
    from app.services import stock_locations as L

    if product is None or not getattr(product, "track_stock", False):
        return False
    try:
        path = L.path_of(db, scope.level, scope.target_id) if scope is not None else L.path_of(db, SHOP, shop_id)
    except LookupError:
        path = None
    if path is None:
        qty = (
            db.query(func.sum(StockLevel.quantity))
            .filter(StockLevel.shop_id == shop_id, StockLevel.product_id == product.id)
            .scalar()
        )
        return Decimal(str(qty if qty is not None else 0)) <= 0
    managed = L.managed_for(db, path, product)
    if path.node_level != SHOP:
        return stock_service.quantity_at(db, L.sell_from(path, managed), product.id) <= 0
    places = [and_(StockLevel.shop_id == path.shop_id, StockLevel.level.in_(list(managed)))]
    if "company" in managed and path.company_id is not None:
        places.append(and_(StockLevel.level == "company", StockLevel.target_id == path.company_id))
    qty = db.query(func.sum(StockLevel.quantity)).filter(StockLevel.product_id == product.id, or_(*places)).scalar()
    return Decimal(str(qty if qty is not None else 0)) <= 0


def _open_product(db: Session, scope: _Scope, row, product_id) -> None:
    """Back to inherit, through the one write path (it also clears the lock's marks)."""
    if scope.level == SHOP:
        availability.set_shop_availability(row, None)
    elif scope.level == AREA:
        availability.set_area_availability(db, scope.target_id, product_id, None)
    else:
        availability.set_machine_availability(db, scope.target_id, product_id, None)


def _apply(db: Session, z: ZReport, scope: _Scope, shop_id) -> Optional[AvailabilityDayClose]:
    mode = mode_of(scope.settings)
    if mode == OFF:
        return None
    exists = (
        db.query(AvailabilityDayClose.id)
        .filter(
            AvailabilityDayClose.z_report_id == z.id,
            AvailabilityDayClose.level == scope.level,
            AvailabilityDayClose.target_id == scope.target_id,
        )
        .first()
    )
    if exists is not None:
        return None
    ignore_stock = ignores_stock(scope.settings)
    start = _day_start(db, z, scope) if mode == DAY else None
    day = AvailabilityDayClose(
        id=uuid.uuid4(),
        tenant_id=z.tenant_id,
        shop_id=shop_id,
        z_report_id=z.id,
        level=scope.level,
        target_id=scope.target_id,
        closed_at=scope.end,
        mode=mode,
        ignore_stock=ignore_stock,
    )
    db.add(day)
    db.flush()

    reopened = kept = 0
    products = [(r, pid) for r, pid in _product_locks(db, scope) if _due(r, mode, start, scope.end)]
    by_id = {
        str(p.id): p
        for p in (
            db.query(Product).filter(Product.id.in_([pid for _r, pid in products])).all() if products else []
        )
    }
    for row, product_id in products:
        product = by_id.get(str(product_id))
        if not ignore_stock and _out_of_stock(db, shop_id, product, scope):
            outcome = KEPT_STOCK
            kept += 1
        else:
            outcome = REOPENED
            reopened += 1
        db.add(AvailabilityReopen(
            id=uuid.uuid4(), day_close_id=day.id, kind=PRODUCT, item_id=product_id,
            item_name=getattr(product, "name", None), outcome=outcome, blocked_at=row.blocked_at,
        ))
        if outcome == REOPENED:
            _open_product(db, scope, row, product_id)

    categories = [r for r in _category_locks(db, scope) if _due(r, mode, start, scope.end)]
    names = {
        str(c.id): c.name
        for c in (
            db.query(Category).filter(Category.id.in_([r.category_id for r in categories])).all()
            if categories else []
        )
    }
    for row in categories:
        db.add(AvailabilityReopen(
            id=uuid.uuid4(), day_close_id=day.id, kind=CATEGORY, item_id=row.category_id,
            item_name=names.get(str(row.category_id)), outcome=REOPENED, blocked_at=row.blocked_at,
        ))
        category_availability.set_override(db, scope.level, scope.target_id, row.category_id, None)
        reopened += 1

    day.reopened_count = reopened
    day.kept_count = kept
    db.flush()
    if reopened:
        _wake_after_commit(db, scope.members)
    return day


def reopen_for_z(db: Session, z: ZReport, tills: Sequence[POSMachine]) -> List[AvailabilityDayClose]:
    """
    Apply the setting for every scope whose day `z` closes. `tills`: the tills the Z
    includes. The caller owns the transaction; the tills are woken after its commit.
    """
    if z is None or z.shop_id is None:
        return []
    shop = db.query(Shop).filter(Shop.id == z.shop_id).first()
    if shop is None:
        return []
    layers = _Layers(db, shop)
    out = []
    for scope in scopes_of(db, z, tills, layers):
        day = _apply(db, z, scope, shop.id)
        if day is not None:
            out.append(day)
    return out


def after_z(db: Session, z: ZReport, tills: Iterable[POSMachine]) -> List[AvailabilityDayClose]:
    """
    The hook a Z calls once it is recorded (the cloud's builder, the main till's local shop
    Z). In its own savepoint and never raising: reopening items must never cost a Z.
    """
    try:
        with db.begin_nested():
            return reopen_for_z(db, z, list(tills or []))
    except Exception:  # pragma: no cover - logged, the Z goes on
        logger.exception("availability reopen after Z %s failed", getattr(z, "id", None))
        return []


# ── Waking the tills, after the commit ───────────────────────────────────────


def _wake_after_commit(db: Session, machines: Iterable[POSMachine]) -> None:
    from app.services.commit_signals import catalog_signal_after_commit

    catalog_signal_after_commit(
        db,
        [(str(m.tenant_id), str(m.id)) for m in machines if m is not None and m.tenant_id],
        NOTIFY_REASON,
    )


# ── The log, for the dashboard ───────────────────────────────────────────────


def recent(db: Session, shop_ids: Sequence, limit: int = 50) -> List[AvailabilityDayClose]:
    """The latest closes that reopened (or kept) something, newest first."""
    if not shop_ids:
        return []
    return (
        db.query(AvailabilityDayClose)
        .filter(
            AvailabilityDayClose.shop_id.in_(list(shop_ids)),
            (AvailabilityDayClose.reopened_count + AvailabilityDayClose.kept_count) > 0,
        )
        .order_by(AvailabilityDayClose.closed_at.desc())
        .limit(limit)
        .all()
    )
