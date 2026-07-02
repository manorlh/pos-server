import uuid
import enum

from sqlalchemy import (
    Column, String, Boolean, ForeignKey, Numeric, Integer,
    Enum as SQLEnum, DateTime, Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ValueDisplayMode(str, enum.Enum):
    PRODUCT_PRICE = "product_price"
    FIXED = "fixed"
    NONE = "none"


class Voucher(Base):
    """Reusable voucher (שובר) template — tenant-scoped."""

    __tablename__ = "vouchers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)

    name = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    title = Column(String(255), nullable=True)
    subtitle = Column(String(500), nullable=True)
    body_text = Column(Text, nullable=True)
    footer_text = Column(String(500), nullable=True)
    validity_days = Column(Integer, nullable=True)
    valid_from = Column(DateTime(timezone=True), nullable=True)
    valid_until = Column(DateTime(timezone=True), nullable=True)
    value_display_mode = Column(
        SQLEnum(ValueDisplayMode, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=ValueDisplayMode.PRODUCT_PRICE,
    )
    display_value = Column(Numeric(12, 2), nullable=True)
    print_barcode = Column(Boolean, default=True, nullable=False)
    print_qr = Column(Boolean, default=True, nullable=False)
    language = Column(String(5), nullable=True, default="he")

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    products = relationship("Product", back_populates="voucher")
    issued_vouchers = relationship("IssuedVoucher", back_populates="voucher")
