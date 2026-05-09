import uuid
import enum

from sqlalchemy import Column, String, Boolean, ForeignKey, Integer, Enum as SQLEnum, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class CatalogLevel(str, enum.Enum):
    GLOBAL = "global"
    LOCAL = "local"


class Category(Base):
    __tablename__ = "categories"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    merchant_id = Column(UUID(as_uuid=True), ForeignKey("merchants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    pos_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)
    catalog_level = Column(SQLEnum(CatalogLevel, values_callable=lambda x: [e.value for e in x]), nullable=False, default=CatalogLevel.GLOBAL)

    name = Column(String(255), nullable=False)
    description = Column(String(1000), nullable=True)
    color = Column(String(7), nullable=True)
    image_url = Column(String(500), nullable=True)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships
    merchant = relationship("Merchant", back_populates="categories")
    company = relationship("Company", back_populates="categories")
    shop = relationship("Shop", back_populates="categories")
    pos_machine = relationship("POSMachine", back_populates="categories")
    parent = relationship("Category", remote_side=[id], backref="children")
    products = relationship("Product", back_populates="category")
