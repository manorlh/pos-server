import uuid

from sqlalchemy import Column, BigInteger, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base

DEFAULT_SKU_SEQUENCE_START = 100001


class MerchantSkuSequence(Base):
    """Per-merchant counter for auto-assigned numeric SKUs (Sirius-style)."""

    __tablename__ = "merchant_sku_sequences"

    merchant_id = Column(UUID(as_uuid=True), ForeignKey("merchants.id"), primary_key=True)
    next_value = Column(BigInteger, nullable=False, default=DEFAULT_SKU_SEQUENCE_START)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    merchant = relationship("Merchant", back_populates="sku_sequence")
