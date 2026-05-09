import uuid
import enum

from sqlalchemy import (
    Column, String, ForeignKey, Numeric, Date,
    Enum as SQLEnum, DateTime, UniqueConstraint, Index,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class TradingDayStatus(str, enum.Enum):
    OPEN = "open"
    CLOSED = "closed"


class TradingDay(Base):
    """A POS shift / trading day envelope. One open row per (machine, day_date)."""

    __tablename__ = "trading_days"
    __table_args__ = (
        UniqueConstraint("machine_id", "day_date", name="uq_trading_day_machine_date"),
        Index("ix_trading_days_machine_status", "machine_id", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    merchant_id = Column(UUID(as_uuid=True), ForeignKey("merchants.id"), nullable=False, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)

    day_date = Column(Date, nullable=False)
    opened_at = Column(DateTime(timezone=True), nullable=False)
    closed_at = Column(DateTime(timezone=True), nullable=True)

    opening_cash = Column(Numeric(12, 2), nullable=True)
    closing_cash = Column(Numeric(12, 2), nullable=True)
    expected_cash = Column(Numeric(12, 2), nullable=True)
    actual_cash = Column(Numeric(12, 2), nullable=True)
    discrepancy = Column(Numeric(12, 2), nullable=True)

    # Stored as plain strings — POS sends user names; server users may not exist for cashiers.
    opened_by = Column(String(255), nullable=True)
    closed_by = Column(String(255), nullable=True)

    status = Column(
        SQLEnum(TradingDayStatus, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=TradingDayStatus.OPEN,
    )

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    merchant = relationship("Merchant")
    machine = relationship("POSMachine")
    shop = relationship("Shop")
    transactions = relationship("Transaction", back_populates="trading_day")
    z_report = relationship("ZReport", back_populates="trading_day", uselist=False)
