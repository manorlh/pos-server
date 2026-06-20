import uuid

from sqlalchemy import Column, String, ForeignKey, DateTime, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class PairingSession(Base):
    """Distributor field-install session (12h). Mobile JWT references jti."""

    __tablename__ = "pairing_sessions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    jti = Column(String(64), unique=True, nullable=False, index=True)
    distributor_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    default_company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    default_shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    machines_paired_count = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    distributor = relationship("User", foreign_keys=[distributor_id])
    default_company = relationship("Company", foreign_keys=[default_company_id])
    default_shop = relationship("Shop", foreign_keys=[default_shop_id])
