import uuid

from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Shop(Base):
    __tablename__ = "shops"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    branch_id = Column(String(50), nullable=True)        # Israeli tax authority branch code
    address = Column(String(500), nullable=True)
    city = Column(String(100), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships
    company = relationship("Company", back_populates="shops")
    machines = relationship("POSMachine", back_populates="shop")
    users = relationship("User", back_populates="shop", foreign_keys="User.shop_id")
    products = relationship("Product", back_populates="shop")
    categories = relationship("Category", back_populates="shop")
    product_overrides = relationship(
        "ShopProductOverride", back_populates="shop", cascade="all, delete-orphan"
    )
