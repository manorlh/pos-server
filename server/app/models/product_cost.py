"""
What one unit of a product costs the business ("עלות ליחידה"), for the insights' menu
engineering (docs/SPEC_INSIGHTS.md): contribution margin = price excl. VAT − this.

Its own table rather than a column on `products`, on purpose: it is management data the
tills never see (so nothing about the catalog sync or the product schemas changes), and a
table can later carry a supplier and a history without touching the catalog. One row per
tenant and **global** product — a till's local copy of a product resolves to its global
product before it is looked up here.

Money is per unit and **excluding VAT**, as a supplier's invoice states it.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Numeric, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class ProductCost(Base):
    __tablename__ = "product_costs"
    __table_args__ = (
        UniqueConstraint("tenant_id", "product_id", name="uq_product_costs_tenant_product"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    product_id = Column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    cost = Column(Numeric(10, 2), nullable=False)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
