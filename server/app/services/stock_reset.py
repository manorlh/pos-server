"""
"מלאי פתיחה ואיפוס יומי" — each stock location's products start the business day at their opening
quantity.

* **The setting** — per product per stock location (`stock_levels.opening_quantity`, `daily_reset`,
  `reset_mode`): "set" ("קבע למלאי פתיחה", the default) sets the quantity to the opening one;
  "top_up" ("השלם ממחסן") tops it up by a transfer from the nearest managed location above that has
  stock — what it cannot give is the shortfall, and the location's low / out alert says so.
* **When** — at the start of the business day: the system's one day start (04:00, as insights)
  in the shop's zone (Asia/Jerusalem unless the tenant says otherwise), DST-safe. A server-side
  pass (`run_due`, every minute) runs each location once per business day: `stock_resets.run_key`
  ("<level>:<id>:<day>") is unique, so two passes (two API processes) never both run it. Switching
  daily reset on writes the current day's key without moving anything, so it starts tomorrow.
  "בצע איפוס עכשיו" runs at once, any time (its own key).
* **What it records** — one `daily_reset` movement per product (or the transfer's two legs), audited
  as the system (or the user of a manual run), and one `stock_reset_items` row with what was left
  ("נשאר בסוף היום" — the leftover report), what it was set to, and any shortfall.
* **Blocks** — stock back above 0 clears the location's automatic "אזל" by itself (the crossing);
  a manual run also ends the location's blocks set "עד סוף היום" (a scheduled run is their end
  anyway).
* **Late sales** — a sale that happened before the reset but reached the cloud after it (a till
  that was offline) belongs to the day the reset closed: `absorb_late` puts it back with a
  compensating `daily_reset` movement and lowers that day's leftover. A sale after the reset time
  applies after the reset, as any other.
* **The tills** — every till under the location pulls its stock after the commit (the catalog
  signal); each level row carries `last_reset_at`, and a till counts only its unsynced sales after it.
"""
from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.product import Product
from app.models.stock_level import StockLevel
from app.models.stock_movement import StockMovement, StockMovementReason
from app.models.stock_setting import StockReset, StockResetItem
from app.services import block_durations
from app.services import stock_locations as L
from app.services.stock_locations import Location

logger = logging.getLogger(__name__)

MODES = ("set", "top_up")
NOTIFY_REASON = "stock_reset"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _dec(value: Any) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal("0")


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


# ── The business day ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Clock:
    zone_name: str
    day_start: str


def business_day(now: datetime, clock: Clock) -> Tuple[date, datetime]:
    """(the business day `now` is in, when it started — UTC). DST-safe."""
    zone = block_durations.zone_of(clock.zone_name)
    start_t = block_durations.parse_hhmm(clock.day_start) or block_durations.parse_hhmm(block_durations.business_day_start())
    local = _aware(now).astimezone(zone)
    today_start = block_durations._local_at(local.date(), start_t, zone)
    if _aware(now) >= today_start:
        return local.date(), today_start
    yesterday = local.date() - timedelta(days=1)
    return yesterday, block_durations._local_at(yesterday, start_t, zone)


def clock_for(db: Session, loc: Location) -> Clock:
    """The location's report zone and the system's one business-day start (04:00, as insights)."""
    from app.models.company import Company
    from app.models.shop import Shop
    from app.services.reports import resolve_report_timezone

    day_start = block_durations.business_day_start()
    try:
        path = L.location_path(db, loc)
    except LookupError:
        return Clock(block_durations.DEFAULT_ZONE, day_start)
    shop = db.get(Shop, path.shop_id) if path.shop_id else None
    company = db.get(Company, path.company_id) if path.company_id else None
    tenant_id = shop.tenant_id if shop is not None else (company.tenant_id if company is not None else None)
    zone = resolve_report_timezone(db, tenant_id, None) if tenant_id else block_durations.DEFAULT_ZONE
    return Clock(zone, day_start)


def run_key(loc: Location, day: date, manual_at: Optional[datetime] = None) -> str:
    """One reset per location per business day — the scheduled one or "בצע איפוס עכשיו", never both
    (a second would wipe the first's leftover). `manual_at` is ignored (kept for old callers)."""
    return f"{loc.level}:{loc.target_id}:{day.isoformat()}"


# ── The run ──────────────────────────────────────────────────────────────────


