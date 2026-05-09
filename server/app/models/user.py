import uuid
import enum

from sqlalchemy import Column, String, Boolean, ForeignKey, Enum as SQLEnum, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class UserRole(str, enum.Enum):
    SUPER_ADMIN = "super_admin"
    DISTRIBUTOR = "distributor"
    MERCHANT_ADMIN = "merchant_admin"
    COMPANY_MANAGER = "company_manager"
    SHOP_MANAGER = "shop_manager"
    CASHIER = "cashier"


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_user_id = Column(String(255), unique=True, nullable=True, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=True)
    role = Column(SQLEnum(UserRole, values_callable=lambda x: [e.value for e in x]), nullable=False, default=UserRole.CASHIER)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    merchant_id = Column(UUID(as_uuid=True), ForeignKey("merchants.id"), nullable=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant")
    merchant = relationship("Merchant", back_populates="users", foreign_keys=[merchant_id])
    company = relationship("Company", back_populates="users", foreign_keys=[company_id])
    shop = relationship("Shop", back_populates="users", foreign_keys=[shop_id])
    distributor_machines = relationship("POSMachine", back_populates="distributor", foreign_keys="POSMachine.distributor_id")
    tenant_memberships = relationship("TenantMembership", back_populates="user", cascade="all, delete-orphan")
