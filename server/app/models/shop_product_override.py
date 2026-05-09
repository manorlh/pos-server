import uuid

from sqlalchemy import Column, Boolean, ForeignKey, DateTime, Numeric, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ShopProductOverride(Base):
    """Per-shop price, catalog listing, and sale availability on top of global products."""

    __tablename__ = "shop_product_overrides"
    __table_args__ = (
        UniqueConstraint("shop_id", "global_product_id", name="uq_shop_product_override"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False, index=True)
    global_product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False, index=True)
    price = Column(Numeric(10, 2), nullable=True)
    is_listed = Column(Boolean, nullable=False, default=True)
    # When listed: allow adding to cart on POS (default True for new assortment rows).
    is_available = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    shop = relationship("Shop", back_populates="product_overrides")
    global_product = relationship("Product", foreign_keys=[global_product_id])
