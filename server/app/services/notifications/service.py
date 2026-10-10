"""
NotificationService (§13–§16): the one way anything in the system sends a customer
message. Business code never calls the provider — it enqueues here; the worker sends.

* `enqueue` — idempotent on the business dedupe key (unique per tenant): the same key
  twice is one message. Renders the template now and keeps the snapshot (secret
  variables masked; the full text encrypted until the message is final).
* `get_config` — the provider account serving a company: its own, else its nearest
  ancestor's, else the tenant-wide one.
* `suppression_reason` — opt-outs and provider blocks, checked at enqueue AND at send.
* `resend` — a new, explicit message (permission, reason, rate limit) — never a retry.
* `cancel` / `cancel_for_aggregate` — pending messages stop; sent ones cannot be
  un-sent, so the caller is told how many already went (a staff alert).
* `short_status` — "לא נדרש / בתור / התקבל אצל הספק / נמסר / כשל" for KDS / Expo.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.club import ClubSuppression
from app.models.company import Company
from app.models.notifications import (
    CATEGORY_AUTHENTICATION,
    CATEGORY_INTERNAL,
    CATEGORY_MARKETING,
    CATEGORY_SERVICE,
    CHANNEL_SMS,
    MODE_MOCK,
    ST_CANCELLED,
    ST_DELIVERED,
    ST_EXPIRED,
    ST_FAILED_PERMANENT,
    ST_FAILED_RETRYABLE,
    ST_PROCESSING,
    ST_PROVIDER_ACCEPTED,
    ST_QUEUED,
    ST_SUPPRESSED,
    ST_UNKNOWN_OUTCOME,
    Notification,
    NotificationProviderConfig,
)
from app.services.notifications import templates as T
from app.services.notifications.crypto import decrypt_json, decrypt_text, encrypt_json, encrypt_text
from app.services.notifications.phone import mask_phone, phone_hash

PRIORITY = {CATEGORY_AUTHENTICATION: 0, CATEGORY_SERVICE: 10, CATEGORY_INTERNAL: 50, CATEGORY_MARKETING: 100}
MAX_ATTEMPTS = {CATEGORY_AUTHENTICATION: 3, CATEGORY_SERVICE: 5, CATEGORY_INTERNAL: 5, CATEGORY_MARKETING: 3}

#: Manual resend limits (§15: "פעולה חדשה מפורשת עם הרשאה, סיבה והגבלת קצב").
RESEND_MAX = 3
RESEND_MIN_GAP = timedelta(seconds=60)
RESENDABLE_STATES = (ST_PROVIDER_ACCEPTED, ST_DELIVERED, ST_FAILED_PERMANENT, ST_UNKNOWN_OUTCOME, ST_EXPIRED)


class NotificationError(ValueError):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_aware(value: Optional[datetime]) -> Optional[datetime]:
    """SQLite hands back naive datetimes; everything here is UTC."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


# ── Provider account ─────────────────────────────────────────────────────────


def get_config(db: Session, tenant_id: Any, company_id: Any) -> Optional[NotificationProviderConfig]:
    from app.services.company_hierarchy import ancestor_company_ids

    keys: List[str] = []
    if company_id:
        keys.append(str(company_id))
        keys.extend(str(c) for c in ancestor_company_ids(db, company_id))
    keys.append("tenant")
    rows = (
        db.query(NotificationProviderConfig)
        .filter(
            NotificationProviderConfig.tenant_id == tenant_id,
            NotificationProviderConfig.scope_key.in_(keys),
        )
        .all()
    )
    by_key = {r.scope_key: r for r in rows}
    for key in keys:
        if key in by_key:
            return by_key[key]
    return None


def brand_name_for(db: Session, config: Optional[NotificationProviderConfig], company_id: Any) -> str:
    if config is not None and config.brand_name:
        return config.brand_name
    if company_id:
        company = db.get(Company, company_id)
        if company is not None and company.name:
            return company.name
    return "Runner"


