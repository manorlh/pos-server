import uuid

from sqlalchemy import (
    Column, ForeignKey, Numeric, Integer, Date,
    DateTime, UniqueConstraint, Index,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ZReport(Base):
    """End-of-day Z report. UNIQUE on trading_day_id makes double-close idempotent."""

    __tablename__ = "z_reports"
    __table_args__ = (
        UniqueConstraint("trading_day_id", name="uq_zreport_trading_day"),
        Index("ix_z_reports_machine_day", "machine_id", "day_date"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    trading_day_id = Column(UUID(as_uuid=True), ForeignKey("trading_days.id"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    merchant_id = Column(UUID(as_uuid=True), ForeignKey("merchants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)

    day_date = Column(Date, nullable=False)

    # Snapshot totals (denormalised from items at close time for fast list queries)
    total_sales = Column(Numeric(12, 2), nullable=True)
    total_refunds = Column(Numeric(12, 2), nullable=True)
    total_cash_sales = Column(Numeric(12, 2), nullable=True)
    total_card_sales = Column(Numeric(12, 2), nullable=True)
    transactions_count = Column(Integer, nullable=True)

    opening_cash = Column(Numeric(12, 2), nullable=True)
    closing_cash = Column(Numeric(12, 2), nullable=True)
    expected_cash = Column(Numeric(12, 2), nullable=True)
    actual_cash = Column(Numeric(12, 2), nullable=True)
    discrepancy = Column(Numeric(12, 2), nullable=True)

    # Full ZReportData blob from POS — keeps the door open for richer analytics later.
    payload = Column(JSONB, nullable=True)

    closed_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    trading_day = relationship("TradingDay", back_populates="z_report")
    machine = relationship("POSMachine")
    merchant = relationship("Merchant")
    shop = relationship("Shop")
