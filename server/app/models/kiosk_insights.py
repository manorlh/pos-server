"""
"ביצועי קיוסקים" — the kiosk's anonymous funnel (docs/SPEC_KIOSK_INSIGHTS.md).

Every customer session on a self-order kiosk (the first tap on the attract screen → paid, or
left) is reported by the kiosk as small events, batched through its outbox
(`POST /sync/{machine_id}/kiosk/events`), idempotent by (machine, session, seq). Nothing
personal: no names, no phones, no card data — product and rule ids, steps, amounts, reasons.

* `kiosk_events` — the events as the kiosk sent them (the detail behind the report and the
  device-health drawer's "last events").
* `kiosk_sessions` — one row per session, folded from its events as they arrive: where it
  got to, how it ended, how long it took, what the basket was, the upsell windows and the
  payment attempts. The report aggregates these rows with SQL, never the raw events.
"""
import uuid

from sqlalchemy import BigInteger, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base
from app.models.kiosk import KioskJSON


class KioskSession(Base):
    """One customer session on a kiosk, folded from its events. Upserted by (machine, session id)."""

    __tablename__ = "kiosk_sessions"
    __table_args__ = (
        UniqueConstraint("machine_id", "session_id", name="uq_kiosk_sessions_machine_session"),
        Index("ix_kiosk_sessions_machine_started", "machine_id", "started_at"),
        Index("ix_kiosk_sessions_shop_started", "shop_id", "started_at"),
        Index("ix_kiosk_sessions_tenant_started", "tenant_id", "started_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    #: The kiosk's own id for the session (a UUID it made at the first tap).
    session_id = Column(String(64), nullable=False)
    #: The first tap (the kiosk's clock, as sent).
    started_at = Column(DateTime(timezone=True), nullable=False)
    ended_at = Column(DateTime(timezone=True), nullable=True)
    #: paid | abandoned | timeout | cancelled | help | reset — null while open (or never told).
    end_reason = Column(String(16), nullable=True)
    #: The step the customer was on last (`STEPS`): where an abandoned session was left.
    last_step = Column(String(16), nullable=True)
    #: The furthest step reached, as its rank in the funnel (`STEP_RANK`).
    max_rank = Column(Integer, nullable=False, default=0, server_default="0")
    #: The steps reached, comma-joined in the order first seen ("service,catalog,item,…").
    steps = Column(String(200), nullable=True)
    #: take_away | eat_in, once chosen.
    service = Column(String(16), nullable=True)
    paid = Column(Boolean, nullable=False, default=False, server_default="false")
    #: First tap → payment approved (the kiosk's own monotonic clock), ms.
    order_ms = Column(BigInteger, nullable=True)
    #: First tap → the session's end, ms.
    duration_ms = Column(BigInteger, nullable=True)
    #: The basket when the session ended (or was paid), agorot, without the tip.
    basket_agorot = Column(BigInteger, nullable=True)
    items = Column(Integer, nullable=True)
    tip_agorot = Column(BigInteger, nullable=True)
    upsell_shown = Column(Integer, nullable=False, default=0, server_default="0")
    upsell_accepted = Column(Integer, nullable=False, default=0, server_default="0")
    upsell_declined = Column(Integer, nullable=False, default=0, server_default="0")
    pay_attempts = Column(Integer, nullable=False, default=0, server_default="0")
    pay_failures = Column(Integer, nullable=False, default=0, server_default="0")
    #: "בקשת עזרה" during the session.
    help = Column(Boolean, nullable=False, default=False, server_default="false")
    #: The basket changed at the pre-payment check (price, promotion, availability).
    basket_changed = Column(Boolean, nullable=False, default=False, server_default="false")
    #: The highest seq folded so far (events arrive in batches, possibly out of order).
    last_seq = Column(Integer, nullable=False, default=0, server_default="0")
    #: The kiosk's platform: android | windows.
    platform = Column(String(16), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class KioskEvent(Base):
    """One funnel event of a kiosk session, as sent. Unique by (machine, session, seq): a re-send is a no-op."""

    __tablename__ = "kiosk_events"
    __table_args__ = (
        UniqueConstraint("machine_id", "session_id", "seq", name="uq_kiosk_events_machine_session_seq"),
        Index("ix_kiosk_events_machine_at", "machine_id", "at"),
        Index("ix_kiosk_events_tenant_type_at", "tenant_id", "type", "at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(64), nullable=False)
    seq = Column(Integer, nullable=False)
    #: EVENT_TYPES (app/services/kiosk_funnel.py).
    type = Column(String(16), nullable=False)
    #: The screen / step it happened on (STEPS), when it has one.
    step = Column(String(16), nullable=True)
    #: When it happened (the kiosk's clock).
    at = Column(DateTime(timezone=True), nullable=False)
    #: Since the session's first tap (the kiosk's monotonic clock), ms.
    elapsed_ms = Column(BigInteger, nullable=True)
    #: The event's small detail (ids, amounts, reasons) — never anything personal.
    data = Column(KioskJSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
