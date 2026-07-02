import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock

from app.models.stock_movement import StockMovementReason
from app.services.stock import (
    effective_stock_updated_at,
    serialize_stock_level,
)


def _ts(y: int, m: int, d: int) -> datetime:
    return datetime(y, m, d, tzinfo=timezone.utc)


def test_effective_stock_updated_at_uses_max_of_levels_and_movements() -> None:
    db = MagicMock()
    level_max = _ts(2026, 6, 1)
    movement_max = _ts(2026, 6, 15)
    db.query.return_value.filter.return_value.scalar.side_effect = [level_max, movement_max]
    assert effective_stock_updated_at(db, uuid.uuid4()) == movement_max


def test_effective_stock_updated_at_falls_back_to_now_when_empty() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.scalar.side_effect = [None, None]
    before = datetime.now(timezone.utc)
    result = effective_stock_updated_at(db, uuid.uuid4())
    after = datetime.now(timezone.utc)
    assert before <= result <= after


def test_serialize_stock_level_includes_product_fields() -> None:
    level = MagicMock()
    level.product_id = uuid.uuid4()
    level.quantity = Decimal("12.5")
    level.reorder_min = 2
    level.reorder_max = 20
    level.reorder_opt = 10
    level.updated_at = _ts(2026, 5, 1)
    product = MagicMock()
    product.name = "Cola"
    product.sku = "SKU-1"
    level.product = product

    data = serialize_stock_level(level)
    assert data["productId"] == str(level.product_id)
    assert data["productName"] == "Cola"
    assert data["sku"] == "SKU-1"
    assert data["quantity"] == 12.5
    assert data["reorderMin"] == 2
    assert data["reorderMax"] == 20
    assert data["reorderOpt"] == 10
    assert data["updatedAt"] == level.updated_at.isoformat()


def test_stock_movement_reason_includes_sale() -> None:
    assert StockMovementReason.SALE.value == "sale"
