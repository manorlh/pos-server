"""
The notification service ("שירות הודעות", docs/SPEC_NOTIFICATIONS_CLUB.md).

* `NotificationProviderConfig` — per company (or tenant-wide): which provider (019), the
  mode (mock / test / live), the sender, limits, pause, the allow-listed test numbers.
  The provider token is NOT here: it is a write-only secret in
  `payment_integration_secrets` (key `sms019Token`, app/services/notifications/secrets.py).
* `NotificationTemplate` — versioned bodies, Draft → Approved → Active → Archived.
* `Notification` — one message to one recipient: the durable queue row. The recipient
  is stored encrypted (`recipient_ciphertext`) with a keyed hash for dedupe/search and a
  masked form for display; the rendered text is kept as a snapshot with secret variables
  (an OTP code) blanked.
* `NotificationAttempt` — one provider call: written *before* the call, finished after.
* `DeliveryEvent` — a delivery report (DLR) as received, sanitised, deduplicated.
* `Campaign` / `CampaignRecipient` — **P1 skeleton only**: drafts can be stored, nothing
  sends them (the API answers 409 `campaigns_disabled`).
"""
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

# ── Vocabulary ────────────────────────────────────────────────────────────────

CATEGORY_SERVICE = "service"
CATEGORY_AUTHENTICATION = "authentication"
CATEGORY_MARKETING = "marketing"
CATEGORY_INTERNAL = "internal_operations"
CATEGORIES = (CATEGORY_SERVICE, CATEGORY_AUTHENTICATION, CATEGORY_MARKETING, CATEGORY_INTERNAL)

CHANNEL_SMS = "sms"

# Notification states (§16). "provider_accepted" is NOT "delivered".
ST_QUEUED = "queued"
ST_PROCESSING = "processing"
ST_PROVIDER_ACCEPTED = "provider_accepted"
ST_DELIVERED = "delivered"
ST_FAILED_RETRYABLE = "failed_retryable"
ST_FAILED_PERMANENT = "failed_permanent"
ST_UNKNOWN_OUTCOME = "unknown_outcome"
ST_SUPPRESSED = "suppressed"
ST_EXPIRED = "expired"
ST_CANCELLED = "cancelled"
STATES = (
    ST_QUEUED, ST_PROCESSING, ST_PROVIDER_ACCEPTED, ST_DELIVERED, ST_FAILED_RETRYABLE,
    ST_FAILED_PERMANENT, ST_UNKNOWN_OUTCOME, ST_SUPPRESSED, ST_EXPIRED, ST_CANCELLED,
)
#: States a worker may still pick up.
SENDABLE_STATES = (ST_QUEUED, ST_FAILED_RETRYABLE)
#: States nothing moves a notification out of (a DLR may still move accepted/unknown on).
FINAL_STATES = (ST_DELIVERED, ST_FAILED_PERMANENT, ST_SUPPRESSED, ST_EXPIRED, ST_CANCELLED)

PROVIDER_019 = "019"
MODE_MOCK = "mock"
MODE_TEST = "test"
MODE_LIVE = "live"
MODES = (MODE_MOCK, MODE_TEST, MODE_LIVE)

TEMPLATE_DRAFT = "draft"
TEMPLATE_APPROVED = "approved"
TEMPLATE_ACTIVE = "active"
TEMPLATE_ARCHIVED = "archived"
TEMPLATE_STATUSES = (TEMPLATE_DRAFT, TEMPLATE_APPROVED, TEMPLATE_ACTIVE, TEMPLATE_ARCHIVED)


