import uuid
import enum

from sqlalchemy import (
    Column, String, ForeignKey, Integer, Numeric, Date,
    Enum as SQLEnum, DateTime, Index, text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class TradingDayStatus(str, enum.Enum):
    OPEN = "open"
    CLOSED = "closed"


class TradingDay(Base):
    """
    A POS shift / trading day envelope, authored by the till.

    Identity is the row's own id, which the till generates. It is deliberately *not*
    `(machine_id, day_date)`: two shifts on one calendar date is ordinary retail, and
    keying on the date made the evening shift indistinguishable from the morning's —
    its sales attached to a day that was already closed and Z'd, and its own Z came
    back as a duplicate that the till read as success and purged behind.

    What actually has to be true is enforced instead: **at most one open day per
    machine**, as a partial unique index. `day_date` survives as a reporting
    attribute, and `sequence_number` orders a machine's days so a gap is visible.
    """

    __tablename__ = "trading_days"
    __table_args__ = (
        Index("ix_trading_days_machine_status", "machine_id", "status"),
        # The real invariant. A till may have many days on one date, but only ever
        # one open at a time.
        Index(
            "uq_trading_day_one_open",
            "machine_id",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)

    day_date = Column(Date, nullable=False)
    #: Per-machine counter, assigned by the till. Nullable for days that predate it.
    #: Makes "day 7 is missing" answerable, which a date alone cannot.
    sequence_number = Column(Integer, nullable=True)
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

    machine = relationship("POSMachine")
    shop = relationship("Shop")
    transactions = relationship("Transaction", back_populates="trading_day")
    z_report = relationship("ZReport", back_populates="trading_day", uselist=False)
