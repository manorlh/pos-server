import uuid

from sqlalchemy import Column, BigInteger, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base

DEFAULT_GLOBAL_SKU_SEQUENCE_START = 100001


class TenantSkuSequence(Base):
    """Per-tenant counter for auto-assigned global SKUs (searchable across merchants)."""

    __tablename__ = "tenant_sku_sequences"

    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), primary_key=True)
    next_value = Column(BigInteger, nullable=False, default=DEFAULT_GLOBAL_SKU_SEQUENCE_START)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    tenant = relationship("Tenant", back_populates="sku_sequence")
