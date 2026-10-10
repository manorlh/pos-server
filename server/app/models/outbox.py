"""
The transactional outbox ("OutboxEvent", docs/SPEC_NOTIFICATIONS_CLUB.md §3).

A business transition (KDS "מוכן לאיסוף", a handover, a cancellation) writes its own row
here **in the same database transaction** as the transition itself, through
`app.services.outbox.emit_event`. Consumers (the notification service first) read the
rows afterwards, under a lease, so a crash between "the order is ready" and "an SMS is
queued" can never lose the message nor send it twice.

The row is deliberately small: ids, the event's type and version, and a minimal payload.
Personal data a consumer needs (the order's contact phone) may ride in the payload only
until the consumer has taken it; the consumer then masks it in place
(`payload_redacted_at`).
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

#: Processing states of an outbox row.
OUTBOX_PENDING = "pending"
OUTBOX_PROCESSING = "processing"
OUTBOX_PROCESSED = "processed"
OUTBOX_FAILED = "failed"
OUTBOX_STATES = (OUTBOX_PENDING, OUTBOX_PROCESSING, OUTBOX_PROCESSED, OUTBOX_FAILED)


class OutboxEvent(Base):
    __tablename__ = "outbox_events"
    __table_args__ = (
        # The business key: the same transition reported twice (a retry, a double tap,
        # two KDS screens) is one event. `dedupe_key` is built by `emit_event` from
        # type + aggregate + aggregate version unless the caller gives its own.
        UniqueConstraint("tenant_id", "dedupe_key", name="uq_outbox_events_tenant_dedupe"),
        Index("ix_outbox_events_pending", "state", "available_at"),
        Index("ix_outbox_events_aggregate", "tenant_id", "aggregate_type", "aggregate_id", "occurred_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    #: "order" | "fulfillment_group" | … — what `aggregate_id` names.
    aggregate_type = Column(String(40), nullable=False)
    aggregate_id = Column(String(100), nullable=False)
    #: The aggregate's version after the transition (monotonic per aggregate).
    aggregate_version = Column(Integer, nullable=False, default=1, server_default="1")
    #: "ReadyForPickup" | "ReadyRevoked" | "HandedOver" | "OrderCancelled" | …
    event_type = Column(String(60), nullable=False)
    dedupe_key = Column(String(300), nullable=False)
    occurred_at = Column(DateTime(timezone=True), nullable=False)
    payload = Column(JSONB, nullable=False, default=dict, server_default="{}")
    #: When the consumer masked the personal data the payload carried.
    payload_redacted_at = Column(DateTime(timezone=True), nullable=True)

    state = Column(String(16), nullable=False, default=OUTBOX_PENDING, server_default=OUTBOX_PENDING)
    available_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    lease_owner = Column(String(80), nullable=True)
    lease_until = Column(DateTime(timezone=True), nullable=True)
    attempts = Column(Integer, nullable=False, default=0, server_default="0")
    processed_at = Column(DateTime(timezone=True), nullable=True)
    #: What the consumer did with it ("queued:<notification id>", "skipped:no_contact"…).
    result = Column(String(200), nullable=True)
    last_error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
