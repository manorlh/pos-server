"""
The queue worker (§16): lease → checks → attempt row → provider call → result.

* **Lease.** Rows are claimed with `FOR UPDATE SKIP LOCKED` and stamped
  `processing` + `lease_until`, so several API processes can run the worker at once.
* **Checks before every attempt:** TTL, pause, the business validity of the message
  (order not handed over / cancelled, readiness still valid — `VALIDITY_CHECKS`),
  suppression, the live gates (server switch + allow-listed test numbers), rate and
  daily quota.
* **The attempt is committed before the provider is called** and finished after, in a
  new transaction; no provider call happens inside an open DB transaction.
* **Retries** only for outcomes where the request surely did not take effect
  (connect failure, 429, provider busy / no credit): exponential backoff with full
  jitter, bounded by `max_attempts` and the TTL.
* **Unknown outcome** (a timeout after the request left, a 5xx, a crash between the
  call and the result) is never retried blindly: the message goes to
  `unknown_outcome` and is reconciled from delivery reports by its external id.
* **DLR polling** moves `provider_accepted` / `unknown_outcome` on, monotonically:
  duplicate or late reports never move a final message back.
"""
from __future__ import annotations

import hashlib
import logging
import os
import random
import socket
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.club import ClubSuppression
from app.models.notifications import (
    MODE_LIVE,
    MODE_MOCK,
    SENDABLE_STATES,
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
    DeliveryEvent,
    Notification,
    NotificationAttempt,
    NotificationProviderConfig,
)
from app.services.notifications import adapter019 as A
from app.services.notifications import service as S
from app.services.notifications.secrets import resolve_token

logger = logging.getLogger(__name__)

LEASE = timedelta(seconds=60)
PAUSE_RECHECK = timedelta(seconds=60)
BACKOFF_BASE = 30.0
BACKOFF_CAP = 15 * 60.0
#: How long an unknown outcome is reconciled before it is left for an operator.
RECONCILE_WINDOW = timedelta(minutes=30)
#: How long an accepted message's delivery report is polled for.
DLR_WINDOW = timedelta(hours=48)
DLR_POLL_STEPS = (60, 120, 300, 900, 3600)


def next_poll_step(elapsed_seconds: float) -> int:
    """Poll often right after sending, then less: 1 min … 1 h."""
    for limit, step in ((120, 60), (600, 120), (3600, 300), (6 * 3600, 900)):
        if elapsed_seconds < limit:
            return step
    return DLR_POLL_STEPS[-1]

#: event_type → fn(db, notification, now) → reason to cancel, or None (still valid).
VALIDITY_CHECKS: Dict[str, Callable[[Session, Notification, datetime], Optional[str]]] = {}

#: Builds the adapter for a config; tests swap it.
AdapterFactory = Callable[[NotificationProviderConfig, Optional[str]], A.Adapter019]


def default_adapter_factory(config: NotificationProviderConfig, token: Optional[str]) -> A.Adapter019:
    from app.config import get_settings

    return A.Adapter019(
        mode=config.mode,
        username=config.account_username,
        token=token,
        sender=config.sender,
        live_allowed=bool(get_settings().notifications_live_sending_enabled) and config.mode == MODE_LIVE,
    )


def make_owner() -> str:
    return f"{socket.gethostname()[:30]}:{os.getpid()}:{uuid.uuid4().hex[:6]}"


def backoff_seconds(attempt: int, rng: Optional[random.Random] = None) -> float:
    """Exponential with full jitter in [½·d, d]: 30 s, 60 s, 120 s… capped at 15 min."""
    rng = rng or random
    delay = min(BACKOFF_CAP, BACKOFF_BASE * (2 ** max(0, attempt - 1)))
    return delay * (0.5 + rng.random() * 0.5)


def _aw(value: Optional[datetime]) -> Optional[datetime]:
    return S.as_aware(value)


# ── Claim ────────────────────────────────────────────────────────────────────