def _rows(db: Session, loc: Location) -> List[StockLevel]:
    """The location's rows that reset, locked (`FOR UPDATE`) and read fresh: a sale arriving during
    the reset waits for it, then lands on the opening stock (or into the closed day, if older)."""
    db.flush()
    return (
        db.query(StockLevel)
        .filter(
            StockLevel.level == loc.level,
            StockLevel.target_id == loc.target_id,
            StockLevel.daily_reset.is_(True),
            StockLevel.opening_quantity.isnot(None),
        )
        .order_by(StockLevel.product_id)
        .with_for_update()
        .populate_existing()
        .all()
    )


def mark_started(db: Session, loc: Location, tenant_id: Any, *, now: Optional[datetime] = None) -> None:
    """Daily reset switched on: the current business day counts as done (it starts tomorrow)."""
    now = now or utc_now()
    day, _start = business_day(now, clock_for(db, loc))
    key = run_key(loc, day)
    if db.query(StockReset.id).filter(StockReset.run_key == key).first() is not None:
        return
    path = _safe_path(db, loc)
    db.add(StockReset(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=path.company_id, shop_id=path.shop_id,
        level=loc.level, target_id=loc.target_id, business_day=day, run_key=key, trigger="enabled",
        run_at=now, items=0,
    ))
    db.flush()


def _safe_path(db: Session, loc: Location) -> L.Path:
    try:
        return L.location_path(db, loc)
    except LookupError:
        return L.Path()


def run(
    db: Session,
    loc: Location,
    *,
    tenant_id: Any,
    trigger: str = "schedule",
    user: Any = None,
    now: Optional[datetime] = None,
) -> Optional[StockReset]:
    """
    Reset one location now (the caller commits). None when this business day's scheduled run (or,
    manual, this very moment's) already happened.
    """
    from app.services import stock as stock_service

    now = now or utc_now()
    clock = clock_for(db, loc)
    day, _start = business_day(now, clock)
    key = run_key(loc, day)
    if trigger == "manual":
        # Switching the daily reset on marks today as done (it starts tomorrow): a manual run the
        # same day replaces that marker, never a real run.
        db.query(StockReset).filter(StockReset.run_key == key, StockReset.trigger == "enabled").delete(synchronize_session=False)
    path = _safe_path(db, loc)
    reset = StockReset(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=path.company_id, shop_id=path.shop_id,
        level=loc.level, target_id=loc.target_id, business_day=day, run_key=key, trigger=trigger,
        user_id=getattr(user, "id", None),
        user_name=(getattr(user, "username", None) or getattr(user, "email", None)) if user is not None else "איפוס יומי",
        run_at=now, items=0,
    )
    savepoint = db.begin_nested()
    try:
        db.add(reset)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
        return None
    savepoint.commit()
    who = getattr(user, "id", None)
    items = 0
    rows = _rows(db, loc)
    book = L.rulebook_for_path(db, path)
    for row in rows:
        product = db.get(Product, row.product_id)
        before = _dec(row.quantity)
        opening = _dec(row.opening_quantity)
        mode = row.reset_mode if row.reset_mode in MODES else "set"
        item = StockResetItem(
            id=uuid.uuid4(), reset_id=reset.id, product_id=row.product_id,
            product_name=product.name if product is not None else None, mode=mode,
            before_quantity=before, opening_quantity=opening, delta=Decimal("0"),
        )
        if mode == "set":
            delta = opening - before
            if delta != 0:
                mid = uuid.uuid4()
                stock_service.apply_movement(
                    db, movement_id=mid, tenant_id=row.tenant_id, shop_id=row.shop_id, location=loc,
                    product_id=row.product_id, delta=delta, reason=StockMovementReason.DAILY_RESET,
                    occurred_at=now, created_by_user_id=who, note="איפוס יומי",
                )
                item.movement_id = mid
            item.delta = delta
        else:
            need = max(opening - before, Decimal("0"))
            taken = Decimal("0")
            if need > 0:
                managed = book.managed(company_id=path.company_id, shop_id=path.shop_id, product=product)
                for parent in L.parents_managed(path, managed):
                    # The store's row locked too: a sale there meanwhile cannot make it give twice.
                    held = stock_service.lock_level(db, parent, row.product_id)
                    have = _dec(held.quantity) if held is not None else Decimal("0")
                    if have <= 0:
                        continue
                    take = min(need - taken, have)
                    stock_service.transfer(
                        db, tenant_id=row.tenant_id, product_id=row.product_id, quantity=take, source=parent,
                        target=loc, created_by_user_id=who, note="איפוס יומי — השלמה ממחסן", occurred_at=now,
                    )
                    item.from_level, item.from_target_id = parent.level, parent.target_id
                    taken += take
                    if taken >= need:
                        break
            item.delta = taken
            item.shortfall = need - taken if need > taken else Decimal("0")
        row.last_reset_at = now
        row.updated_at = now
        db.add(item)
        items += 1
    reset.items = items
    db.flush()
    if trigger == "manual":
        reset_ids = [r[0] for r in db.query(StockResetItem.product_id).filter(StockResetItem.reset_id == reset.id).all()]
        _end_day_blocks(db, loc, now, reset_ids)
    stock_service._wake_on_crossing(db, loc, None)
    return reset


