import uuid

from sqlalchemy import Column, Date, String, Boolean, ForeignKey, DateTime, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Shop(Base):
    __tablename__ = "shops"
    __table_args__ = (
        UniqueConstraint("company_id", "shop_number", name="uq_shops_company_shop_number"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    #: Shop 1, 2, 3 in its company, from `org_number_sequences`, never reused; a shop
    #: moved to another company draws that company's next (`app.services.org_numbers`).
    shop_number = Column(Integer, nullable=True)
    branch_id = Column(String(50), nullable=True)        # Israeli tax authority branch code
    address = Column(String(500), nullable=True)
    city = Column(String(100), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    #: "permanent" | "temporary" — a short-term customer or a one-off event. A temporary
    #: one stops selling after `license_expires_on` (app/services/licenses.py). Set by
    #: the super admin only.
    license_type = Column(String(16), nullable=False, default="permanent", server_default="permanent")
    license_expires_on = Column(Date, nullable=True)
    settings = Column(JSONB, nullable=False, server_default="{}")
    settings_updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
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
