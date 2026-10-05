import uuid
import enum

from sqlalchemy import Column, Date, String, DateTime, ForeignKey, Enum as SQLEnum
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
    #: "permanent" | "temporary" — a short-term customer or a one-off event. A temporary
    #: one stops selling after `license_expires_on` (app/services/licenses.py). Set by
    #: the super admin only.
    license_type = Column(String(16), nullable=False, default="permanent", server_default="permanent")
    license_expires_on = Column(Date, nullable=True)
    settings = Column(JSONB, nullable=True)
    settings_updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    created_by = relationship("User", foreign_keys=[created_by_user_id])
    memberships = relationship("TenantMembership", back_populates="tenant", cascade="all, delete-orphan")
    sku_sequence = relationship(
        "TenantSkuSequence",
        back_populates="tenant",
        uselist=False,
        cascade="all, delete-orphan",
    )
