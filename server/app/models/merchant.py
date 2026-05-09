import uuid

from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Merchant(Base):
    __tablename__ = "merchants"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    distributor_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant", back_populates="merchants")
    distributor = relationship("User", foreign_keys=[distributor_id])
    users = relationship("User", back_populates="merchant", foreign_keys="User.merchant_id")
    companies = relationship("Company", back_populates="merchant")
    machines = relationship("POSMachine", back_populates="merchant")
    products = relationship("Product", back_populates="merchant")
    categories = relationship("Category", back_populates="merchant")
