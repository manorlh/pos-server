import uuid

from sqlalchemy import (
    Boolean, Column, ForeignKey, Numeric, Integer, Date,
    DateTime, String, UniqueConstraint, Index,
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
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)

    day_date = Column(Date, nullable=False)

    #: The shop's own Z counter — 1, 2, 3 … across every till in the shop.
    #:
    #: A Z already has a globally unique `id`, but a UUID is not a number a bookkeeper
    #: can read off one report and check against the previous one. This is, and a gap in
    #: it means a close is missing.
    #:
    #: Allocated by the cloud, not the till: no till can know what the others in the
    #: shop have closed, least of all offline. The consequence is that the paper torn
    #: off at close does not carry it — the till learns it from the upsert
    #: acknowledgement, so a reprint does. Nullable because a terminal that is not
    #: assigned to a shop has no shop sequence to draw from.
    shop_sequence_number = Column(Integer, nullable=True)

    # Snapshot totals (denormalised from items at close time for fast list queries)
    total_sales = Column(Numeric(12, 2), nullable=True)
    total_refunds = Column(Numeric(12, 2), nullable=True)
    total_cash_sales = Column(Numeric(12, 2), nullable=True)
    total_card_sales = Column(Numeric(12, 2), nullable=True)
    total_tips = Column(Numeric(12, 2), nullable=True)
    total_cash_tips = Column(Numeric(12, 2), nullable=True)
    total_card_tips = Column(Numeric(12, 2), nullable=True)
    transactions_count = Column(Integer, nullable=True)

    #: Closed by a manager from the cloud with nobody at the drawer.
    #:
    #: Matters because `actual_cash` is then left NULL rather than copied from
    #: `expected_cash`. Copying it made every unattended Z assert a variance of exactly
    #: zero — a shop with a real shortfall got a document claiming it balanced. Null
    #: says "nobody counted", which is the truth, and this flag says why.
    unattended = Column(Boolean, nullable=False, default=False, server_default="false")

    #: Built by the cloud from the documents it holds, because the terminal that owned
    #: this day could not close it — it died, or was replaced, and a Z can otherwise
    #: only be issued by the terminal itself.
    #:
    #: Never silently equivalent to a terminal-issued Z. `actual_cash` is NULL (nobody
    #: counted a drawer), `reconstructed_by` names the person who authorised it, and
    #: `reconstruction_basis` records what the figures were built from — how many
    #: documents the cloud held, when the terminal was last heard from, and what backlog
    #: it last reported. Without that, a reader has no way to judge how complete it is.
    reconstructed = Column(Boolean, nullable=False, default=False, server_default="false")
    reconstructed_by = Column(String(255), nullable=True)
    reconstruction_basis = Column(JSONB, nullable=True)

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
    shop = relationship("Shop")
