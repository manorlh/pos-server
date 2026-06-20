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

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    company = relationship("Company", back_populates="products")
    shop = relationship("Shop", back_populates="products")
    pos_machine = relationship("POSMachine", back_populates="products")
    category = relationship("Category", back_populates="products")
    global_product = relationship("Product", remote_side="Product.id")