def claim(db: Session, now: datetime, owner: str, *, limit: int = 20, only_id: Any = None) -> List[uuid.UUID]:
    """Lease up to [limit] sendable messages, most urgent first (OTP, then service…)."""
    q = db.query(Notification.id).filter(
        Notification.state.in_(SENDABLE_STATES), Notification.not_before <= now
    )
    if only_id is not None:
        q = q.filter(Notification.id == only_id)
    ids = [
        r[0]
        for r in q.order_by(Notification.priority.asc(), Notification.not_before.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
        .all()
    ]
    if ids:
        db.query(Notification).filter(Notification.id.in_(ids)).update(
            {
                Notification.state: ST_PROCESSING,
                Notification.lease_owner: owner,
                Notification.lease_until: now + LEASE,
                Notification.updated_at: now,
            },
            synchronize_session=False,
        )
    db.commit()
    return ids


def recover_stale(db: Session, now: datetime) -> int:
    """
    Leases that ran out (a crashed worker). With an attempt started and never finished
    the provider may have the message → unknown_outcome (reconcile, never resend);
    with none, it simply goes back to the queue.
    """
    rows = (
        db.query(Notification)
        .filter(Notification.state == ST_PROCESSING, Notification.lease_until < now)
        .with_for_update(skip_locked=True)
        .all()
    )
    for n in rows:
        open_attempt = (
            db.query(NotificationAttempt)
            .filter(NotificationAttempt.notification_id == n.id, NotificationAttempt.finished_at.is_(None))
            .first()
        )
        if open_attempt is not None:
            open_attempt.finished_at = now
            open_attempt.outcome = "unknown"
            open_attempt.error_class = "crash_reconcile"
            n.state = ST_UNKNOWN_OUTCOME
            n.state_reason = "crash_reconcile"
            n.next_dlr_poll_at = now
            n.secret_vars_ciphertext = None
        else:
            n.state = ST_QUEUED
            n.state_reason = "lease_expired"
        n.lease_owner = None
        n.lease_until = None
        n.updated_at = now
    db.commit()
    return len(rows)


# ── One message ──────────────────────────────────────────────────────────────


def _release(n: Notification, now: datetime, delay: timedelta, reason: str) -> None:
    """Back to the queue without consuming an attempt (pause, rate, quota)."""
    n.state = ST_QUEUED
    n.state_reason = reason
    n.not_before = now + delay
    n.lease_owner = None
    n.lease_until = None
    n.updated_at = now


def _recent_calls(db: Session, config: NotificationProviderConfig, since: datetime) -> int:
    return (
        db.query(NotificationAttempt.id)
        .join(Notification, Notification.id == NotificationAttempt.notification_id)
        .filter(Notification.config_id == config.id, NotificationAttempt.started_at >= since)
        .count()
    )


def _accepted_since(db: Session, config: NotificationProviderConfig, since: datetime) -> int:
    return (
        db.query(Notification.id)
        .filter(Notification.config_id == config.id, Notification.accepted_at >= since)
        .count()
    )


def _alert(config: NotificationProviderConfig, alert: str, now: datetime) -> None:
    config.last_alert = alert[:200]
    config.last_alert_at = now
    if alert == "token_rejected" and not config.paused:
        # Circuit breaker: a rejected token fails every message; stop and tell.
        config.paused = True
        config.paused_reason = "token_rejected"
        config.paused_at = now


def _pre_send_problem(
    db: Session, n: Notification, config: NotificationProviderConfig, recipient: str, now: datetime
) -> Optional[tuple]:
    """(state, reason) to finish with, ("release", delay, reason) to requeue, or None."""
    from app.config import get_settings

    check = VALIDITY_CHECKS.get(n.event_type)
    if check is not None:
        reason = check(db, n, now)
        if reason:
            return (ST_CANCELLED, reason)
    blocked = S.suppression_reason(db, n.tenant_id, n.company_id, n.recipient_hash, n.category)
    if blocked:
        return (ST_SUPPRESSED, blocked)
    allow = set(config.test_numbers or [])
    if n.is_test and recipient not in allow:
        return (ST_SUPPRESSED, "not_on_test_list")
    if config.mode == MODE_LIVE:
        if not get_settings().notifications_live_sending_enabled:
            return (ST_FAILED_PERMANENT, "live_sending_disabled")
        if config.live_restricted_to_test_numbers and recipient not in allow:
            return (ST_SUPPRESSED, "not_on_test_list")
    if config.rate_per_minute and _recent_calls(db, config, now - timedelta(minutes=1)) >= config.rate_per_minute:
        return ("release", timedelta(seconds=20), "rate_limited")
    if config.daily_quota and _accepted_since(db, config, now - timedelta(days=1)) >= config.daily_quota:
        _alert(config, "daily_quota_reached", now)
        return ("release", timedelta(minutes=5), "daily_quota_reached")
    return None


def process_one(
    db: Session,
    notification_id: Any,
    owner: str,
    *,
    now_fn: Callable[[], datetime] = S.utcnow,
    adapter_factory: AdapterFactory = default_adapter_factory,
    rng: Optional[random.Random] = None,
) -> Optional[str]:
    """Send one leased message; returns its state afterwards (None if not ours)."""
    from app.services.notifications import order_ready  # noqa: F401  (registers VALIDITY_CHECKS)

    n = db.get(Notification, notification_id)
    if n is None or n.state != ST_PROCESSING or n.lease_owner != owner:
        db.rollback()
        return None
    now = now_fn()
    if now >= _aw(n.expires_at):
        S.finish(n, ST_EXPIRED, "ttl", now)
        db.commit()
        return n.state
    config = db.get(NotificationProviderConfig, n.config_id) if n.config_id else None
    if config is None:
        S.finish(n, ST_FAILED_PERMANENT, "no_provider_config", now)
        db.commit()
        return n.state
    if config.paused:
        _release(n, now, PAUSE_RECHECK, "paused")
        db.commit()
        return n.state
    recipient = S.recipient_of(n)
    if not recipient:
        S.finish(n, ST_FAILED_PERMANENT, "recipient_unreadable", now)
        db.commit()
        return n.state
    problem = _pre_send_problem(db, n, config, recipient, now)
    if problem is not None:
        if problem[0] == "release":
            _release(n, now, problem[1], problem[2])
        else:
            S.finish(n, problem[0], problem[1], now)
        db.commit()
        return n.state

    token = resolve_token(db, config) if config.mode != MODE_MOCK else None
    adapter = adapter_factory(config, token)
    setup_problem = adapter.config_problem()
    if setup_problem:
        S.finish(n, ST_FAILED_PERMANENT, setup_problem, now)
        db.commit()
        return n.state

    # The attempt exists before the provider is called.
    seq = (n.attempt_count or 0) + 1
    external_id = f"{n.id.hex[:24]}-{seq}"
    attempt = NotificationAttempt(
        id=uuid.uuid4(),
        notification_id=n.id,
        tenant_id=n.tenant_id,
        sequence=seq,
        correlation_id=external_id,
        mode=config.mode,
        started_at=now,
    )
    db.add(attempt)
    n.attempt_count = seq
    n.provider = config.provider
    n.provider_mode = config.mode
    n.provider_external_id = external_id
    n.lease_until = now + LEASE
    n.updated_at = now
    text = S.text_to_send(n)
    attempt_id = attempt.id
    db.commit()

    result = adapter.send(recipient, text, external_id)  # no DB transaction is open here

    done = now_fn()
    n = db.get(Notification, notification_id)
    attempt = db.get(NotificationAttempt, attempt_id)
    config = db.get(NotificationProviderConfig, config.id)
    attempt.finished_at = done
    attempt.outcome = result.outcome
    attempt.error_class = result.error_class
    attempt.provider_status = result.provider_status
    attempt.provider_message = result.message
    attempt.http_status = result.http_status
    n.provider_status = result.provider_status
    if result.alert:
        _alert(config, result.alert, done)

    if result.outcome == A.OUTCOME_ACCEPTED:
        n.state = ST_PROVIDER_ACCEPTED
        n.state_reason = None
        n.provider_ref = result.shipment_id
        n.accepted_at = done
        n.next_dlr_poll_at = done + timedelta(seconds=DLR_POLL_STEPS[0])
        n.secret_vars_ciphertext = None
        n.lease_owner = None
        n.lease_until = None
    elif result.outcome == A.OUTCOME_UNKNOWN:
        n.state = ST_UNKNOWN_OUTCOME
        n.state_reason = result.error_class
        n.next_dlr_poll_at = done + timedelta(seconds=DLR_POLL_STEPS[0])
        n.secret_vars_ciphertext = None
        n.lease_owner = None
        n.lease_until = None
    elif result.outcome == A.OUTCOME_RETRYABLE:
        retry_at = done + timedelta(seconds=backoff_seconds(seq, rng))
        if seq >= (n.max_attempts or 1):
            S.finish(n, ST_FAILED_PERMANENT, f"attempts_exhausted:{result.error_class}", done)
        elif retry_at >= _aw(n.expires_at):
            S.finish(n, ST_EXPIRED, f"ttl_before_retry:{result.error_class}", done)
        else:
            n.state = ST_FAILED_RETRYABLE
            n.state_reason = result.error_class
            n.not_before = retry_at
            n.lease_owner = None
            n.lease_until = None
    else:
        if result.suppressed:
            _record_provider_block(db, n, "all" if result.error_class == "provider_blocked" else "marketing", done)
            S.finish(n, ST_SUPPRESSED, result.error_class, done)
        else:
            S.finish(n, ST_FAILED_PERMANENT, result.error_class, done)
    n.updated_at = done
    db.commit()
    return n.state


def _record_provider_block(db: Session, n: Notification, scope: str, now: datetime) -> None:
    exists = (
        db.query(ClubSuppression.id)
        .filter(
            ClubSuppression.tenant_id == n.tenant_id,
            ClubSuppression.phone_hash == n.recipient_hash,
            ClubSuppression.reason == "provider_blacklist",
            ClubSuppression.scope == scope,
            ClubSuppression.lifted_at.is_(None),
        )
        .first()
    )
    if exists is None:
        db.add(
            ClubSuppression(
                id=uuid.uuid4(),
                tenant_id=n.tenant_id,
                company_id=n.company_id,
                phone_hash=n.recipient_hash,
                channel="sms",
                scope=scope,
                reason="provider_blacklist",
                source="019",
                created_at=now,
            )
        )


# ── Delivery reports ─────────────────────────────────────────────────────────

_RANK = {
    ST_QUEUED: 0, ST_PROCESSING: 0, ST_FAILED_RETRYABLE: 0,
    ST_UNKNOWN_OUTCOME: 1, ST_PROVIDER_ACCEPTED: 2,
    ST_DELIVERED: 3, ST_FAILED_PERMANENT: 3, ST_SUPPRESSED: 3, ST_EXPIRED: 3, ST_CANCELLED: 3,
}


def apply_dlr(db: Session, provider: str, record: A.DlrRecord, now: datetime) -> Optional[str]:
    """
    Record one delivery report and move its message on if — and only if — that is a
    step forward. Duplicates (same id + status + time) are stored once; an old or
    contradicting report after a final state changes nothing. Returns the new state.
    """
    key = hashlib.sha256(
        f"{record.external_id}|{record.status}|{record.event_at.isoformat() if record.event_at else ''}".encode()
    ).hexdigest()[:64]
    if db.query(DeliveryEvent.id).filter(DeliveryEvent.provider == provider, DeliveryEvent.dedupe_key == key).first():
        return None
    n = db.query(Notification).filter(Notification.provider_external_id == record.external_id).first()
    if n is None:
        att = (
            db.query(NotificationAttempt)
            .filter(NotificationAttempt.correlation_id == record.external_id)
            .first()
        )
        n = db.get(Notification, att.notification_id) if att is not None else None
    mapped = A.map_dlr_status(record.status)
    applied = False
    if n is not None and mapped is not None and _RANK.get(mapped, 0) > _RANK.get(n.state, 0):
        applied = True
        if mapped == ST_PROVIDER_ACCEPTED:
            n.state = ST_PROVIDER_ACCEPTED
            n.state_reason = "reconciled_from_dlr"
            n.accepted_at = n.accepted_at or record.event_at or now
        elif mapped == ST_DELIVERED:
            S.finish(n, ST_DELIVERED, None, now)
            n.delivered_at = record.event_at or now
        elif mapped == ST_SUPPRESSED:
            _record_provider_block(db, n, "all" if record.status == "201" else "marketing", now)
            S.finish(n, ST_SUPPRESSED, f"dlr_{record.status}", now)
        else:
            S.finish(n, ST_FAILED_PERMANENT, f"dlr_{record.status}", now)
        n.provider_status = record.status
    if n is not None:
        n.last_dlr_at = now
        n.updated_at = now
    try:
        with db.begin_nested():
            db.add(
                DeliveryEvent(
                    id=uuid.uuid4(),
                    tenant_id=n.tenant_id if n is not None else None,
                    notification_id=n.id if n is not None else None,
                    provider=provider,
                    external_id=record.external_id,
                    shipment_id=record.shipment_id,
                    raw_status=record.status,
                    mapped_state=mapped,
                    applied=applied,
                    event_at=record.event_at,
                    received_at=now,
                    payload=record.payload,
                    dedupe_key=key,
                )
            )
            db.flush()
    except IntegrityError:
        return None
    return n.state if (n is not None and applied) else None


def poll_delivery_reports(
    db: Session,
    now: datetime,
    *,
    adapter_factory: AdapterFactory = default_adapter_factory,
    limit: int = 500,
) -> int:
    """
    Poll 019's DLR report (reports.html) for accepted / unknown messages that are due.
    Unknown outcomes with no report after RECONCILE_WINDOW stay unknown for an
    operator (never resent automatically); accepted ones stop being polled after
    DLR_WINDOW. Returns how many reports changed something.
    """
    due = (
        db.query(Notification)
        .filter(
            Notification.state.in_((ST_PROVIDER_ACCEPTED, ST_UNKNOWN_OUTCOME)),
            Notification.next_dlr_poll_at.isnot(None),
            Notification.next_dlr_poll_at <= now,
            Notification.provider_external_id.isnot(None),
        )
        .order_by(Notification.next_dlr_poll_at.asc())
        .limit(limit)
        .all()
    )
    by_config: Dict[Any, List[Notification]] = {}
    for n in due:
        by_config.setdefault(n.config_id, []).append(n)
    changed = 0
    for config_id, rows in by_config.items():
        config = db.get(NotificationProviderConfig, config_id) if config_id else None
        if config is None or not config.dlr_polling_enabled:
            for n in rows:
                n.next_dlr_poll_at = None
            continue
        token = resolve_token(db, config) if config.mode != MODE_MOCK else None
        adapter = adapter_factory(config, token)
        start = min(_aw(n.created_at) for n in rows) - timedelta(minutes=5)
        ids = [n.provider_external_id for n in rows]
        records = adapter.poll_dlr(ids, start, now)
        for record in records:
            if apply_dlr(db, config.provider, record, now):
                changed += 1
        seen = {r.external_id for r in records}
        for n in rows:
            if n.state not in (ST_PROVIDER_ACCEPTED, ST_UNKNOWN_OUTCOME):
                continue
            since = _aw(n.accepted_at or n.updated_at or n.created_at)
            window = RECONCILE_WINDOW if n.state == ST_UNKNOWN_OUTCOME else DLR_WINDOW
            if now - since >= window and n.provider_external_id not in seen:
                n.next_dlr_poll_at = None
                if n.state == ST_UNKNOWN_OUTCOME:
                    n.state_reason = "no_report_operator_decision"
                continue
            n.next_dlr_poll_at = now + timedelta(seconds=next_poll_step((now - since).total_seconds()))
    db.commit()
    return changed


# ── Cycle & background thread ────────────────────────────────────────────────


def run_cycle(
    session_factory: Callable[[], Session],
    *,
    owner: Optional[str] = None,
    now_fn: Callable[[], datetime] = S.utcnow,
    adapter_factory: AdapterFactory = default_adapter_factory,
    poll_dlr: bool = True,
    batch: int = 20,
) -> Dict[str, int]:
    """One pass: stale leases, the outbox, a batch of sends, delivery reports."""
    from app.services.notifications import outbox as O

    owner = owner or make_owner()
    stats = {"recovered": 0, "events": 0, "sent": 0, "dlr": 0}
    db = session_factory()
    try:
        stats["recovered"] = recover_stale(db, now_fn())
        stats["events"] = O.consume_batch(db, now_fn(), owner)
        for nid in claim(db, now_fn(), owner, limit=batch):
            try:
                process_one(db, nid, owner, now_fn=now_fn, adapter_factory=adapter_factory)
                stats["sent"] += 1
            except Exception:  # noqa: BLE001 - one bad row must not stop the queue
                db.rollback()
                logger.exception("notification %s failed in the worker", nid)
        if poll_dlr:
            stats["dlr"] = poll_delivery_reports(db, now_fn(), adapter_factory=adapter_factory)
    finally:
        db.close()
    return stats


def process_now(session_factory: Callable[[], Session], notification_id: Any) -> Optional[str]:
    """Send one queued message right away (an OTP), if no worker took it already."""
    owner = make_owner()
    db = session_factory()
    try:
        ids = claim(db, S.utcnow(), owner, limit=1, only_id=notification_id)
        if not ids:
            return None
        return process_one(db, ids[0], owner)
    except Exception:  # noqa: BLE001 - the background worker will pick it up
        db.rollback()
        logger.exception("immediate send of %s failed; left for the worker", notification_id)
        return None
    finally:
        db.close()


_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def start_background_worker(session_factory: Callable[[], Session], *, interval: float = 2.0) -> None:
    """A daemon thread running `run_cycle` every [interval] s (DLR every ~60 s)."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    owner = make_owner()

    def loop() -> None:
        cycles = 0
        while not _stop.is_set():
            try:
                run_cycle(session_factory, owner=owner, poll_dlr=(cycles % 30 == 0))
            except Exception:  # noqa: BLE001 - keep the loop alive; no personal data logged
                logger.exception("notifications worker cycle failed")
            cycles += 1
            _stop.wait(interval)

    _stop.clear()
    _thread = threading.Thread(target=loop, name="notifications-worker", daemon=True)
    _thread.start()


def stop_background_worker() -> None:
    _stop.set()


__all__ = [
    "VALIDITY_CHECKS", "claim", "recover_stale", "process_one", "apply_dlr", "poll_delivery_reports",
    "run_cycle", "process_now", "start_background_worker", "stop_background_worker", "backoff_seconds",
]
