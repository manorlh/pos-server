"""
The SMS provider for exception alerts — an abstraction with two implementations:

* `DryRunSmsProvider` — **the default** (setting `EXCEPTION_ALERTS_SMS_PROVIDER`, unset =
  "dry_run"), in development, in tests and anywhere nobody chose otherwise. Nothing leaves
  the server: the message is recorded as `dry_run` in the exceptions log (the dispatch
  row keeps its text) and a line goes to the process log with the number MASKED. The last
  messages are kept in memory (`outbox`) for tests and a developer's eyes.
* `NotificationQueueSmsProvider` — ADAPTER to the provider the code base already has:
  the notification service's 019 queue (app/services/notifications). Used ONLY when
  `EXCEPTION_ALERTS_SMS_PROVIDER=notifications`. Even then it never calls 019 itself: it
  enqueues an internal "ExceptionAlert" message, and the queue's worker sends it under
  the company's own provider account and ITS gates — `mock` (no network), `test`
  (019's /api/test, sends nothing) or `live` (only with NOTIFICATIONS_LIVE_SENDING_ENABLED
  on, and by default only to the account's allow-listed test numbers).

Tests swap the provider with `set_provider_override`; nothing here opens a socket.
"""
from __future__ import annotations

import logging
import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Deque, Dict, List, Optional, Protocol

from sqlalchemy.orm import Session

from app.models.exception_alerts import ST_DRY_RUN, ST_FAILED, ST_QUEUED
from app.services.notifications.phone import mask_phone

logger = logging.getLogger(__name__)

PROVIDER_DRY_RUN = "dry_run"
PROVIDER_NOTIFICATIONS = "notifications"
#: The notification-queue event for an exception alert (app/services/notifications/templates.py).
EVENT_TYPE = "ExceptionAlert"
#: An alert older than this in the queue is no longer worth sending.
QUEUE_TTL = timedelta(minutes=30)


@dataclass
class SmsResult:
    #: dry_run | queued | sent | failed
    status: str
    reason: Optional[str] = None
    provider: str = PROVIDER_DRY_RUN
    #: dry_run, or the 019 account's mode (mock / test / live).
    mode: Optional[str] = None
    notification_id: Any = None


class SmsProvider(Protocol):
    name: str

    def describe(self, db: Session, tenant_id: Any, company_id: Any) -> Dict[str, Any]:
        """What the dashboard shows about where the messages go (never a secret)."""

    def send(
        self,
        db: Session,
        *,
        tenant_id: Any,
        company_id: Any,
        shop_id: Any,
        to_e164: str,
        text: str,
        dedupe_key: str,
        context_label: Optional[str] = None,
        user_id: Any = None,
        now: Optional[datetime] = None,
    ) -> SmsResult:
        """Send (or record) one message to one number. Never raises for a provider problem."""


class DryRunSmsProvider:
    """Records instead of sending. Nothing leaves the process."""

    name = PROVIDER_DRY_RUN

    def __init__(self, keep: int = 200) -> None:
        self._lock = threading.Lock()
        self.outbox: Deque[Dict[str, Any]] = deque(maxlen=keep)

    def describe(self, db: Session, tenant_id: Any, company_id: Any) -> Dict[str, Any]:
        return {"provider": self.name, "dryRun": True, "mode": PROVIDER_DRY_RUN, "liveSendingEnabled": False}

    def send(self, db: Session, *, tenant_id: Any, company_id: Any, shop_id: Any, to_e164: str, text: str,
             dedupe_key: str, context_label: Optional[str] = None, user_id: Any = None,
             now: Optional[datetime] = None) -> SmsResult:
        with self._lock:
            self.outbox.append({
                "at": (now or datetime.now(timezone.utc)).isoformat(),
                "to": to_e164,
                "text": text,
                "dedupeKey": dedupe_key,
                "tenantId": str(tenant_id) if tenant_id else None,
                "companyId": str(company_id) if company_id else None,
            })
        logger.info("exception alert SMS (dry run, not sent) to %s: %d chars", mask_phone(to_e164), len(text))
        return SmsResult(status=ST_DRY_RUN, provider=self.name, mode=PROVIDER_DRY_RUN)

    def sent(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self.outbox)

    def clear(self) -> None:
        with self._lock:
            self.outbox.clear()


class NotificationQueueSmsProvider:
    """
    ADAPTER — the 019 SMS provider through the notification service's queue. Disabled
    unless `EXCEPTION_ALERTS_SMS_PROVIDER=notifications`; see the module docstring for
    the gates it inherits. Returns `queued` (the queue's worker sends it) or `failed`.
    """

    name = PROVIDER_NOTIFICATIONS

    def describe(self, db: Session, tenant_id: Any, company_id: Any) -> Dict[str, Any]:
        from app.config import get_settings
        from app.services.notifications import service as S

        config = S.get_config(db, tenant_id, company_id)
        return {
            "provider": self.name,
            "dryRun": config is None or config.mode == "mock",
            "mode": config.mode if config is not None else None,
            "configured": config is not None,
            "paused": bool(config.paused) if config is not None else False,
            "liveSendingEnabled": bool(get_settings().notifications_live_sending_enabled),
            "liveRestrictedToTestNumbers": bool(config.live_restricted_to_test_numbers) if config is not None else None,
        }

    def send(self, db: Session, *, tenant_id: Any, company_id: Any, shop_id: Any, to_e164: str, text: str,
             dedupe_key: str, context_label: Optional[str] = None, user_id: Any = None,
             now: Optional[datetime] = None) -> SmsResult:
        from app.models.notifications import ST_SUPPRESSED
        from app.services.notifications import service as S
        from app.services.notifications.templates import TemplateError

        try:
            result = S.enqueue(
                db,
                tenant_id=tenant_id,
                company_id=company_id,
                shop_id=shop_id,
                event_type=EVENT_TYPE,
                recipient_e164=to_e164,
                variables={"alert_text": text},
                dedupe_key=f"exc-alert:{dedupe_key}"[:300],
                ttl=QUEUE_TTL,
                context_label=context_label,
                created_by=user_id,
                now=now,
            )
        except TemplateError as exc:
            return SmsResult(status=ST_FAILED, reason=f"template:{exc.code}", provider=self.name)
        n = result.notification
        if n.state == ST_SUPPRESSED:
            return SmsResult(status=ST_FAILED, reason=n.state_reason or "suppressed", provider=self.name,
                             mode=n.provider_mode, notification_id=n.id)
        return SmsResult(status=ST_QUEUED, provider=self.name, mode=n.provider_mode, notification_id=n.id)


#: The process's one dry-run provider (its outbox is what tests and developers read).
DRY_RUN = DryRunSmsProvider()
_override: Optional[SmsProvider] = None


def set_provider_override(provider: Optional[SmsProvider]) -> None:
    """Tests: use this provider instead of the configured one (None = back to the setting)."""
    global _override
    _override = provider


def configured_name() -> str:
    from app.config import get_settings

    name = (getattr(get_settings(), "exception_alerts_sms_provider", "") or "").strip().lower()
    return PROVIDER_NOTIFICATIONS if name == PROVIDER_NOTIFICATIONS else PROVIDER_DRY_RUN


def get_provider() -> SmsProvider:
    if _override is not None:
        return _override
    if configured_name() == PROVIDER_NOTIFICATIONS:
        return NotificationQueueSmsProvider()
    return DRY_RUN
