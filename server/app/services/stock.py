"""
Inventory: a movement ledger and materialized levels, per **stock location** along the hierarchy
(company → shop → area → group → machine; app/services/stock_locations.py).

* **Movements.** Every change is an append-only movement (`stock_movements`, idempotent by id) at
  one location, with the user or till and a reason; a transfer is two movements sharing
  `transfer_id`. The level row of the location is the running sum.
* **Sales.** A till's sale (and refund) moves the lowest managed location that contains the till
  (`sale_location`), by the product's managed levels ("אופן ניהול מלאי").
* **Crossing.** A tracked product whose stock at a location crosses 0 wakes the tills under it
  after the commit and sets / clears the automatic "אזל" for the devices that sell from it
  (app/services/sold_out.py); crossing its reorder minimum (or 0) raises / clears a low-stock alert.
* **What a till pulls** (`levels_for_machine`): one level per product — the location it sells from —
  so its own table stays keyed by product and "on hand" means its own location.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
import uuid

from sqlalchemy import and_, func, or_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session, joinedload

from app.models.product import Product
from app.models.shop import Shop
from app.models.stock_level import StockLevel
from app.models.stock_movement import StockMovement, StockMovementReason
from app.services import stock_locations as L
from app.services.stock_locations import Location, Path

logger = logging.getLogger(__name__)


def _side_effect(db: Session, what: str, fn, default: Any = None) -> Any:
    """
    A stock side effect — a late sale into its day's leftover, the automatic "אזל", a low-stock
    alert — in its own savepoint: it never fails the document (a sale, a refund) that moved the stock.
    """
    try:
        with db.begin_nested():
            return fn()
    except Exception:  # noqa: BLE001 - logged; the movement itself stands
        logger.exception("stock: %s failed", what)
        return default


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _dec(value: Any) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal("0")


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _resolve_global_product_id(db: Session, product_id: uuid.UUID) -> Optional[uuid.UUID]:
    """Stock is keyed by global product id; map machine-local rows when needed."""
    p = db.query(Product).filter(Product.id == product_id).first()
    if not p:
        return None
    if p.global_product_id:
        return p.global_product_id
    return p.id


def level_at(db: Session, loc: Location, product_id: Any) -> Optional[StockLevel]:
    return (
        db.query(StockLevel)
        .filter(StockLevel.level == loc.level, StockLevel.target_id == loc.target_id, StockLevel.product_id == product_id)
        .first()
    )


def add_to_level(
    db: Session,
    *,
    tenant_id: Any,
    company_id: Any,
    shop_id: Any,
    loc: Location,
    product_id: Any,
    delta: Decimal,
) -> Tuple[StockLevel, Decimal]:
    """
    The location's quantity moved by `delta` in ONE statement — `INSERT … ON CONFLICT (level,
    target_id, product_id) DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity
    RETURNING …` — so two documents moving the same product at once never lose an update, and two
    tills making the first sale at a fresh location never collide on the insert (the second waits
    and adds). The row stays locked until the caller's commit. Returns the row (reloaded) and its
    quantity after.
    """
    db.flush()  # nothing pending on that row may be overwritten by the reload below
    now = utc_now()
    ins = pg_insert(StockLevel).values(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=company_id, shop_id=shop_id, level=loc.level,
        target_id=loc.target_id, product_id=product_id, quantity=delta, updated_at=now,
    )
    stmt = ins.on_conflict_do_update(
        index_elements=[StockLevel.level, StockLevel.target_id, StockLevel.product_id],
        set_={"quantity": StockLevel.__table__.c.quantity + ins.excluded.quantity, "updated_at": ins.excluded.updated_at},
    ).returning(StockLevel.__table__.c.id, StockLevel.__table__.c.quantity)
    row_id, after = db.execute(stmt).one()
    level = db.get(StockLevel, row_id, populate_existing=True)
    return level, _dec(after)


def lock_level(db: Session, loc: Location, product_id: Any) -> Optional[StockLevel]:
    """The location's row, locked (`FOR UPDATE`) and read fresh: set-to and resets compute from it."""
    db.flush()
    return (
        db.query(StockLevel)
        .filter(StockLevel.level == loc.level, StockLevel.target_id == loc.target_id, StockLevel.product_id == product_id)
        .with_for_update()
        .populate_existing()
        .first()
    )


def level_of(db: Session, shop_id: Any, area_id: Any, product_id: Any) -> Optional[StockLevel]:
    """The shop's own row (`area_id` None) or one point of sale's row."""
    loc = Location("area", area_id) if area_id is not None else Location("shop", shop_id)
    return level_at(db, loc, product_id)


def quantity_at(db: Session, loc: Location, product_id: Any) -> Decimal:
    row = level_at(db, loc, product_id)
    return _dec(row.quantity) if row is not None else Decimal("0")


# ── Where a sale goes ────────────────────────────────────────────────────────


def sale_location(db: Session, machine: Any, product_id: Any, *, path: Optional[Path] = None, book: Any = None) -> Optional[Location]:
    """The location a till's sale of `product_id` moves (None when the product is unknown)."""
    global_pid = _resolve_global_product_id(db, product_id) if product_id is not None else None
    product = db.get(Product, global_pid) if global_pid is not None else None
    if product is None:
        return None
    path = path or L.path_of_machine(db, machine)
    managed = L.managed_for(db, path, product, book)
    return L.sell_from(path, managed)


# ── Applying a movement ──────────────────────────────────────────────────────


def _owners(db: Session, loc: Location) -> Tuple[Optional[uuid.UUID], Optional[uuid.UUID]]:
    """(company_id, shop_id) of a location."""
    try:
        path = L.location_path(db, loc)
    except LookupError:
        return None, None
    return path.company_id, path.shop_id


def apply_movement(
    db: Session,
    *,
    movement_id: uuid.UUID,
    tenant_id: uuid.UUID,
    shop_id: Optional[uuid.UUID],
    product_id: uuid.UUID,
    delta: Decimal,
    reason: StockMovementReason,
    occurred_at: datetime,
    transaction_id: Optional[uuid.UUID] = None,
    transaction_item_id: Optional[uuid.UUID] = None,
    machine_id: Optional[uuid.UUID] = None,
    created_by_user_id: Optional[uuid.UUID] = None,
    note: Optional[str] = None,
    location: Optional[Location] = None,
    transfer_id: Optional[uuid.UUID] = None,
) -> bool:
    """
    Insert the movement idempotently and update the level of its location (the shop's when no
    `location` is given — every caller before locations existed).
    Returns True if a new movement was applied, False if duplicate id.
    """
    global_pid = _resolve_global_product_id(db, product_id)
    if not global_pid:
        return False
    loc = location or Location("shop", shop_id)
    company_id, loc_shop_id = _owners(db, loc)
    if loc.level == "shop":
        loc_shop_id = loc.target_id

    stmt = (
        pg_insert(StockMovement)
        .values(
            id=movement_id,
            tenant_id=tenant_id,
            company_id=company_id,
            shop_id=loc_shop_id,
            level=loc.level,
            target_id=loc.target_id,
            product_id=global_pid,
            delta=delta,
            reason=reason,
            transfer_id=transfer_id,
            transaction_id=transaction_id,
            transaction_item_id=transaction_item_id,
            machine_id=machine_id,
            created_by_user_id=created_by_user_id,
            note=note,
            occurred_at=occurred_at,
            created_at=utc_now(),
        )
        .on_conflict_do_nothing(index_elements=[StockMovement.id])
    )
    result = db.execute(stmt)
    if result.rowcount == 0:
        return False

    level, after = add_to_level(
        db, tenant_id=tenant_id, company_id=company_id, shop_id=loc_shop_id, loc=loc, product_id=global_pid,
        delta=_dec(delta),
    )
    before = after - _dec(delta)
    # "איפוס יומי": a sale of a day the reset already closed (a till that was offline) belongs to
    # that day's leftover, never to today's opening stock (app/services/stock_reset.py).
    if reason in (StockMovementReason.SALE, StockMovementReason.REFUND) and level.last_reset_at is not None:
        from app.services import stock_reset

        if _side_effect(db, "late sale", lambda: stock_reset.absorb_late(db, level, movement_id, _dec(delta), occurred_at), False):
            return True
    tracked = db.query(Product.track_stock).filter(Product.id == global_pid).scalar()
    if tracked:
        if (before > 0) != (after > 0):
            _side_effect(db, "auto sold-out", lambda: _on_crossing(db, tenant_id, loc, global_pid, ran_out=after <= 0))
        from app.services import stock_alerts

        if L.locations_enabled() and L.table_ready(db, "stock_alerts"):
            _side_effect(db, "low-stock alert", lambda: stock_alerts.on_change(db, level, before, after))
    return True


#: `reason` of the catalog signal a till gets when an item it sells runs out (or is back).
STOCK_CROSSED_REASON = "stock_crossed_zero"


def tills_under(db: Session, loc: Location) -> List[Any]:
    """The active tills (and kiosks) under a location."""
    from app.models.pos_machine import POSMachine

    q = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if loc.level == "machine":
        return q.filter(POSMachine.id == loc.target_id).all()
    if loc.level == "area":
        return q.filter(POSMachine.area_id == loc.target_id).all()
    if loc.level == "shop":
        return q.filter(POSMachine.shop_id == loc.target_id).all()
    if loc.level == "company":
        return q.join(Shop, Shop.id == POSMachine.shop_id).filter(Shop.company_id == loc.target_id).all()
    group = L.group_hook(db, group_id=loc.target_id)
    ids = list((group or {}).get("machineIds") or [])
    return q.filter(POSMachine.id.in_(ids)).all() if ids else []


def _on_crossing(db: Session, tenant_id, loc: Location, product_id, *, ran_out: bool) -> None:
    _wake_on_crossing(db, loc, product_id)
    # The automatic "אזל" hook: a block for the location, reaching only the devices that sell from it.
    from app.services import sold_out

    sold_out.on_stock_crossing(
        db, tenant_id=tenant_id, scope=loc.level, scope_id=loc.target_id, product_id=product_id, ran_out=ran_out,
    )


def _wake_on_crossing(db: Session, loc: Location, product_id: uuid.UUID) -> None:
    """
    A product that tracks stock ran out at a location (or came back): every till under it — the
    kiosk included — pulls after the commit, so the item shows "אזל" there within seconds of the
    sale on another till rather than at its next periodic sync (docs/SPEC_AVAILABILITY.md).
    """
    from app.services.commit_signals import catalog_signal_after_commit

    tills = tills_under(db, loc)
    catalog_signal_after_commit(
        db, [(str(t.tenant_id), str(t.id)) for t in tills if t.tenant_id is not None], STOCK_CROSSED_REASON
    )


def _wake_shop_on_crossing(db: Session, shop_id: uuid.UUID, product_id: uuid.UUID) -> None:
    """Kept for callers of the shop-only days: wakes the shop's tills."""
    _wake_on_crossing(db, Location("shop", shop_id), product_id)


# ── Writing from the dashboard ───────────────────────────────────────────────


def set_quantity(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    shop_id: Optional[uuid.UUID],
    product_id: uuid.UUID,
    target_quantity: Decimal,
    created_by_user_id: Optional[uuid.UUID] = None,
    note: Optional[str] = None,
    location: Optional[Location] = None,
    reason: StockMovementReason = StockMovementReason.STOCKTAKE,
) -> Optional[StockLevel]:
    """Stocktake: set the absolute on-hand of one location by a movement for the difference."""
    global_pid = _resolve_global_product_id(db, product_id)
    if not global_pid:
        raise ValueError("Product not found")
    loc = location or Location("shop", shop_id)
    # Locked: a sale arriving meanwhile waits, so the count is exactly what is set.
    level = lock_level(db, loc, global_pid)
    current = _dec(level.quantity) if level else Decimal("0")
    delta = _dec(target_quantity) - current
    if delta == 0 and level:
        return level

    apply_movement(
        db,
        movement_id=uuid.uuid4(),
        tenant_id=tenant_id,
        shop_id=shop_id,
        location=loc,
        product_id=global_pid,
        delta=delta,
        reason=reason,
        occurred_at=utc_now(),
        created_by_user_id=created_by_user_id,
        note=note or f"Stocktake set to {target_quantity}",
    )
    db.flush()
    return level_at(db, loc, global_pid)


def transfer(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    product_id: uuid.UUID,
    quantity: Decimal,
    source: Location,
    target: Location,
    created_by_user_id: Optional[uuid.UUID] = None,
    note: Optional[str] = None,
    occurred_at: Optional[datetime] = None,
) -> uuid.UUID:
    """
    Move `quantity` between two locations — up, down or across: −quantity at `source`, +quantity
    at `target`, two `transfer` movements with one `transfer_id`. Raises ValueError for a
    non-positive quantity or one location.
    """
    quantity = _dec(quantity)
    if quantity <= 0:
        raise ValueError("quantity_must_be_positive")
    if source == target:
        raise ValueError("same_location")
    global_pid = _resolve_global_product_id(db, product_id)
    if not global_pid:
        raise ValueError("product_not_found")
    transfer_id = uuid.uuid4()
    when = occurred_at or utc_now()
    for loc, delta in ((source, -quantity), (target, quantity)):
        apply_movement(
            db,
            movement_id=uuid.uuid4(),
            tenant_id=tenant_id,
            shop_id=None,
            location=loc,
            product_id=global_pid,
            delta=delta,
            reason=StockMovementReason.TRANSFER,
            occurred_at=when,
            created_by_user_id=created_by_user_id,
            note=note,
            transfer_id=transfer_id,
        )
    db.flush()
    return transfer_id


def get_levels_for_shop(
    db: Session,
    shop_id: uuid.UUID,
    since: Optional[datetime] = None,
) -> List[StockLevel]:
    """The shop location's rows (the dashboard's shop stock page)."""
    q = (
        db.query(StockLevel)
        .options(joinedload(StockLevel.product))
        .filter(StockLevel.level == "shop", StockLevel.target_id == shop_id)
    )
    if since:
        q = q.filter(StockLevel.updated_at > since)
    return q.order_by(StockLevel.updated_at.desc()).all()


def effective_stock_updated_at(db: Session, shop_id: uuid.UUID, company_id: Any = None) -> datetime:
    """The newest change to any location a till of the shop may sell from (its company's included)."""
    from app.models.stock_setting import StockLevelSetting

    where = StockLevel.shop_id == shop_id
    mwhere = StockMovement.shop_id == shop_id
    if company_id is not None:
        where = or_(where, and_(StockLevel.level == "company", StockLevel.target_id == company_id))
        mwhere = or_(mwhere, and_(StockMovement.level == "company", StockMovement.target_id == company_id))
    level_max = db.query(func.max(StockLevel.updated_at)).filter(where).scalar()
    movement_max = db.query(func.max(StockMovement.created_at)).filter(mwhere).scalar()
    scopes = [shop_id] + ([company_id] if company_id is not None else [])
    setting_max = (
        db.query(func.max(StockLevelSetting.updated_at)).filter(StockLevelSetting.scope_id.in_(scopes)).scalar()
    )
    stamps = [_aware(s) for s in (level_max, movement_max, setting_max) if s is not None]
    return max(stamps) if stamps else utc_now()


@dataclass
class TillLevel:
    """One product's level as a till sells from it."""

    product_id: uuid.UUID
    product: Optional[Product]
    quantity: Decimal
    location: Location
    reorder_min: Optional[int]
    reorder_max: Optional[int]
    reorder_opt: Optional[int]
    updated_at: datetime
    reset_at: Optional[datetime] = None


def levels_for_machine(db: Session, machine: Any, since: Optional[datetime] = None) -> List[TillLevel]:
    """
    One level per tracked product of the shop: the location this till sells it from (0 until that
    location has a row). A delta returns the products whose location row changed since `since` —
    all of them when the till moved area or the managed levels changed since.
    """
    from app.models.shop_product_override import ShopProductOverride

    path = L.path_of_machine(db, machine)
    book = L.rulebook_for_path(db, path)
    moved = _aware(getattr(machine, "area_changed_at", None))
    since = _aware(since)
    if since is not None and ((moved is not None and moved > since) or (book.updated_at is not None and _aware(book.updated_at) > since)):
        since = None
    products = (
        db.query(Product)
        .join(ShopProductOverride, ShopProductOverride.global_product_id == Product.id)
        .filter(ShopProductOverride.shop_id == machine.shop_id, Product.track_stock.is_(True))
        .all()
    )
    chain = path.chain_up()
    clauses = [and_(StockLevel.level == loc.level, StockLevel.target_id == loc.target_id) for loc in chain]
    rows = (
        db.query(StockLevel).filter(or_(*clauses), StockLevel.product_id.in_([p.id for p in products])).all()
        if products and clauses else []
    )
    by_key = {(r.level, str(r.target_id), r.product_id): r for r in rows}
    out: List[TillLevel] = []
    for p in products:
        loc = L.sell_from(path, book.managed(company_id=path.company_id, shop_id=path.shop_id, product=p))
        row = by_key.get((loc.level, str(loc.target_id), p.id))
        changed = _aware(row.updated_at) if row is not None and row.updated_at else None
        if since is not None and (changed is None or changed <= since):
            continue
        out.append(TillLevel(
            product_id=p.id,
            product=p,
            quantity=_dec(row.quantity) if row is not None else Decimal("0"),
            location=loc,
            reorder_min=row.reorder_min if row is not None else None,
            reorder_max=row.reorder_max if row is not None else None,
            reorder_opt=row.reorder_opt if row is not None else None,
            updated_at=changed or utc_now(),
            # Only where a late sale is absorbed into the closed day (mode "set", as
            # stock_reset.absorb_late): there the till stops counting its older unsynced sales.
            reset_at=(
                _aware(row.last_reset_at)
                if row is not None and L.locations_enabled() and (row.reset_mode or "set") == "set"
                else None
            ),
        ))
    return out


def serialize_stock_level(level: StockLevel) -> Dict[str, Any]:
    p = level.product
    return {
        "productId": str(level.product_id),
        "productName": p.name if p else None,
        "sku": p.sku if p else None,
        "quantity": float(level.quantity),
        "reorderMin": level.reorder_min,
        "reorderMax": level.reorder_max,
        "reorderOpt": level.reorder_opt,
        "updatedAt": level.updated_at.isoformat() if level.updated_at else None,
    }


def ensure_shop_tenant(db: Session, shop_id: uuid.UUID) -> Shop:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        raise ValueError("Shop not found")
    return shop


def is_low(quantity: Any, reorder_min: Optional[int]) -> bool:
    """Low: at or under the reorder minimum when one is set, else at or under 0."""
    q = _dec(quantity)
    if reorder_min is not None:
        return q <= Decimal(reorder_min)
    return q <= 0


def movements_for(
    db: Session, product_id: Any, *, locations: Optional[Sequence[Location]] = None, shop_id: Any = None, limit: int = 40,
) -> List[Dict[str, Any]]:
    """The last movements of one product at these locations (or the shop's), newest first, with who."""
    from app.models.pos_machine import POSMachine
    from app.models.user import User

    q = db.query(StockMovement).filter(StockMovement.product_id == product_id)
    if locations:
        q = q.filter(or_(*[and_(StockMovement.level == l.level, StockMovement.target_id == l.target_id) for l in locations]))
    elif shop_id is not None:
        q = q.filter(StockMovement.shop_id == shop_id)
    rows = q.order_by(StockMovement.created_at.desc()).limit(limit).all()
    user_ids = [r.created_by_user_id for r in rows if r.created_by_user_id]
    machine_ids = [r.machine_id for r in rows if r.machine_id]
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids)).all()} if machine_ids else {}
    names: Dict[str, Optional[str]] = {}
    out = []
    for r in rows:
        loc = Location(r.level, r.target_id)
        if loc.key not in names:
            names[loc.key] = L.location_name(db, loc)
        user = users.get(r.created_by_user_id)
        machine = machines.get(r.machine_id)
        out.append({
            "id": str(r.id),
            "delta": float(r.delta),
            "reason": r.reason.value if hasattr(r.reason, "value") else r.reason,
            "location": {**loc.out(), "name": names[loc.key]},
            "transferId": str(r.transfer_id) if r.transfer_id else None,
            "by": (user.username or user.email) if user is not None else (machine.name if machine is not None else None),
            "note": r.note,
            "occurredAt": _aware(r.occurred_at).isoformat() if r.occurred_at else None,
            "createdAt": _aware(r.created_at).isoformat() if r.created_at else None,
        })
    return out
