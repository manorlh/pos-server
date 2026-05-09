import uuid
import enum

from sqlalchemy import (
    Column, String, ForeignKey, Numeric, Integer, Text,
    Enum as SQLEnum, DateTime, UniqueConstraint, Index,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class TransactionStatus(str, enum.Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    REFUNDED = "refunded"
    PARTIAL_REFUND = "partial_refund"


class Transaction(Base):
    """A POS sale / refund. id is client-generated UUID for idempotent upserts."""

    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint("machine_id", "transaction_number", name="uq_tx_machine_number"),
        Index("ix_transactions_machine_created_at", "machine_id", "created_at"),
        Index("ix_transactions_trading_day", "trading_day_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    merchant_id = Column(UUID(as_uuid=True), ForeignKey("merchants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    trading_day_id = Column(UUID(as_uuid=True), ForeignKey("trading_days.id"), nullable=True)

    transaction_number = Column(String(100), nullable=False)
    status = Column(
        SQLEnum(TransactionStatus, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=TransactionStatus.COMPLETED,
    )

    document_type = Column(Integer, nullable=True)
    document_production_date = Column(DateTime(timezone=True), nullable=True)
    payment_method = Column(String(50), nullable=True)

    amount_tendered = Column(Numeric(12, 2), nullable=True)
    change_amount = Column(Numeric(12, 2), nullable=True)
    total_amount = Column(Numeric(12, 2), nullable=False, server_default="0")
    total_discount = Column(Numeric(12, 2), nullable=True)
    document_discount = Column(Numeric(12, 2), nullable=True)
    wht_deduction = Column(Numeric(12, 2), nullable=True)

    customer_id = Column(String(100), nullable=True)
    cashier_id = Column(String(100), nullable=True)
    branch_id = Column(String(100), nullable=True)
    notes = Column(Text, nullable=True)

    refund_of_transaction_id = Column(UUID(as_uuid=True), ForeignKey("transactions.id"), nullable=True)
    nayax_meta = Column(JSONB, nullable=True)

    # Timestamps from POS
    created_at = Column(DateTime(timezone=True), nullable=False)
    updated_at = Column(DateTime(timezone=True), nullable=False)
    # Authoritative server-side wall clock used when POS clock skew is suspected
    server_received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    machine = relationship("POSMachine")
    merchant = relationship("Merchant")
    shop = relationship("Shop")
    trading_day = relationship("TradingDay", back_populates="transactions")
    items = relationship(
        "TransactionItem",
        back_populates="transaction",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    refund_of = relationship("Transaction", remote_side="Transaction.id")
