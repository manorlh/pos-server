import uuid
import enum

from sqlalchemy import (
    Column, String, ForeignKey, Numeric, Integer,
    Enum as SQLEnum, DateTime, Index,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.database import Base


class IssuedVoucherStatus(str, enum.Enum):
    ISSUED = "issued"
    VOIDED = "voided"
    REDEEMED = "redeemed"


class IssuedVoucher(Base):
    """A single issued שובר instance — one per voucher-linked transaction line."""

    __tablename__ = "issued_vouchers"
    __table_args__ = (
        Index("ix_issued_vouchers_transaction", "transaction_id"),
        Index("ix_issued_vouchers_tenant", "tenant_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated UUID = serial
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True, index=True)

    transaction_id = Column(
        UUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False,
    )
    transaction_item_id = Column(UUID(as_uuid=True), nullable=True)
    voucher_id = Column(UUID(as_uuid=True), ForeignKey("vouchers.id"), nullable=True)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=True)

    product_name = Column(String(255), nullable=True)
    quantity = Column(Numeric(12, 3), nullable=False, default=1)
    unit_value = Column(Numeric(12, 2), nullable=True)
    face_value = Column(Numeric(12, 2), nullable=True)

    issued_at = Column(DateTime(timezone=True), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(
        SQLEnum(IssuedVoucherStatus, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=IssuedVoucherStatus.ISSUED,
    )
    reprint_count = Column(Integer, nullable=False, default=0)
    last_printed_at = Column(DateTime(timezone=True), nullable=True)

    transaction = relationship("Transaction", back_populates="issued_vouchers")
    voucher = relationship("Voucher", back_populates="issued_vouchers")
    product = relationship("Product")