def _end_day_blocks(db: Session, loc: Location, now: datetime, product_ids: Sequence[Any]) -> None:
    """
    A manual run ends, for the products it reset, the location's "אזל" set "עד סוף היום" (the day it
    stood for is over for them); a "חסום" — a reason, not a count — stays until its own end.
    """
    from app.models.sold_out import SoldOutMark
    from app.services import sold_out

    if not product_ids or not sold_out.tables_ready(db):
        return
    rows = (
        db.query(SoldOutMark)
        .filter(
            SoldOutMark.scope == loc.level, SoldOutMark.scope_id == loc.target_id,
            SoldOutMark.product_id.in_(list(product_ids)), SoldOutMark.kind == "sold_out",
            SoldOutMark.until_mode == "end_of_day", sold_out.in_force_filter(now),
        )
        .all()
    )
    for row in rows:
        sold_out.clear(db, row, by_name="איפוס יומי", now=now)


def absorb_late(db: Session, level: StockLevel, movement_id: Any, delta: Decimal, occurred_at: datetime) -> bool:
    """
    A sale (or refund) that happened before the location's last reset but reached the cloud after
    it: undone for today by a compensating `daily_reset` movement, and taken off that day's leftover.
    True when absorbed (the caller's level already moved by `delta`; this moves it back).
    """
    reset_at = _aware(level.last_reset_at)
    when = _aware(occurred_at)
    if reset_at is None or when is None or when >= reset_at:
        return False
    reset = (
        db.query(StockReset)
        .filter(
            StockReset.level == level.level, StockReset.target_id == level.target_id,
            StockReset.run_at > when, StockReset.trigger != "enabled",
        )
        .order_by(StockReset.run_at)
        .first()
    )
    if reset is None:
        return False
    item = (
        db.query(StockResetItem)
        .filter(StockResetItem.reset_id == reset.id, StockResetItem.product_id == level.product_id)
        .first()
    )
    if item is None or item.mode != "set":
        return False
    from sqlalchemy.dialects.postgresql import insert as pg_insert_default

    from app.services import stock as stock_service

    insert = getattr(stock_service, "pg_insert", pg_insert_default)
    db.execute(
        insert(StockMovement).values(
            id=uuid.uuid4(), tenant_id=level.tenant_id, company_id=level.company_id, shop_id=level.shop_id,
            level=level.level, target_id=level.target_id, product_id=level.product_id, delta=-delta,
            reason=StockMovementReason.DAILY_RESET, occurred_at=utc_now(), created_at=utc_now(),
            note=f"איפוס יומי — מכירה מאוחרת של {reset.business_day.isoformat()}",
        )
    )
    # The row is the caller's, locked by its own write (stock.add_to_level): read fresh, then undone.
    locked = (
        db.query(StockLevel).filter(StockLevel.id == level.id).with_for_update().populate_existing().one()
    )
    locked.quantity = _dec(locked.quantity) - delta
    item.before_quantity = _dec(item.before_quantity) + delta
    item.delta = _dec(item.delta) - delta
    db.flush()
    return True


# ── The scheduled pass ───────────────────────────────────────────────────────


def due_locations(db: Session) -> List[Tuple[Location, Any]]:
    rows = (
        db.query(StockLevel.level, StockLevel.target_id, StockLevel.tenant_id)
        .filter(StockLevel.daily_reset.is_(True), StockLevel.opening_quantity.isnot(None))
        .distinct()
        .all()
    )
    return [(Location(r[0], r[1]), r[2]) for r in rows]


