"""
"מצב אירוע חי" — live push over Ably, when Ably is configured (`ABLY_API_KEY`); the screen
polls otherwise (and keeps a slow poll even with push, so a lost message costs seconds).

* Channel per event: `dash:{tenant}:event:{event}` — a dashboard channel, apart from the
  tills' `pos:{tenant}:{machine}` ones.
* `token_for(event)` — a subscribe-only Ably token for that one channel (an hour), handed to
  a dashboard user who may read the event (the router checks).
* `notify_machine_synced(tenant, machine)` — called where a till's documents land
  (app/services/transactions.publish_transactions_synced): a "tick" to every event the till
  is in that is live now (or ended in the last few minutes). The message carries no figures:
  the screen refetches its live view, which is scoped like every other read.

Never raises: Ably being down or unconfigured never touches a sync.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

TOKEN_TTL_MS = 60 * 60 * 1000
#: A document that lands just after the end still moves the final figures.
AFTER_END = timedelta(minutes=15)


def channel_for(tenant_id: Any, event_id: Any) -> str:
    return f"dash:{tenant_id}:event:{event_id}"


def enabled() -> bool:
    from app.services import ably_notify

    return ably_notify.is_enabled()


def token_for(event) -> Dict[str, Any]:
    """`{enabled, channel, token, expiresAt}` — `enabled: false` without Ably (or when it refuses)."""
    from app.services import ably_notify

    channel = channel_for(event.tenant_id, event.id)
    client = ably_notify._rest() if ably_notify.is_enabled() else None
    if client is None:
        return {"enabled": False, "channel": channel}
    try:
        details = client.auth.request_token({"capability": {channel: ["subscribe"]}, "ttl": TOKEN_TTL_MS})
    except Exception:  # noqa: BLE001 - the screen falls back to polling
        logger.exception("ably token for event %s failed", event.id)
        return {"enabled": False, "channel": channel}
    expires = getattr(details, "expires", None)
    expires_at = (
        datetime.fromtimestamp(expires / 1000, tz=timezone.utc).isoformat() if isinstance(expires, (int, float)) else None
    )
    return {"enabled": True, "channel": channel, "token": getattr(details, "token", None), "expiresAt": expires_at}


def live_event_ids(db, tenant_id: Any, machine_id: Any, now: Optional[datetime] = None) -> List[Any]:
    from app.models.report_event import ReportEvent, ReportEventMachine

    now = now or datetime.now(timezone.utc)
    rows = (
        db.query(ReportEvent.id)
        .join(ReportEventMachine, ReportEventMachine.event_id == ReportEvent.id)
        .filter(
            ReportEvent.tenant_id == tenant_id,
            ReportEventMachine.machine_id == machine_id,
            ReportEvent.starts_at <= now,
            ReportEvent.ends_at >= now - AFTER_END,
        )
        .all()
    )
    return [r[0] for r in rows]


def notify_machine_synced(tenant_id: Any, machine_id: Any, count: int = 0) -> int:
    """Tick every live event of the till. Returns how many channels were told (0 without Ably)."""
    if not tenant_id or not enabled():
        return 0
    from app.database import SessionLocal
    from app.services import ably_notify

    client = ably_notify._rest()
    if client is None:
        return 0
    db = SessionLocal()
    try:
        ids = live_event_ids(db, tenant_id, machine_id)
    except Exception:  # noqa: BLE001
        logger.exception("live push: events of machine %s", machine_id)
        return 0
    finally:
        db.close()
    told = 0
    for event_id in ids:
        try:
            client.channels.get(channel_for(tenant_id, event_id)).publish(
                "tick", {"machineId": str(machine_id), "count": int(count or 0),
                         "serverTime": datetime.now(timezone.utc).isoformat()},
            )
            told += 1
        except Exception:  # noqa: BLE001
            logger.exception("live push: publish to event %s failed", event_id)
    return told
