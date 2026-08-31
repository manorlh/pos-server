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
    # Kept populated for every document, including split-tender ones, because an
    # older till build and every existing report and export still read it. The
    # authoritative breakdown now lives in `payments`; this is the single-value
    # summary of it — the tender name for a one-leg document, and the literal
    # "mixed" for a document with more than one. See `derive_payment_method`.
    payment_method = Column(String(50), nullable=True)

    amount_tendered = Column(Numeric(12, 2), nullable=True)
    change_amount = Column(Numeric(12, 2), nullable=True)
    total_amount = Column(Numeric(12, 2), nullable=False, server_default="0")
    tip_amount = Column(Numeric(12, 2), nullable=False, server_default="0")
    tip_payment_method = Column(String(10), nullable=True)
    total_discount = Column(Numeric(12, 2), nullable=True)
    document_discount = Column(Numeric(12, 2), nullable=True)
    wht_deduction = Column(Numeric(12, 2), nullable=True)

    # Free text as sent by the till — a cloud customer UUID on a current build, but
    # historically anything the client had. Never rejected on ingest; see
    # `customer_ref_id` for the validated link.
    customer_id = Column(String(100), nullable=True)
    # The resolved link, written server-side: set only when `customer_id` parses as a
    # UUID **and** names a customer of this machine's tenant. This is the column the
    # receipt and tax-export code joins on, so an unresolvable reference reads as
    # "no customer" instead of silently producing a tax invoice addressed to nobody.
    customer_ref_id = Column(UUID(as_uuid=True), ForeignKey("customers.id"), nullable=True, index=True)
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
    shop = relationship("Shop")
    trading_day = relationship("TradingDay", back_populates="transactions")
    items = relationship(
        "TransactionItem",
        back_populates="transaction",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    issued_vouchers = relationship(
        "IssuedVoucher",
        back_populates="transaction",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    payments = relationship(
        "TransactionPayment",
        back_populates="transaction",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TransactionPayment.sequence",
    )
    customer = relationship("Customer", foreign_keys=[customer_ref_id])
    refund_of = relationship("Transaction", remote_side="Transaction.id")
