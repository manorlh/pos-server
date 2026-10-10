import uuid

from sqlalchemy import Boolean, Column, ForeignKey, Index, Numeric, Integer, DateTime, String, event
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class StockLevel(Base):
    """
    Materialized on-hand quantity (cache of the movement sum) of one product at one **stock
    location** (app/services/stock_locations.py): `level` + `target_id` —

    * `company` — the company's central warehouse (`target_id` = the company);
    * `shop`    — the shop's stock (`target_id` = the shop) — every row before locations existed;
    * `area`    — a point of sale (`target_id` = the `shop_areas` row);
    * `machine` — one till or kiosk (`target_id` = the `pos_machines` row);
    * `group`   — a group of devices (wired where `machine_groups` exists).

    `shop_id` / `company_id` are the location's shop and company, kept for indexing and for every
    reader that asks "the shop's stock" (a company location has no shop).
    """

    __tablename__ = "stock_levels"
    __table_args__ = (
        Index("uq_stock_levels_location_product", "level", "target_id", "product_id", unique=True),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True, index=True)
    #: The location's shop; NULL for a company warehouse.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    level = Column(String(16), nullable=False, default="shop", server_default="shop")
    target_id = Column(UUID(as_uuid=True), nullable=False)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False, index=True)
    quantity = Column(Numeric(12, 3), nullable=False, server_default="0")
    reorder_min = Column(Integer, nullable=True)
    reorder_max = Column(Integer, nullable=True)
    reorder_opt = Column(Integer, nullable=True)
    #: "מלאי פתיחה": what the location starts each business day with when `daily_reset` is on
    #: (app/services/stock_reset.py). `reset_mode`: "set" — set to it; "top_up" — top up to it by
    #: a transfer from the nearest managed location above that has stock.
    opening_quantity = Column(Numeric(12, 3), nullable=True)
    daily_reset = Column(Boolean, nullable=False, default=False, server_default="false")
    reset_mode = Column(String(16), nullable=False, default="set", server_default="set")
    #: When the last daily reset ran here: a till counts only its unsynced sales after it.
    last_reset_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    shop = relationship("Shop")
    product = relationship("Product")


@event.listens_for(StockLevel, "before_insert")
def _shop_location_by_default(_mapper, _connection, target: StockLevel) -> None:
    """A row written the shop-only way (shop id, no location) is the shop's location."""
    if target.level is None:
        target.level = "shop"
    if target.target_id is None and target.level == "shop":
        target.target_id = target.shop_id
