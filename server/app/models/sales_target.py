"""
"יעדים ותחרות": sales targets per shop, point of sale and cashier, for a day or an event
(app/services/sales_targets.py).

* `SalesTarget` — what to reach. `period = "day"`: every trading day (`day` NULL) or one date
  (`day` set — beats the every-day target of the same scope on that date). `period = "event"`:
  the window of an event ("אירועים", `report_events`); an area or cashier target of an event
  counts only the event's tills.
* `SalesTargetHit` — the moment a target was reached in one period, once: what the exceptions
  log records ("יעד הושג", app/services/exception_alerts) and what an SMS rule may send.
"""
import uuid

from sqlalchemy import Column, Date, DateTime, ForeignKey, Index, Numeric, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

TARGET_SCOPES = ("shop", "area", "cashier")
TARGET_PERIODS = ("day", "event")


class SalesTarget(Base):
    __tablename__ = "sales_targets"
    __table_args__ = (Index("ix_sales_targets_shop", "shop_id", "archived_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: "shop", "area" or "cashier".
    scope = Column(String(16), nullable=False)
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id", ondelete="CASCADE"), nullable=True)
    pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=True)
    #: "day" or "event".
    period = Column(String(16), nullable=False, default="day", server_default="day")
    #: A day target for one date only; NULL = every day.
    day = Column(Date, nullable=True)
    event_id = Column(UUID(as_uuid=True), ForeignKey("report_events.id", ondelete="CASCADE"), nullable=True)
    #: Net sales in ₪ (the per-cashier report's net: gross − discounts − refunds).
    amount = Column(Numeric(12, 2), nullable=False)
    #: The trading hours the pace forecast spreads the day over ("HH:MM", local).
    day_start = Column(String(5), nullable=False, default="08:00", server_default="08:00")
    day_end = Column(String(5), nullable=False, default="23:00", server_default="23:00")
    name = Column(String(120), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    archived_at = Column(DateTime(timezone=True), nullable=True)


class SalesTargetHit(Base):
    __tablename__ = "sales_target_hits"
    __table_args__ = (UniqueConstraint("target_id", "period_key", name="uq_sales_target_hit_period"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    target_id = Column(UUID(as_uuid=True), ForeignKey("sales_targets.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    pos_user_id = Column(UUID(as_uuid=True), nullable=True)
    #: The day ("2026-10-09") or the event's id the target was reached in.
    period_key = Column(String(64), nullable=False)
    amount = Column(Numeric(12, 2), nullable=False)
    actual = Column(Numeric(12, 2), nullable=False)
    #: What the target was called when it was reached, for the log ("יעד הסניף").
    label = Column(String(200), nullable=True)
    reached_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
