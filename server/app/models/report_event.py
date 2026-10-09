"""
Temporary events ("אירועים") — tills grouped at REPORT level only (docs/SPEC_EVENTS.md).

A shop with many tills splits them into events: a name, a window (`starts_at` →
`ends_at`) and a set of the shop's tills. Nothing on a till, a document, a shift or a Z
changes — an event is a lens over the documents that already exist.

* `report_events` — the event, its thresholds for the insight rules, and once the
  customer confirms it ("נותן תוקף") the frozen report (`snapshot`).
* `report_event_machines` — which tills are in it. `released_at` is set when the event
  is confirmed: the till leaves the event (the snapshot keeps the list) and may join a
  new one. Only rows with `released_at IS NULL` take part in the overlap rule.
"""
import uuid

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base

EVENT_DRAFT = "draft"
EVENT_CONFIRMED = "confirmed"
EVENT_STATUSES = (EVENT_DRAFT, EVENT_CONFIRMED)


class ReportEvent(Base):
    __tablename__ = "report_events"
    __table_args__ = (
        Index("ix_report_events_shop_starts", "shop_id", "starts_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False)

    name = Column(String(120), nullable=False)
    #: UTC; `ends_at` is exclusive. Entered as a local date + hour in `timezone`.
    starts_at = Column(DateTime(timezone=True), nullable=False)
    ends_at = Column(DateTime(timezone=True), nullable=False)
    timezone = Column(String(64), nullable=False, default="Asia/Jerusalem", server_default="Asia/Jerusalem")

    #: draft → confirmed (`EVENT_STATUSES`).
    status = Column(String(16), nullable=False, default=EVENT_DRAFT, server_default=EVENT_DRAFT)
    producer_name = Column(String(120), nullable=True)
    notes = Column(Text, nullable=True)
    #: The insight rules' thresholds; missing keys take the defaults
    #: (app/services/report_events/rules.py `DEFAULT_THRESHOLDS`).
    thresholds = Column(JSONB, nullable=True)

    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    confirmed_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    confirmed_at = Column(DateTime(timezone=True), nullable=True)
    confirm_note = Column(Text, nullable=True)
    #: The report as it was at confirmation. Later syncs or edits never change it.
    snapshot = Column(JSONB, nullable=True)

    #: "מצב אירוע חי": the sales target typed on the live screen (₪, net), when no targets
    #: module supplies one (app/services/report_events/targets.py). Not part of the report.
    live_target = Column(Numeric(12, 2), nullable=True)
    #: "עמדת מפיק": what the event's producer sees beyond the sales —
    #: `{"settlementEnabled": bool, "batchIds": [...], "productionPrices": {batchId: ₪}}`
    #: (app/services/report_events/production.py).
    producer_settings = Column(JSONB, nullable=True)

    machines = relationship(
        "ReportEventMachine",
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ProducerEventGrant(Base):
    """
    "עמדת מפיק": one event opened to one producer user (role PRODUCER_VIEW). Revoking keeps the
    row (`revoked_at`) for the history. A producer sees an event only through an active grant.
    """

    __tablename__ = "producer_event_grants"
    __table_args__ = (
        UniqueConstraint("user_id", "event_id", name="uq_producer_event_grants_user_event"),
        Index("ix_producer_event_grants_event", "event_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    event_id = Column(UUID(as_uuid=True), ForeignKey("report_events.id", ondelete="CASCADE"), nullable=False)
    #: The name the owner gave the invitee (shown in the event's list), and who invited.
    display_name = Column(String(120), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    revoked_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)


class ReportEventMachine(Base):
    __tablename__ = "report_event_machines"
    __table_args__ = (
        UniqueConstraint("event_id", "machine_id", name="uq_report_event_machines_event_machine"),
        Index("ix_report_event_machines_machine", "machine_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id = Column(
        UUID(as_uuid=True), ForeignKey("report_events.id", ondelete="CASCADE"), nullable=False
    )
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    #: Set when the event is confirmed: the till left the event. NULL = still assigned.
    released_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    event = relationship("ReportEvent", back_populates="machines")
