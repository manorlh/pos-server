import uuid
import enum

from sqlalchemy import Column, String, DateTime, Enum as SQLEnum
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class TenantStatus(str, enum.Enum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    ARCHIVED = "archived"


class Tenant(Base):
    __tablename__ = "tenants"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False, unique=True, index=True)
    slug = Column(String(255), nullable=False, unique=True, index=True)
    status = Column(
        SQLEnum(TenantStatus, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=TenantStatus.ACTIVE,
    )
    timezone = Column(String(100), nullable=False, default="UTC")
    default_currency = Column(String(8), nullable=False, default="ILS")
    locale = Column(String(32), nullable=False, default="en")
    settings = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    memberships = relationship("TenantMembership", back_populates="tenant", cascade="all, delete-orphan")
    merchants = relationship("Merchant", back_populates="tenant")
