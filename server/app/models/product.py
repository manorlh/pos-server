import uuid
import enum

from sqlalchemy import (
    Column, String, Boolean, ForeignKey, Numeric, Integer,
    Enum as SQLEnum, DateTime, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class CatalogLevel(str, enum.Enum):
    GLOBAL = "global"   # Master product at tenant/company level
    LOCAL = "local"     # Shop/machine copy, may override global values


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("tenant_id", "sku", name="uq_product_sku_tenant"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    pos_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=False)
    global_product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=True)
    catalog_level = Column(SQLEnum(CatalogLevel, values_callable=lambda x: [e.value for e in x]), nullable=False, default=CatalogLevel.GLOBAL)
    is_local_override = Column(Boolean, default=False, nullable=False)

    name = Column(String(255), nullable=False)
    description = Column(String(1000), nullable=True)
    price = Column(Numeric(10, 2), nullable=False)
    sku = Column(String(100), nullable=False, index=True)
    global_sku = Column(String(100), nullable=True, index=True)
    sku_auto_assigned = Column(Boolean, default=False, nullable=False)
    image_url = Column(String(500), nullable=True)
    in_stock = Column(Boolean, default=True, nullable=False)
    is_available = Column(Boolean, default=True, nullable=False)
    stock_quantity = Column(Integer, default=0, nullable=False)
    barcode = Column(String(100), nullable=True)
    tax_rate = Column(Numeric(5, 2), nullable=True)
    voucher_id = Column(UUID(as_uuid=True), ForeignKey("vouchers.id"), nullable=True, index=True)
    track_stock = Column(Boolean, default=False, nullable=False, server_default="false")
    # "General item": the cashier types the amount at the till. `price` is then only the
    # starting suggestion the till pre-fills, never the amount charged on its own.
    is_open_price = Column(Boolean, default=False, nullable=False, server_default="false")
    # Sold by weight or volume rather than by the piece: the till's cart quantity is a
    # decimal, so 0.734 ק"ג is a valid line and `price` is per unit of `unit_label`.
    #
    # Orthogonal to `is_open_price` and deliberately compatible with it — see the note
    # on `unit_label`. Shop stock copes with either: `stock_levels.quantity` and
    # `stock_movements.delta` are already Numeric(12,3). (The legacy per-product
    # `stock_quantity` counter above is still an Integer, but that column is not what
    # a shop's on-hand is read from.)
    is_weighed = Column(Boolean, default=False, nullable=False, server_default="false")
    # What one unit of `price` buys: ק"ג, ליטר, יח'. Free text, not an enum, because the
    # merchant's own label is what has to appear on the receipt and the shelf, and a
    # closed list would need a migration for the first shop that sells by the מטר.
    # Nullable: a product that has not been given one falls back to the till's default.
    unit_label = Column(String(16), nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    company = relationship("Company", back_populates="products")
    shop = relationship("Shop", back_populates="products")
    pos_machine = relationship("POSMachine", back_populates="products")
    category = relationship("Category", back_populates="products")
    global_product = relationship("Product", remote_side="Product.id")
    voucher = relationship("Voucher", back_populates="products")
