"""
Low-stock alerts per stock location (app/models/stock_setting.py `StockAlert`).

* **Raised** when a tracked product at a location goes from above to at-or-under its threshold — its
  reorder minimum, or 0 with none ("low"), and when it reaches 0 or less ("out"). One open alert per
  location and product; an "out" replaces an open "low".
* **Cleared** when it is back above the threshold.
* **The suggestion** — "העבר מהמחסן": the nearest managed location above it that has stock, and how
  much (up to the reorder optimum / maximum, else twice the minimum, else 10 — never more than the
  source holds). Shown with a one-tap transfer on the quick stock screen and the board.
* **Who sees it** — whoever manages that location (app/services/stock_scope.py): the alert carries
  its company, shop, area and device. It is written to the exceptions log (`stock_low` /
  `stock_out`, app/services/exception_alerts) so the SMS rules can send it.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.product import Product
from app.models.stock_level import StockLevel
from app.models.stock_setting import StockAlert
from app.services import stock_locations as L
from app.services.stock_locations import Location


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _dec(value: Any) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal("0")


def threshold_of(level: StockLevel) -> Decimal:
    return Decimal(level.reorder_min) if level.reorder_min is not None else Decimal("0")


def state_of(quantity: Decimal, threshold: Decimal) -> Optional[str]:
    """None (fine), "low" or "out"."""
    if quantity <= 0:
        return "out"
    if quantity <= threshold:
        return "low"
    return None


def suggest_quantity(level: StockLevel, quantity: Decimal, available: Decimal) -> Decimal:
    target = None
    for v in (level.reorder_opt, level.reorder_max):
        if v is not None:
            target = Decimal(v)
            break
    if target is None:
        target = Decimal(level.reorder_min) * 2 if level.reorder_min else Decimal("10")
    want = max(target - quantity, Decimal("1"))
    return min(want, available) if available > 0 else Decimal("0")


def _open(db: Session, level: StockLevel) -> Optional[StockAlert]:
    return (
        db.query(StockAlert)
        .filter(
            StockAlert.level == level.level,
            StockAlert.target_id == level.target_id,
            StockAlert.product_id == level.product_id,
            StockAlert.cleared_at.is_(None),
        )
        .first()
    )


def _suggestion(db: Session, level: StockLevel, quantity: Decimal) -> tuple:
    """(level, target_id, quantity) of the nearest managed location above with stock, or Nones."""
    loc = Location(level.level, level.target_id)
    try:
        path = L.location_path(db, loc)
    except LookupError:
        return None, None, None
    product = db.get(Product, level.product_id)
    managed = L.managed_for(db, path, product)
    for parent in L.parents_managed(path, managed):
        row = (
            db.query(StockLevel)
            .filter(StockLevel.level == parent.level, StockLevel.target_id == parent.target_id, StockLevel.product_id == level.product_id)
            .first()
        )
        available = _dec(row.quantity) if row is not None else Decimal("0")
        if available > 0:
            return parent.level, parent.target_id, suggest_quantity(level, quantity, available)
    return None, None, None


def on_change(db: Session, level: StockLevel, before: Decimal, after: Decimal, *, now: Optional[datetime] = None) -> None:
    """A tracked product's level changed: raise, escalate or clear its alert. The caller commits."""
    now = now or utc_now()
    threshold = threshold_of(level)
    was, now_state = state_of(before, threshold), state_of(after, threshold)
    if was == now_state and now_state is None:
        return
    current = _open(db, level)
    if now_state is None:
        if current is not None:
            current.cleared_at = now
            current.quantity = after
            current.updated_at = now
        return
    if current is not None and current.kind == now_state:
        current.quantity = after
        current.updated_at = now
        return
    if current is not None:
        current.cleared_at = now
        current.updated_at = now
    try:
        path = L.location_path(db, Location(level.level, level.target_id))
    except LookupError:
        path = L.Path()
    s_level, s_target, s_qty = _suggestion(db, level, after)
    product = db.get(Product, level.product_id)
    db.add(StockAlert(
        id=uuid.uuid4(),
        tenant_id=level.tenant_id,
        company_id=path.company_id,
        shop_id=path.shop_id,
        area_id=path.area_id,
        machine_id=path.machine_id,
        level=level.level,
        target_id=level.target_id,
        product_id=level.product_id,
        product_name=product.name if product is not None else None,
        kind=now_state,
        quantity=after,
        threshold=threshold,
        suggest_level=s_level,
        suggest_target_id=s_target,
        suggest_quantity=s_qty,
        raised_at=now,
        created_at=now,
        updated_at=now,
    ))
    db.flush()


def reevaluate(db: Session, level: StockLevel, *, now: Optional[datetime] = None) -> None:
    """The threshold changed (not the quantity): the open alert follows the level as it is now."""
    now = now or utc_now()
    qty = _dec(level.quantity)
    threshold = threshold_of(level)
    state = state_of(qty, threshold)
    current = _open(db, level)
    if state is None:
        if current is not None:
            current.cleared_at = now
            current.updated_at = now
        return
    if current is not None and current.kind == state:
        current.threshold = threshold
        current.quantity = qty
        current.updated_at = now
        return
    # Raised (or changed kind) now: as if it had just crossed from above the threshold.
    on_change(db, level, threshold + 1, qty, now=now)


def alert_out(db: Session, a: StockAlert, names: Dict[str, Optional[str]]) -> Dict[str, Any]:
    loc = Location(a.level, a.target_id)
    suggest = None
    if a.suggest_level and a.suggest_target_id:
        src = Location(a.suggest_level, a.suggest_target_id)
        key = src.key
        if key not in names:
            names[key] = L.location_name(db, src)
        suggest = {**src.out(), "name": names[key], "quantity": float(a.suggest_quantity or 0)}
    if loc.key not in names:
        names[loc.key] = L.location_name(db, loc)
    return {
        "id": str(a.id),
        "kind": a.kind,
        "productId": str(a.product_id),
        "productName": a.product_name,
        "location": {**loc.out(), "name": names[loc.key], "levelLabel": L.LEVEL_LABELS.get(a.level, a.level)},
        "shopId": str(a.shop_id) if a.shop_id else None,
        "areaId": str(a.area_id) if a.area_id else None,
        "quantity": float(a.quantity),
        "threshold": float(a.threshold) if a.threshold is not None else None,
        "suggestTransfer": suggest,
        "raisedAt": a.raised_at.isoformat() if a.raised_at else None,
    }


def open_alerts(db: Session, tenant_id: Any, *, shop_ids: Optional[Sequence[Any]] = None, company_ids: Optional[Sequence[Any]] = None) -> List[StockAlert]:
    q = db.query(StockAlert).filter(StockAlert.tenant_id == tenant_id, StockAlert.cleared_at.is_(None))
    places = []
    if shop_ids is not None:
        places.append(StockAlert.shop_id.in_([s for s in shop_ids if s is not None] or [uuid.uuid4()]))
    if company_ids:
        places.append(and_(StockAlert.level == "company", StockAlert.company_id.in_(list(company_ids))))
    if places:
        q = q.filter(or_(*places))
    return q.order_by(StockAlert.raised_at.desc()).limit(500).all()
