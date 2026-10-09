"""
"יומן חריגות" and "התראות SMS על חריגות" (app/services/exception_alerts).

* `exception_log` — the exceptions log: ONE row per exception event, whatever detected it
  (a document, a shift close, a till event, a Z, a failed payment, a refused document, a
  kiosk / device alert…). Filled automatically from every detection point
  (app/services/exception_alerts/sources.py), idempotent per source event (`dedupe_key`,
  unique). A manager marks a row "טופל" (`acknowledged_*` + a note). Rows are never
  deleted; the detection itself stays where it was (e.g. `audit_exceptions`).
* `exception_alert_rules` — SMS alert rules per company (or one shop of it): which kinds,
  thresholds, recipients, quiet hours, a per-rule rate limit with a digest, on/off.
* `exception_alert_dispatches` — every SMS attempt a rule made: sent / dry-run / queued /
  failed / suppressed (rate limit, quiet hours, stale), with the rule, the entry, the
  masked recipient and the text. Never the full phone number (only a keyed hash + mask).
* `exception_alert_rule_changes` — who changed a rule, when, before → after (append only).
* "התראות לטלפון" (Web Push) extends the same three: a rule with `channel = "push"` is one
  dashboard user's preferences (alert types, shops / events, quiet hours, rate limit, digest),
  its dispatches go to the devices in `push_subscriptions` (app/services/exception_alerts/push.py).
"""
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

SEVERITIES = ("low", "medium", "high")

# Channels of a rule and of a dispatch.
CHANNEL_SMS = "sms"
CHANNEL_PUSH = "push"
CHANNELS = (CHANNEL_SMS, CHANNEL_PUSH)

# Dispatch kinds and statuses.
DISPATCH_ALERT = "alert"
DISPATCH_DIGEST = "digest"
DISPATCH_TEST = "test"

ST_DRY_RUN = "dry_run"
ST_QUEUED = "queued"
ST_SENT = "sent"
ST_FAILED = "failed"
ST_SUPPRESSED_RATE = "suppressed_rate_limit"
ST_SUPPRESSED_QUIET = "suppressed_quiet_hours"
ST_SUPPRESSED_STALE = "suppressed_stale"
#: Statuses that count as "a message went out" (for the rate limit).
DELIVERED_STATUSES = (ST_DRY_RUN, ST_QUEUED, ST_SENT)
SUPPRESSED_STATUSES = (ST_SUPPRESSED_RATE, ST_SUPPRESSED_QUIET)
DISPATCH_STATUSES = (
    ST_DRY_RUN, ST_QUEUED, ST_SENT, ST_FAILED, ST_SUPPRESSED_RATE, ST_SUPPRESSED_QUIET, ST_SUPPRESSED_STALE,
)


class ExceptionLogEntry(Base):
    __tablename__ = "exception_log"
    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_exception_log_dedupe_key"),
        UniqueConstraint("short_code", name="uq_exception_log_short_code"),
        Index("ix_exception_log_tenant_occurred", "tenant_id", "occurred_at"),
        Index("ix_exception_log_shop_occurred", "shop_id", "occurred_at"),
        Index("ix_exception_log_machine_occurred", "machine_id", "occurred_at"),
        Index("ix_exception_log_kind", "kind"),
        Index("ix_exception_log_audit_exception", "audit_exception_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    #: Not foreign keys: the log outlives a shop / till that is removed.
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), nullable=True)

    #: The exception's kind (`app/services/exception_alerts/catalog.py`), e.g. "refund".
    kind = Column(String(40), nullable=False)
    severity = Column(String(16), nullable=False, default="medium", server_default="medium")
    #: Where it was detected: audit_exception | failed_payment | document_refusal | battery …
    source = Column(String(32), nullable=False)
    #: The source row's id (as text).
    source_id = Column(String(100), nullable=True)
    #: `<source>:<source key>` — one log row per source event.
    dedupe_key = Column(String(200), nullable=False)
    #: A short public code for the SMS link (`<dashboard>/x/<code>`).
    short_code = Column(String(16), nullable=False)

    #: The till user (`pos_users.id` as the till sent it) and their name when recorded.
    pos_user_id = Column(String(100), nullable=True, index=True)
    pos_user_name = Column(String(200), nullable=True)

    #: The money it is about (the refund, the discount, the difference…), in shekels.
    amount = Column(Numeric(12, 2), nullable=True)
    #: The measured value (a percent, minutes…) and the threshold it was compared with.
    value = Column(Numeric(12, 2), nullable=True)
    threshold = Column(Numeric(12, 2), nullable=True)
    #: A short Hebrew line for the list and the SMS, when the source has one.
    summary = Column(String(300), nullable=True)
    details = Column(JSONB, nullable=True)

    #: What it is about, when known: a document, a shift, a Z, a till event, the exception.
    transaction_id = Column(UUID(as_uuid=True), nullable=True)
    shift_id = Column(UUID(as_uuid=True), nullable=True)
    z_report_id = Column(UUID(as_uuid=True), nullable=True)
    till_event_id = Column(UUID(as_uuid=True), nullable=True)
    audit_exception_id = Column(UUID(as_uuid=True), nullable=True)

    occurred_at = Column(DateTime(timezone=True), nullable=False)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: True for rows written by the backfill (never alerted).
    backfilled = Column(Boolean, nullable=False, default=False, server_default="false")

    #: "טופל": who, when, and the note.
    acknowledged_at = Column(DateTime(timezone=True), nullable=True, index=True)
    acknowledged_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    note = Column(Text, nullable=True)


