"""Per-tenant auto-increment for local (non-global) product SKUs."""
from sqlalchemy import Column, BigInteger, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.database import Base

DEFAULT_SKU_SEQUENCE_START = 1000


class TenantLocalSkuSequence(Base):
    __tablename__ = "tenant_local_sku_sequences"

    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), primary_key=True)
    next_value = Column(BigInteger, nullable=False, default=DEFAULT_SKU_SEQUENCE_START)

    tenant = relationship("Tenant")
