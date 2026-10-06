"""
"פתיחת פריטים אוטומטית אחרי Z" — the record of what a Z reopened
(docs/SPEC_AVAILABILITY.md, app/services/availability_reopen.py).

One `AvailabilityDayClose` per (Z, level, target) whose trading day that Z closed while the
setting was on for it: the shop, a point of sale (area) or one till. It is the run's
idempotency key — a Z is never applied twice to the same scope — and the start of the next
day for "רק מה שנחסם במהלך היום" (the previous close of the same scope).

One `AvailabilityReopen` per item that run looked at: the products and categories it
opened, and the ones it kept closed because the item tracks stock and has none.
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class AvailabilityDayClose(Base):
    __tablename__ = "availability_day_closes"
    __table_args__ = (
        UniqueConstraint("z_report_id", "level", "target_id", name="uq_availability_day_close"),
        Index("ix_availability_day_closes_target", "level", "target_id", "closed_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    #: The Z that closed the day.
    z_report_id = Column(
        UUID(as_uuid=True), ForeignKey("z_reports.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: "shop", "area" or "machine".
    level = Column(String(16), nullable=False)
    #: The shop's, the area's or the till's id, by `level`.
    target_id = Column(UUID(as_uuid=True), nullable=False)
    #: When the scope's day ended: the Z's close, or a later Z's that the day waited for.
    closed_at = Column(DateTime(timezone=True), nullable=False)
    #: The setting in force for the scope: "day" or "all".
    mode = Column(String(8), nullable=False)
    ignore_stock = Column(Boolean, nullable=False, default=False, server_default="false")
    reopened_count = Column(Integer, nullable=False, default=0, server_default="0")
    kept_count = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AvailabilityReopen(Base):
    __tablename__ = "availability_reopens"
    __table_args__ = (
        UniqueConstraint("day_close_id", "kind", "item_id", name="uq_availability_reopen_item"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    day_close_id = Column(
        UUID(as_uuid=True),
        ForeignKey("availability_day_closes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: "product" or "category".
    kind = Column(String(16), nullable=False)
    item_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    #: The item's name as it was, for the log.
    item_name = Column(String(255), nullable=True)
    #: "reopened", or "kept_stock" (tracks stock and has none).
    outcome = Column(String(16), nullable=False)
    #: When the lock it opened (or kept) began; NULL for a lock older than the column.
    blocked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
