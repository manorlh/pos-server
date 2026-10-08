"""Shop-level inventory: movement ledger + materialized stock levels."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional
import uuid

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session, joinedload

from app.models.product import Product
from app.models.shop import Shop
from app.models.stock_level import StockLevel
from app.models.stock_movement import StockMovement, StockMovementReason


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _resolve_global_product_id(db: Session, product_id: uuid.UUID) -> Optional[uuid.UUID]:
    """Stock is keyed by global product id; map machine-local rows when needed."""
    p = db.query(Product).filter(Product.id == product_id).first()
    if not p:
        return None
    if p.global_product_id:
        return p.global_product_id
    return p.id


def apply_movement(
    db: Session,
    *,
    movement_id: uuid.UUID,
    tenant_id: uuid.UUID,
    shop_id: uuid.UUID,
    product_id: uuid.UUID,
    delta: Decimal,
    reason: StockMovementReason,
    occurred_at: datetime,
    transaction_id: Optional[uuid.UUID] = None,
    transaction_item_id: Optional[uuid.UUID] = None,
    machine_id: Optional[uuid.UUID] = None,
    created_by_user_id: Optional[uuid.UUID] = None,
    note: Optional[str] = None,
) -> bool:
    """
    Insert movement idempotently and update stock_levels.
    Returns True if a new movement was applied, False if duplicate id.
    """
    global_pid = _resolve_global_product_id(db, product_id)
    if not global_pid:
        return False

    stmt = (
        pg_insert(StockMovement)
        .values(
            id=movement_id,
            tenant_id=tenant_id,
            shop_id=shop_id,
            product_id=global_pid,
            delta=delta,
            reason=reason,
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

    level = (
        db.query(StockLevel)
        .filter(StockLevel.shop_id == shop_id, StockLevel.product_id == global_pid)
        .first()
    )
    before = Decimal(str(level.quantity)) if level else Decimal("0")
    if level:
        level.quantity = Decimal(str(level.quantity)) + delta
        level.updated_at = utc_now()
    else:
        db.add(
            StockLevel(
                tenant_id=tenant_id,
                shop_id=shop_id,
                product_id=global_pid,
                quantity=delta,
                updated_at=utc_now(),
            )
        )
    after = before + Decimal(str(delta))
    if (before > 0) != (after > 0):
        _wake_shop_on_crossing(db, shop_id, global_pid)
        _auto_sold_out(db, tenant_id, shop_id, global_pid, ran_out=after <= 0)
    return True


def _auto_sold_out(db: Session, tenant_id, shop_id, product_id, *, ran_out: bool) -> None:
    """
    The automatic "אזל" hook (app/services/sold_out.py `on_stock_crossing`): the stock the devices
    sell from — the shop's, here — reached 0 (or came back) for a product that tracks stock.
    """
    tracked = db.query(Product.track_stock).filter(Product.id == product_id).scalar()
    if not tracked:
        return
    from app.services import sold_out

    sold_out.on_stock_crossing(
        db, tenant_id=tenant_id, scope="shop", scope_id=shop_id, product_id=product_id, ran_out=ran_out,
    )


#: `reason` of the catalog signal a till gets when an item it sells runs out (or is back).
STOCK_CROSSED_REASON = "stock_crossed_zero"


def _wake_shop_on_crossing(db: Session, shop_id: uuid.UUID, product_id: uuid.UUID) -> None:
    """
    A product that tracks stock ran out in the shop (or came back): every till of the shop
    — the kiosk included — pulls its stock after the commit, so the item shows "אזל" there
    within seconds of the sale on another till rather than at its next periodic sync
    (docs/SPEC_AVAILABILITY.md). The dashboard's own stock writes signal for themselves.
    """
    tracked = db.query(Product.track_stock).filter(Product.id == product_id).scalar()
    if not tracked:
        return
    from app.models.pos_machine import POSMachine
    from app.services.commit_signals import catalog_signal_after_commit

    tills = (
        db.query(POSMachine.tenant_id, POSMachine.id)
        .filter(POSMachine.shop_id == shop_id, POSMachine.is_active.is_(True))
        .all()
    )
    catalog_signal_after_commit(
        db, [(str(t), str(m)) for t, m in tills if t is not None], STOCK_CROSSED_REASON
    )


def set_quantity(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    shop_id: uuid.UUID,
    product_id: uuid.UUID,
    target_quantity: Decimal,
    created_by_user_id: Optional[uuid.UUID] = None,
    note: Optional[str] = None,
) -> StockLevel:
    """Stocktake: set absolute on-hand by emitting an adjustment movement for the delta."""
    global_pid = _resolve_global_product_id(db, product_id)
    if not global_pid:
        raise ValueError("Product not found")

    level = (
        db.query(StockLevel)
        .filter(StockLevel.shop_id == shop_id, StockLevel.product_id == global_pid)
        .first()
    )
    current = Decimal(str(level.quantity)) if level else Decimal("0")
    delta = target_quantity - current
    if delta == 0 and level:
        return level

    apply_movement(
        db,
        movement_id=uuid.uuid4(),
        tenant_id=tenant_id,
        shop_id=shop_id,
        product_id=global_pid,
        delta=delta,
        reason=StockMovementReason.STOCKTAKE,
        occurred_at=utc_now(),
        created_by_user_id=created_by_user_id,
        note=note or f"Stocktake set to {target_quantity}",
    )
    db.flush()
    return (
        db.query(StockLevel)
        .filter(StockLevel.shop_id == shop_id, StockLevel.product_id == global_pid)
        .first()
    )


def get_levels_for_shop(
    db: Session,
    shop_id: uuid.UUID,
    since: Optional[datetime] = None,
) -> List[StockLevel]:
    q = (
        db.query(StockLevel)
        .options(joinedload(StockLevel.product))
        .filter(StockLevel.shop_id == shop_id)
    )
    if since:
        q = q.filter(StockLevel.updated_at > since)
    return q.order_by(StockLevel.updated_at.desc()).all()


def effective_stock_updated_at(db: Session, shop_id: uuid.UUID) -> datetime:
    level_max = (
        db.query(func.max(StockLevel.updated_at))
        .filter(StockLevel.shop_id == shop_id)
        .scalar()
    )
    movement_max = (
        db.query(func.max(StockMovement.created_at))
        .filter(StockMovement.shop_id == shop_id)
        .scalar()
    )
    stamps = [s for s in (level_max, movement_max) if s is not None]
    return max(stamps) if stamps else utc_now()


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