class NotificationProviderConfig(Base):
    __tablename__ = "notification_provider_configs"
    __table_args__ = (
        UniqueConstraint("tenant_id", "scope_key", name="uq_notification_provider_configs_scope"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    #: The company this account serves; null = every company of the tenant.
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True, index=True)
    #: `str(company_id)` or "tenant" — the unique key (NULLs never collide in a UNIQUE).
    scope_key = Column(String(40), nullable=False)
    provider = Column(String(16), nullable=False, default=PROVIDER_019, server_default=PROVIDER_019)
    #: "mock" (no network at all), "test" (019's /api/test, sends nothing) or "live".
    mode = Column(String(8), nullable=False, default=MODE_MOCK, server_default=MODE_MOCK)
    #: 019 account username (an identifier, not a secret).
    account_username = Column(String(100), nullable=True)
    #: 019 `source`: up to 11 English letters / digits, approved on the 019 account.
    sender = Column(String(11), nullable=True)
    #: Shown inside messages as {brand_name}; defaults to the company name.
    brand_name = Column(String(60), nullable=True)
    paused = Column(Boolean, nullable=False, default=False, server_default="false")
    paused_reason = Column(String(200), nullable=True)
    paused_at = Column(DateTime(timezone=True), nullable=True)
    #: Max provider calls per minute and accepted messages per local day (0 = no cap).
    rate_per_minute = Column(Integer, nullable=False, default=30, server_default="30")
    daily_quota = Column(Integer, nullable=False, default=500, server_default="500")
    #: Alert when the day's count passes this many (0 = never).
    alert_threshold = Column(Integer, nullable=False, default=400, server_default="400")
    #: Allow-listed E.164 numbers for "send test" and for live smoke tests.
    test_numbers = Column(JSONB, nullable=False, default=list, server_default="[]")
    #: In live mode, send ONLY to `test_numbers` (pilot / smoke). On by default; turning
    #: it off is its own explicit action.
    live_restricted_to_test_numbers = Column(Boolean, nullable=False, default=True, server_default="true")
    #: Business events switched on, e.g. {"OrderReady": true}.
    enabled_events = Column(JSONB, nullable=False, default=dict, server_default="{}")
    order_ready_ttl_minutes = Column(Integer, nullable=False, default=10, server_default="10")
    dlr_polling_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    #: Last token / credit problem the provider reported (an alert for the dashboard).
    last_alert = Column(String(200), nullable=True)
    last_alert_at = Column(DateTime(timezone=True), nullable=True)
    updated_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class NotificationTemplate(Base):
    __tablename__ = "notification_templates"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "scope_key", "event_type", "channel", "language", "version",
            name="uq_notification_templates_version",
        ),
        Index("ix_notification_templates_lookup", "tenant_id", "event_type", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    scope_key = Column(String(40), nullable=False)
    category = Column(String(24), nullable=False)
    channel = Column(String(8), nullable=False, default=CHANNEL_SMS, server_default=CHANNEL_SMS)
    language = Column(String(8), nullable=False, default="he", server_default="he")
    #: "OrderReady" | "OtpCode" | "ClubWelcome" | …
    event_type = Column(String(40), nullable=False)
    version = Column(Integer, nullable=False, default=1)
    status = Column(String(12), nullable=False, default=TEMPLATE_DRAFT, server_default=TEMPLATE_DRAFT)
    name = Column(String(120), nullable=True)
    body = Column(Text, nullable=False)
    #: Used when an optional variable of `body` has no value (e.g. no first name).
    fallback_body = Column(Text, nullable=True)
    allowed_variables = Column(JSONB, nullable=False, default=list, server_default="[]")
    created_by = Column(UUID(as_uuid=True), nullable=True)
    approved_by = Column(UUID(as_uuid=True), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    activated_at = Column(DateTime(timezone=True), nullable=True)
    archived_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        # §15: tenant + order/group + event + recipient + channel is one message.
        UniqueConstraint("tenant_id", "dedupe_key", name="uq_notifications_tenant_dedupe"),
        Index("ix_notifications_queue", "state", "priority", "not_before"),
        Index("ix_notifications_tenant_created", "tenant_id", "created_at"),
        Index("ix_notifications_aggregate", "tenant_id", "aggregate_ref"),
        Index("ix_notifications_recipient", "tenant_id", "recipient_hash"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    config_id = Column(UUID(as_uuid=True), ForeignKey("notification_provider_configs.id"), nullable=True)
    category = Column(String(24), nullable=False)
    channel = Column(String(8), nullable=False, default=CHANNEL_SMS, server_default=CHANNEL_SMS)
    event_type = Column(String(40), nullable=False)
    #: The outbox row this came from, if any.
    source_event_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    #: The order / fulfillment group / membership this is about (free text id).
    aggregate_ref = Column(String(100), nullable=True)
    #: Short public label of the aggregate for the log ("הזמנה 42").
    context_label = Column(String(120), nullable=True)

    recipient_ciphertext = Column(Text, nullable=False)
    recipient_hash = Column(String(64), nullable=False)
    recipient_masked = Column(String(32), nullable=False)

    template_id = Column(UUID(as_uuid=True), nullable=True)
    template_key = Column(String(80), nullable=True)
    template_version = Column(Integer, nullable=True)
    #: The text as it will be / was sent, with secret variables blanked ("••••••").
    body_snapshot = Column(Text, nullable=False)
    #: Encrypted JSON of the secret variables (an OTP code) — wiped once final.
    secret_vars_ciphertext = Column(Text, nullable=True)

    dedupe_key = Column(String(300), nullable=False)
    #: 0 = authentication, 10 = service, 50 = internal, 100 = marketing.
    priority = Column(Integer, nullable=False, default=10)
    state = Column(String(20), nullable=False, default=ST_QUEUED, server_default=ST_QUEUED)
    state_reason = Column(String(120), nullable=True)
    is_test = Column(Boolean, nullable=False, default=False, server_default="false")

    not_before = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False)
    lease_owner = Column(String(80), nullable=True)
    lease_until = Column(DateTime(timezone=True), nullable=True)
    attempt_count = Column(Integer, nullable=False, default=0, server_default="0")
    max_attempts = Column(Integer, nullable=False, default=5, server_default="5")

    provider = Column(String(16), nullable=True)
    provider_mode = Column(String(8), nullable=True)
    #: 019 `shipment_id` of the accepted request.
    provider_ref = Column(String(64), nullable=True)
    #: The per-recipient id we sent (019 `phone id=` attribute) — the DLR lookup key.
    provider_external_id = Column(String(64), nullable=True, index=True)
    provider_status = Column(String(16), nullable=True)

    resend_of_id = Column(UUID(as_uuid=True), nullable=True)
    resend_reason = Column(String(200), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)

    accepted_at = Column(DateTime(timezone=True), nullable=True)
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    final_at = Column(DateTime(timezone=True), nullable=True)
    last_dlr_at = Column(DateTime(timezone=True), nullable=True)
    next_dlr_poll_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class NotificationAttempt(Base):
    __tablename__ = "notification_attempts"
    __table_args__ = (
        UniqueConstraint("notification_id", "sequence", name="uq_notification_attempts_seq"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    notification_id = Column(
        UUID(as_uuid=True), ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False, index=True
    )
    tenant_id = Column(UUID(as_uuid=True), nullable=False)
    sequence = Column(Integer, nullable=False)
    #: The id sent to the provider for this attempt (also the DLR key).
    correlation_id = Column(String(64), nullable=False)
    mode = Column(String(8), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=False)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    #: "accepted" | "rejected" | "retryable" | "unknown" | "skipped"
    outcome = Column(String(16), nullable=True)
    error_class = Column(String(40), nullable=True)
    provider_status = Column(String(16), nullable=True)
    #: The provider's message, sanitised (no token, no number, no text).
    provider_message = Column(String(200), nullable=True)
    http_status = Column(Integer, nullable=True)


class DeliveryEvent(Base):
    __tablename__ = "notification_delivery_events"
    __table_args__ = (
        UniqueConstraint("provider", "dedupe_key", name="uq_notification_delivery_events_dedupe"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    notification_id = Column(
        UUID(as_uuid=True), ForeignKey("notifications.id", ondelete="CASCADE"), nullable=True, index=True
    )
    provider = Column(String(16), nullable=False)
    external_id = Column(String(64), nullable=True, index=True)
    shipment_id = Column(String(64), nullable=True)
    raw_status = Column(String(16), nullable=True)
    #: The notification state this report maps to.
    mapped_state = Column(String(20), nullable=True)
    #: Whether the report changed the notification (an old / duplicate one does not).
    applied = Column(Boolean, nullable=False, default=False, server_default="false")
    event_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: The report minus the phone number.
    payload = Column(JSONB, nullable=False, default=dict, server_default="{}")
    dedupe_key = Column(String(128), nullable=False)


class Campaign(Base):
    """P1 skeleton: a marketing campaign draft. Nothing sends it in P0."""

    __tablename__ = "notification_campaigns"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    name = Column(String(120), nullable=False)
    #: draft | approved | scheduled | running | paused | completed | cancelled
    status = Column(String(16), nullable=False, default="draft", server_default="draft")
    template_id = Column(UUID(as_uuid=True), nullable=True)
    audience = Column(JSONB, nullable=False, default=dict, server_default="{}")
    shop_ids = Column(JSONB, nullable=False, default=list, server_default="[]")
    scheduled_at = Column(DateTime(timezone=True), nullable=True)
    frequency_cap_days = Column(Integer, nullable=True)
    budget_messages = Column(Integer, nullable=True)
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_by = Column(UUID(as_uuid=True), nullable=True)
    approved_by = Column(UUID(as_uuid=True), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class CampaignRecipient(Base):
    """P1 skeleton: a campaign's frozen audience row."""

    __tablename__ = "notification_campaign_recipients"
    __table_args__ = (
        UniqueConstraint("campaign_id", "membership_id", name="uq_campaign_recipients_member"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(
        UUID(as_uuid=True), ForeignKey("notification_campaigns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    tenant_id = Column(UUID(as_uuid=True), nullable=False)
    membership_id = Column(UUID(as_uuid=True), nullable=False)
    notification_id = Column(UUID(as_uuid=True), nullable=True)
    #: pending | sent | skipped_consent | skipped_suppressed | skipped_cap
    status = Column(String(24), nullable=False, default="pending", server_default="pending")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
