"""
"אופן ניהול מלאי" — which levels of the hierarchy hold stock for a product, and its low-stock
alerts (app/services/stock_locations.py, app/services/stock.py).

* `StockLevelSetting` — one rule: for a company or a shop (`scope_level` / `scope_id`), for
  everything, a category or one product (`item_kind` / `item_id`), the managed levels (`levels`,
  any of company · shop · area · machine · group). No rule anywhere = shop only (every shop's stock
  as it always was).
* `StockAlert` — a stock location that ran low (at or under its reorder minimum) or out (≤ 0), open
  until it is above again; it suggests a transfer from the nearest managed location above it that
  has stock. Recorded in the exceptions log (kinds `stock_low` / `stock_out`) for the SMS rules.
* `StockReset` / `StockResetItem` — "איפוס יומי": one run per location per business day and, per
  product, what was left ("נשאר בסוף היום"), what it was set to and how (app/services/stock_reset.py).
"""
import uuid

from sqlalchemy import Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class StockLevelSetting(Base):
    __tablename__ = "stock_level_settings"
    __table_args__ = (Index("ix_stock_level_settings_scope", "scope_level", "scope_id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    #: "company" | "shop".
    scope_level = Column(String(16), nullable=False)
    scope_id = Column(UUID(as_uuid=True), nullable=False)
    #: NULL (everything) | "category" | "product".
    item_kind = Column(String(16), nullable=True)
    item_id = Column(UUID(as_uuid=True), nullable=True)
    #: One rule per (scope, item): "shop:<id>:product:<id>", "company:<id>:-:-".
    rule_key = Column(String(160), nullable=False, unique=True)
    #: The managed levels, top down: ["shop"], ["shop", "area"], ["company", "shop", "machine"]…
    levels = Column(JSONB, nullable=False)
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class StockAlert(Base):
    __tablename__ = "stock_alerts"
    __table_args__ = (
        Index("ix_stock_alerts_location", "level", "target_id", "product_id"),
        Index("ix_stock_alerts_shop_open", "shop_id", "cleared_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    level = Column(String(16), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    product_name = Column(String(255), nullable=True)
    #: "low" | "out".
    kind = Column(String(8), nullable=False)
    quantity = Column(Numeric(12, 3), nullable=False)
    threshold = Column(Numeric(12, 3), nullable=True)
    #: "העבר מהמחסן": the nearest managed location above that had stock when it was raised.
    suggest_level = Column(String(16), nullable=True)
    suggest_target_id = Column(UUID(as_uuid=True), nullable=True)
    suggest_quantity = Column(Numeric(12, 3), nullable=True)
    raised_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    cleared_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class StockReset(Base):
    """
    "איפוס יומי": one run at one stock location for one business day (app/services/stock_reset.py).
    `run_key` makes the scheduled run unique per location and day ("<level>:<id>:<day>"); a manual
    "בצע איפוס עכשיו" gets its own key and may run any time.
    """

    __tablename__ = "stock_resets"
    __table_args__ = (Index("ix_stock_resets_shop_day", "shop_id", "business_day"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    level = Column(String(16), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False)
    business_day = Column(Date, nullable=False)
    run_key = Column(String(160), nullable=False, unique=True)
    #: "schedule" | "manual".
    trigger = Column(String(16), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(200), nullable=True)
    run_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    items = Column(Integer, nullable=False, default=0, server_default="0")


class StockResetItem(Base):
    """One product of a reset: what was left ("נשאר בסוף היום"), what it was set to, and how."""

    __tablename__ = "stock_reset_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reset_id = Column(UUID(as_uuid=True), ForeignKey("stock_resets.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True)
    product_name = Column(String(255), nullable=True)
    mode = Column(String(16), nullable=False)
    #: The leftover at the end of the day (late sales of that day lower it when they arrive).
    before_quantity = Column(Numeric(12, 3), nullable=False)
    opening_quantity = Column(Numeric(12, 3), nullable=False)
    #: The change the reset made here (set: opening − before; top up: what was transferred in).
    delta = Column(Numeric(12, 3), nullable=False)
    from_level = Column(String(16), nullable=True)
    from_target_id = Column(UUID(as_uuid=True), nullable=True)
    #: Top up: what the location above could not give.
    shortfall = Column(Numeric(12, 3), nullable=True)
    movement_id = Column(UUID(as_uuid=True), nullable=True)