def run_due(db: Session, *, now: Optional[datetime] = None) -> int:
    """Every location whose business day began and has not been reset: reset it. Commits each."""
    now = now or utc_now()
    done = 0
    for loc, tenant_id in due_locations(db):
        try:
            day, start = business_day(now, clock_for(db, loc))
            if now < start:
                continue
            if db.query(StockReset.id).filter(StockReset.run_key == run_key(loc, day)).first() is not None:
                continue
            if run(db, loc, tenant_id=tenant_id, trigger="schedule", now=now) is not None:
                db.commit()
                done += 1
            else:
                db.rollback()
        except Exception:  # noqa: BLE001 - one location never stops the others
            db.rollback()
            logger.exception("daily stock reset failed for %s", loc.key)
    return done


_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def start_background_worker(session_factory: Callable[[], Session], *, interval: float = 60.0) -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return

    def loop() -> None:
        while not _stop.wait(interval):
            if L.locations_enabled():
                db = session_factory()
                try:
                    run_due(db)
                except Exception:  # noqa: BLE001 - keep the loop alive
                    logger.exception("daily stock reset pass failed")
                finally:
                    db.close()
            # "יעד הושג" is the sales targets' own job now (app/services/sales_targets_worker.py),
            # independent of stock: switching stock off never silences a target alert.

    _stop.clear()
    _thread = threading.Thread(target=loop, name="stock-daily-reset", daemon=True)
    _thread.start()


# ── Reports ──────────────────────────────────────────────────────────────────


def history(db: Session, *, shop_ids: Sequence[Any], company_ids: Sequence[Any] = (), limit: int = 100) -> List[Dict[str, Any]]:
    q = db.query(StockReset).filter(StockReset.trigger != "enabled")
    from sqlalchemy import or_

    places = [StockReset.shop_id.in_(list(shop_ids))] if shop_ids else []
    if company_ids:
        places.append(and_(StockReset.level == "company", StockReset.company_id.in_(list(company_ids))))
    if not places:
        return []
    rows = q.filter(or_(*places)).order_by(StockReset.run_at.desc()).limit(limit).all()
    names: Dict[str, Optional[str]] = {}
    out = []
    for r in rows:
        loc = Location(r.level, r.target_id)
        if loc.key not in names:
            names[loc.key] = L.location_name(db, loc)
        out.append({
            "id": str(r.id), "businessDay": r.business_day.isoformat(), "trigger": r.trigger,
            "by": r.user_name, "runAt": _aware(r.run_at).isoformat(), "items": r.items,
            "location": {**loc.out(), "name": names[loc.key], "levelLabel": L.LEVEL_LABELS.get(r.level, r.level)},
        })
    return out


def leftover(db: Session, *, shop_ids: Sequence[Any], company_ids: Sequence[Any] = (), day: Optional[date] = None) -> List[Dict[str, Any]]:
    """"נשאר בסוף היום": what each reset found, per product and location (late sales counted in)."""
    from sqlalchemy import or_

    places = [StockReset.shop_id.in_(list(shop_ids))] if shop_ids else []
    if company_ids:
        places.append(and_(StockReset.level == "company", StockReset.company_id.in_(list(company_ids))))
    if not places:
        return []
    q = (
        db.query(StockResetItem, StockReset)
        .join(StockReset, StockReset.id == StockResetItem.reset_id)
        .filter(or_(*places), StockReset.trigger != "enabled")
    )
    if day is not None:
        q = q.filter(StockReset.business_day == day)
    names: Dict[str, Optional[str]] = {}
    out = []
    for item, reset in q.order_by(StockReset.run_at.desc(), StockResetItem.product_name).limit(2000).all():
        loc = Location(reset.level, reset.target_id)
        if loc.key not in names:
            names[loc.key] = L.location_name(db, loc)
        out.append({
            "resetId": str(reset.id),
            "businessDay": reset.business_day.isoformat(),
            "closedDay": (reset.business_day - timedelta(days=1)).isoformat() if reset.trigger == "schedule" else reset.business_day.isoformat(),
            "runAt": _aware(reset.run_at).isoformat(),
            "trigger": reset.trigger,
            "location": {**loc.out(), "name": names[loc.key]},
            "productId": str(item.product_id),
            "productName": item.product_name,
            "leftover": float(item.before_quantity),
            "opening": float(item.opening_quantity),
            "mode": item.mode,
            "delta": float(item.delta),
            "shortfall": float(item.shortfall) if item.shortfall is not None else None,
        })
    return out