# ── Suppression ──────────────────────────────────────────────────────────────


def suppression_reason(db: Session, tenant_id: Any, company_id: Any, hashed: str, category: str) -> Optional[str]:
    """Why this number must not get [category] now, or None."""
    q = db.query(ClubSuppression).filter(
        ClubSuppression.tenant_id == tenant_id,
        ClubSuppression.phone_hash == hashed,
        ClubSuppression.channel == CHANNEL_SMS,
        ClubSuppression.lifted_at.is_(None),
    )
    if company_id:
        q = q.filter(or_(ClubSuppression.company_id.is_(None), ClubSuppression.company_id == company_id))
    rows = q.all()
    if any(r.scope == "all" for r in rows):
        return "provider_blocked"
    if category == CATEGORY_MARKETING and rows:
        return "unsubscribed"
    return None


# ── Enqueue ──────────────────────────────────────────────────────────────────


@dataclass
class EnqueueResult:
    notification: Notification
    created: bool


def find_by_dedupe(db: Session, tenant_id: Any, dedupe_key: str) -> Optional[Notification]:
    return (
        db.query(Notification)
        .filter(Notification.tenant_id == tenant_id, Notification.dedupe_key == dedupe_key)
        .first()
    )


def enqueue(
    db: Session,
    *,
    tenant_id: Any,
    company_id: Any,
    shop_id: Any = None,
    event_type: str,
    recipient_e164: str,
    variables: Dict[str, Any],
    dedupe_key: str,
    ttl: timedelta,
    expires_from: Optional[datetime] = None,
    aggregate_ref: Optional[str] = None,
    context_label: Optional[str] = None,
    source_event_id: Any = None,
    is_test: bool = False,
    created_by: Any = None,
    config: Optional[NotificationProviderConfig] = None,
    now: Optional[datetime] = None,
    body_override: Optional[str] = None,
    resend_of_id: Any = None,
    resend_reason: Optional[str] = None,
) -> EnqueueResult:
    """
    Queue one message. Idempotent on (tenant, dedupe_key): an existing row is returned
    unchanged (`created=False`). Raises TemplateError when the values cannot render.
    Caller commits.
    """
    now = now or utcnow()
    existing = find_by_dedupe(db, tenant_id, dedupe_key)
    if existing is not None:
        return EnqueueResult(existing, False)

    spec = T.event_spec(event_type)
    category = spec.category
    config = config if config is not None else get_config(db, tenant_id, company_id)
    if body_override is not None:
        rendered_text, snapshot = body_override, body_override
        template_row, version, key = None, None, f"{event_type}:resend"
    else:
        template_row, body, fallback, version, key = T.resolve_template(db, tenant_id, company_id, event_type)
        rendered = T.render(event_type, body, variables, fallback=fallback)
        rendered_text, snapshot = rendered.text, rendered.snapshot

    hashed = phone_hash(recipient_e164)
    state, reason = ST_QUEUED, None
    if config is None:
        state, reason = ST_SUPPRESSED, "no_provider_config"
    else:
        blocked = suppression_reason(db, tenant_id, company_id, hashed, category)
        if blocked:
            state, reason = ST_SUPPRESSED, blocked
    final_at = now if state != ST_QUEUED else None

    row = Notification(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=company_id,
        shop_id=shop_id,
        config_id=config.id if config is not None else None,
        category=category,
        channel=CHANNEL_SMS,
        event_type=event_type,
        source_event_id=source_event_id,
        aggregate_ref=(aggregate_ref or None) and str(aggregate_ref)[:100],
        context_label=(context_label or None) and str(context_label)[:120],
        recipient_ciphertext=encrypt_text(recipient_e164),
        recipient_hash=hashed,
        recipient_masked=mask_phone(recipient_e164),
        template_id=template_row.id if template_row is not None else None,
        template_key=key,
        template_version=version,
        body_snapshot=snapshot,
        # The full text only when it differs from the snapshot (a secret inside).
        secret_vars_ciphertext=encrypt_json({"text": rendered_text}) if rendered_text != snapshot and state == ST_QUEUED else None,
        dedupe_key=dedupe_key[:300],
        priority=PRIORITY.get(category, 10),
        state=state,
        state_reason=reason,
        is_test=is_test,
        not_before=now,
        expires_at=(expires_from or now) + ttl,
        max_attempts=MAX_ATTEMPTS.get(category, 5),
        provider=config.provider if config is not None else None,
        provider_mode=config.mode if config is not None else None,
        created_by=created_by,
        resend_of_id=resend_of_id,
        resend_reason=resend_reason,
        final_at=final_at,
        created_at=now,
        updated_at=now,
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        # A parallel enqueue of the same key won the race: that one is the message.
        existing = find_by_dedupe(db, tenant_id, dedupe_key)
        if existing is None:
            raise
        return EnqueueResult(existing, False)
    return EnqueueResult(row, True)


def text_to_send(n: Notification) -> str:
    """The exact text for the provider: the encrypted full text, else the snapshot."""
    secret = decrypt_json(n.secret_vars_ciphertext) if n.secret_vars_ciphertext else None
    if isinstance(secret, dict) and isinstance(secret.get("text"), str):
        return secret["text"]
    return n.body_snapshot


def recipient_of(n: Notification) -> Optional[str]:
    return decrypt_text(n.recipient_ciphertext)


# ── Operator actions ─────────────────────────────────────────────────────────


def resend(db: Session, original: Notification, *, user_id: Any, reason: str, now: Optional[datetime] = None) -> Notification:
    """
    An explicit new message with the same text to the same number. Refused for OTP
    (a new code is the sign-up page's own resend), without a reason, more than
    RESEND_MAX times, or within RESEND_MIN_GAP of the previous one.
    """
    now = now or utcnow()
    reason = (reason or "").strip()
    if not reason:
        raise NotificationError("reason_required", 422)
    if original.category == CATEGORY_AUTHENTICATION:
        raise NotificationError("resend_not_allowed_for_otp")
    if original.state not in RESENDABLE_STATES:
        raise NotificationError("resend_not_allowed_in_state")
    root_id = original.resend_of_id or original.id
    previous = (
        db.query(Notification)
        .filter(Notification.tenant_id == original.tenant_id, Notification.resend_of_id == root_id)
        .order_by(Notification.created_at.desc())
        .all()
    )
    if len(previous) >= RESEND_MAX:
        raise NotificationError("resend_limit_reached", 429)
    if previous and now - as_aware(previous[0].created_at) < RESEND_MIN_GAP:
        raise NotificationError("resend_too_soon", 429)
    recipient = recipient_of(original)
    if not recipient:
        raise NotificationError("recipient_unreadable")
    root = db.get(Notification, root_id) or original
    result = enqueue(
        db,
        tenant_id=original.tenant_id,
        company_id=original.company_id,
        shop_id=original.shop_id,
        event_type=original.event_type,
        recipient_e164=recipient,
        variables={},
        dedupe_key=f"{root.dedupe_key}:resend:{len(previous) + 1}",
        ttl=timedelta(minutes=30),
        aggregate_ref=original.aggregate_ref,
        context_label=original.context_label,
        created_by=user_id,
        now=now,
        body_override=original.body_snapshot,
        resend_of_id=root_id,
        resend_reason=reason[:200],
    )
    return result.notification


def finish(n: Notification, state: str, reason: Optional[str], now: datetime) -> None:
    n.state = state
    n.state_reason = (reason or None) and reason[:120]
    n.lease_owner = None
    n.lease_until = None
    n.updated_at = now
    if state in (ST_DELIVERED, ST_FAILED_PERMANENT, ST_SUPPRESSED, ST_EXPIRED, ST_CANCELLED):
        n.final_at = now
        n.secret_vars_ciphertext = None
        n.next_dlr_poll_at = None


def cancel(db: Session, n: Notification, *, reason: str, now: Optional[datetime] = None) -> Notification:
    now = now or utcnow()
    if n.state == ST_CANCELLED:
        return n
    if n.state not in (ST_QUEUED, ST_FAILED_RETRYABLE):
        raise NotificationError("not_cancellable")
    finish(n, ST_CANCELLED, reason, now)
    return n


@dataclass
class AggregateCancel:
    cancelled: int
    already_sent: int
    in_flight: int


def cancel_for_aggregate(
    db: Session,
    tenant_id: Any,
    aggregate_ref: str,
    *,
    event_types: Iterable[str],
    reason: str,
    now: Optional[datetime] = None,
) -> AggregateCancel:
    """
    Stop the pending messages about an order (handed over, cancelled, ready revoked).
    A message already sent cannot be taken back — `already_sent` tells the caller to
    alert the staff (§15). One in flight is re-checked by the worker before the call.
    """
    now = now or utcnow()
    rows = (
        db.query(Notification)
        .filter(
            Notification.tenant_id == tenant_id,
            Notification.aggregate_ref == str(aggregate_ref)[:100],
            Notification.event_type.in_(list(event_types)),
        )
        .all()
    )
    out = AggregateCancel(0, 0, 0)
    for n in rows:
        if n.state in (ST_QUEUED, ST_FAILED_RETRYABLE):
            finish(n, ST_CANCELLED, reason, now)
            out.cancelled += 1
        elif n.state == ST_PROCESSING:
            out.in_flight += 1
        elif n.state in (ST_PROVIDER_ACCEPTED, ST_DELIVERED, ST_UNKNOWN_OUTCOME):
            out.already_sent += 1
    return out


# ── Short status for KDS / Expo ──────────────────────────────────────────────

SHORT_LABELS = {
    "not_required": "לא נדרש",
    "queued": "בתור",
    "accepted": "התקבל אצל הספק",
    "delivered": "נמסר",
    "failed": "כשל",
    "checking": "בבירור",
}
_SHORT = {
    ST_QUEUED: "queued",
    ST_PROCESSING: "queued",
    ST_FAILED_RETRYABLE: "queued",
    ST_PROVIDER_ACCEPTED: "accepted",
    ST_UNKNOWN_OUTCOME: "checking",
    ST_DELIVERED: "delivered",
    ST_FAILED_PERMANENT: "failed",
    ST_SUPPRESSED: "failed",
    ST_EXPIRED: "failed",
    ST_CANCELLED: "not_required",
}


def short_status(db: Session, tenant_id: Any, refs: Iterable[str], *, event_type: str = "OrderReady") -> Dict[str, Dict[str, str]]:
    """Per order / group ref: `{code, label}` of its latest message. A failure is not an order failure."""
    wanted = [str(r)[:100] for r in refs if r]
    out = {r: {"code": "not_required", "label": SHORT_LABELS["not_required"]} for r in wanted}
    if not wanted:
        return out
    rows = (
        db.query(Notification.aggregate_ref, Notification.state, Notification.created_at)
        .filter(
            Notification.tenant_id == tenant_id,
            Notification.aggregate_ref.in_(wanted),
            Notification.event_type == event_type,
        )
        .order_by(Notification.created_at.asc())
        .all()
    )
    for ref, state, _created in rows:
        code = _SHORT.get(state, "queued")
        out[ref] = {"code": code, "label": SHORT_LABELS[code]}
    return out


def default_config(tenant_id: Any, company_id: Any) -> NotificationProviderConfig:
    """A new account row: mock mode, paused off, OrderReady on, nothing live."""
    return NotificationProviderConfig(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=company_id,
        scope_key=T.scope_key(company_id),
        mode=MODE_MOCK,
        sender=None,
        enabled_events={"OrderReady": True, "OtpCode": True},
        test_numbers=[],
    )