class ExceptionAlertRule(Base):
    __tablename__ = "exception_alert_rules"
    __table_args__ = (
        Index("ix_exception_alert_rules_scope", "tenant_id", "company_id", "shop_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: The company it watches (and its sub-companies); `shop_id` narrows it to one shop.
    #: Null for a phone (push) rule: it follows its owner's reach (app/services/exception_alerts/push.py).
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    name = Column(String(120), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")

    #: "sms" (the company's rules, phone numbers) | "push" ("התראות לטלפון": one rule per
    #: dashboard user and tenant — its owner's preferences, delivered to their subscribed devices).
    channel = Column(String(12), nullable=False, default=CHANNEL_SMS, server_default=CHANNEL_SMS)
    #: A push rule's owner (and only recipient).
    owner_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    #: A push rule: which alert types (push.CATEGORIES keys) — instead of `kinds`.
    categories = Column(JSONB, nullable=True)
    #: A push rule: only these shops / these events (ids as strings); null or empty = everything
    #: its owner may see. Both set: either matches.
    shop_ids = Column(JSONB, nullable=True)
    event_ids = Column(JSONB, nullable=True)

    #: The kinds it fires on; empty = every kind (narrowed by `min_severity`).
    kinds = Column(JSONB, nullable=False, default=list, server_default="[]")
    min_severity = Column(String(16), nullable=True)
    #: |amount| ≥ this (₪), for kinds that carry an amount.
    min_amount = Column(Numeric(12, 2), nullable=True)
    #: value ≥ this (%), for kinds measured in percent (a discount, a tip).
    min_percent = Column(Numeric(7, 2), nullable=True)
    #: "N in M minutes": fire only when the N-th matching exception within M minutes
    #: arrives, counted per `count_scope` (machine | employee | shop).
    count_threshold = Column(Integer, nullable=True)
    count_window_minutes = Column(Integer, nullable=True)
    count_scope = Column(String(16), nullable=False, default="machine", server_default="machine")

    #: `[{"phone": "+9725…", "label": "…", "userId": "…"}]` — Israeli mobiles, E.164.
    recipients = Column(JSONB, nullable=False, default=list, server_default="[]")
    #: Local "HH:MM" (the tenant's timezone); from > to wraps midnight. Both null = none.
    quiet_from = Column(String(5), nullable=True)
    quiet_to = Column(String(5), nullable=True)
    #: At most one message per this many minutes for this rule (0 = no limit).
    rate_limit_minutes = Column(Integer, nullable=False, default=10, server_default="10")
    #: What the limit / the quiet hours held back is summed up in one message afterwards.
    digest_enabled = Column(Boolean, nullable=False, default=True, server_default="true")

    deleted_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    updated_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ExceptionAlertDispatch(Base):
    __tablename__ = "exception_alert_dispatches"
    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_exception_alert_dispatches_dedupe_key"),
        Index("ix_exception_alert_dispatches_rule_created", "rule_id", "created_at"),
        Index("ix_exception_alert_dispatches_entry", "entry_id"),
        Index("ix_exception_alert_dispatches_digest", "digest_id"),
        # The digest pass, every minute: held-back rows not summed up yet.
        Index("ix_exception_alert_dispatches_pending", "status", "digest_id"),
        # "התראות לטלפון": one user's history.
        Index("ix_exception_alert_dispatches_user_created", "user_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    rule_id = Column(UUID(as_uuid=True), ForeignKey("exception_alert_rules.id"), nullable=True)
    #: "sms" | "push". A push dispatch: the user it went to and the device (subscription).
    channel = Column(String(12), nullable=False, default=CHANNEL_SMS, server_default=CHANNEL_SMS)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    subscription_id = Column(UUID(as_uuid=True), nullable=True)
    #: The log entry it is about (null for a digest or a test message).
    entry_id = Column(UUID(as_uuid=True), ForeignKey("exception_log.id"), nullable=True)
    #: alert | digest | test
    kind = Column(String(12), nullable=False)
    #: dry_run | queued | sent | failed | suppressed_rate_limit | suppressed_quiet_hours | suppressed_stale
    status = Column(String(32), nullable=False)
    reason = Column(String(120), nullable=True)
    #: dry_run | notifications (the 019 queue); and its mode (dry_run / mock / test / live).
    provider = Column(String(24), nullable=True)
    provider_mode = Column(String(16), nullable=True)
    #: The message in the notification queue (`notifications.id`), when handed to it.
    notification_id = Column(UUID(as_uuid=True), nullable=True)
    recipient_hash = Column(String(64), nullable=False)
    recipient_masked = Column(String(32), nullable=False)
    recipient_label = Column(String(120), nullable=True)
    text = Column(Text, nullable=True)
    dedupe_key = Column(String(200), nullable=False)
    #: A suppressed one: the digest that summed it up. A digest: how many it summed up.
    digest_id = Column(UUID(as_uuid=True), nullable=True)
    digest_count = Column(Integer, nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    sent_at = Column(DateTime(timezone=True), nullable=True)


class PushSubscription(Base):
    """
    "התראות לטלפון": one browser / phone a dashboard user subscribed for Web Push (the
    dashboard is a PWA). The endpoint and its keys come from the browser's PushManager; they
    are the device's address, not a secret of ours. A device that signs in as someone else
    moves to that user. The push service answering 404 / 410 (unsubscribed, expired) turns
    it off (`disabled_at`); it is never sent to again.
    """

    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint("endpoint_hash", name="uq_push_subscriptions_endpoint_hash"),
        Index("ix_push_subscriptions_user", "user_id", "disabled_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    #: The tenant it was subscribed from (informative; the rules decide what it receives).
    tenant_id = Column(UUID(as_uuid=True), nullable=True)
    endpoint = Column(Text, nullable=False)
    #: SHA-256 of the endpoint (unique; an endpoint may be longer than an index allows).
    endpoint_hash = Column(String(64), nullable=False)
    p256dh = Column(String(200), nullable=False)
    auth = Column(String(100), nullable=False)
    #: "Chrome · Android" — what the person sees in their devices list.
    label = Column(String(120), nullable=True)
    user_agent = Column(String(300), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    last_success_at = Column(DateTime(timezone=True), nullable=True)
    last_failure_at = Column(DateTime(timezone=True), nullable=True)
    failure_count = Column(Integer, nullable=False, default=0, server_default="0")
    last_error = Column(String(200), nullable=True)
    disabled_at = Column(DateTime(timezone=True), nullable=True)


class ExceptionAlertRuleChange(Base):
    """Who changed an SMS alert rule, when, and from what to what. Never updated or deleted."""

    __tablename__ = "exception_alert_rule_changes"
    __table_args__ = (
        Index("ix_exception_alert_rule_changes_rule", "rule_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    rule_id = Column(UUID(as_uuid=True), nullable=False)
    #: create | update | delete | test
    action = Column(String(16), nullable=False)
    old_value = Column(JSONB, nullable=True)
    new_value = Column(JSONB, nullable=True)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    user_email = Column(String(255), nullable=True)
    user_role = Column(String(32), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


def _install_session_hooks() -> None:
    """
    Every new exception, whatever wrote it, reaches the log: the ORM session reports the
    source rows it flushed, and once the transaction commits they are recorded (and
    alerted on) in a session of their own — never failing the request that wrote them
    (app/services/exception_alerts/hooks.py).
    """
    from sqlalchemy import event
    from sqlalchemy.orm import Session

    def after_flush(session, flush_context):
        from app.services.exception_alerts import hooks

        hooks.after_flush(session)

    def after_commit(session):
        from app.services.exception_alerts import hooks

        hooks.after_commit(session)

    def after_rollback(session):
        from app.services.exception_alerts import hooks

        hooks.after_rollback(session)

    if not event.contains(Session, "after_flush", after_flush):
        event.listen(Session, "after_flush", after_flush)
        event.listen(Session, "after_commit", after_commit)
        event.listen(Session, "after_rollback", after_rollback)


_install_session_hooks()

# The phone alerts' sender installs its own Session.after_commit / after_rollback hooks when its
# module is imported (app/services/exception_alerts/push.py). Imported here, with these models,
# so they are in place before any session commits — never first imported from inside a commit's
# after_commit (hooks -> engine -> push), where SQLAlchemy refuses a listener added to the event
# being dispatched ("deque mutated during iteration", raised from session.commit() after the
# commit went through — a till Z whose figures differ did that when nothing had imported push
# yet). The classes above are defined, so push's own import of them resolves.
from app.services.exception_alerts import push as _push_session_hooks  # noqa: E402,F401
