import uuid

from sqlalchemy import Column, ForeignKey, Numeric, Integer, DateTime, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class StockLevel(Base):
    """Materialized on-hand quantity per shop + global product (cache of movement sum)."""

    __tablename__ = "stock_levels"
    __table_args__ = (
        UniqueConstraint("shop_id", "product_id", name="uq_stock_level_shop_product"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False, index=True)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False, index=True)
    quantity = Column(Numeric(12, 3), nullable=False, server_default="0")
    reorder_min = Column(Integer, nullable=True)
    reorder_max = Column(Integer, nullable=True)
    reorder_opt = Column(Integer, nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    shop = relationship("Shop")
    product = relationship("Product")
