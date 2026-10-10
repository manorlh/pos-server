"""
Consuming `outbox_events` (the notification service's side of the outbox).

Rows are leased (`FOR UPDATE SKIP LOCKED`), handled one by one in their own transaction,
and marked `processed` with a short `result`. A handler that raises is retried with
backoff (5 times), then the row is `failed` — never silently dropped. Rows are taken in
`occurred_at` order, so "ready" and "handed over" of one order are seen in order.

Handlers are registered per event type in `HANDLERS` (app/services/notifications/order_ready.py
registers the fulfillment ones). Unknown types are marked processed as "ignored".
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List

from sqlalchemy.orm import Session

from app.models.outbox import (
    OUTBOX_FAILED,
    OUTBOX_PENDING,
    OUTBOX_PROCESSED,
    OUTBOX_PROCESSING,
    OutboxEvent,
)

logger = logging.getLogger(__name__)

LEASE = timedelta(seconds=60)
MAX_ATTEMPTS = 5

#: event_type → handler(db, event, now) → result text (≤ 200 chars).
HANDLERS: Dict[str, Callable[[Session, OutboxEvent, datetime], str]] = {}


def _load_handlers() -> None:
    # Registration lives next to the handlers; importing is enough.
    from app.services.notifications import order_ready  # noqa: F401


def recover_stale_events(db: Session, now: datetime) -> int:
    n = (
        db.query(OutboxEvent)
        .filter(OutboxEvent.state == OUTBOX_PROCESSING, OutboxEvent.lease_until < now)
        .update(
            {OutboxEvent.state: OUTBOX_PENDING, OutboxEvent.lease_owner: None, OutboxEvent.lease_until: None},
            synchronize_session=False,
        )
    )
    db.commit()
    return n


def claim_events(db: Session, now: datetime, owner: str, limit: int = 50) -> List[Any]:
    ids = [
        r[0]
        for r in db.query(OutboxEvent.id)
        .filter(OutboxEvent.state == OUTBOX_PENDING, OutboxEvent.available_at <= now)
        .order_by(OutboxEvent.occurred_at.asc(), OutboxEvent.aggregate_version.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
        .all()
    ]
    if ids:
        db.query(OutboxEvent).filter(OutboxEvent.id.in_(ids)).update(
            {
                OutboxEvent.state: OUTBOX_PROCESSING,
                OutboxEvent.lease_owner: owner,
                OutboxEvent.lease_until: now + LEASE,
            },
            synchronize_session=False,
        )
    db.commit()
    return ids


def handle_event(db: Session, event_id: Any, owner: str, now: datetime) -> str:
    _load_handlers()
    event = db.get(OutboxEvent, event_id)
    if event is None or event.state != OUTBOX_PROCESSING or event.lease_owner != owner:
        db.rollback()
        return "not_ours"
    handler = HANDLERS.get(event.event_type)
    try:
        result = handler(db, event, now) if handler is not None else "ignored:no_consumer"
        event = db.get(OutboxEvent, event_id)
        event.state = OUTBOX_PROCESSED
        event.result = (result or "")[:200]
        event.processed_at = now
        event.lease_owner = None
        event.lease_until = None
        event.attempts = (event.attempts or 0) + 1
        db.commit()
        return event.result
    except Exception as exc:  # noqa: BLE001 - retried below; the message stays in the outbox
        db.rollback()
        event = db.get(OutboxEvent, event_id)
        event.attempts = (event.attempts or 0) + 1
        event.last_error = type(exc).__name__[:200]
        event.lease_owner = None
        event.lease_until = None
        if event.attempts >= MAX_ATTEMPTS:
            event.state = OUTBOX_FAILED
        else:
            event.state = OUTBOX_PENDING
            event.available_at = now + timedelta(seconds=30 * (2 ** (event.attempts - 1)))
        db.commit()
        logger.warning("outbox event %s (%s) failed: %s", event_id, event.event_type, type(exc).__name__)
        return "error"


def consume_batch(db: Session, now: datetime, owner: str, limit: int = 50) -> int:
    recover_stale_events(db, now)
    done = 0
    for event_id in claim_events(db, now, owner, limit):
        handle_event(db, event_id, owner, now)
        done += 1
    return done
