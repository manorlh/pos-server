"""
Emitting outbox events — the producer side of `outbox_events` (app/models/outbox.py).

Call `emit_event` **inside the same transaction** as the business transition it reports
and let the caller's commit write both; never commit here. The same transition emitted
twice (same type, aggregate and version — or the same explicit `dedupe_key`) is stored
once and the existing row is returned.

The contract for the events the notification service consumes is in
docs/SPEC_NOTIFICATIONS_CLUB.md §"חוזה OutboxEvent" — in short, for KDS:

    emit_event(db, tenant_id=…, company_id=…, shop_id=…,
               event_type="ReadyForPickup",          # | "ReadyRevoked" | "HandedOver" | "OrderCancelled"
               aggregate_type="fulfillment_group",   # or "order" when there are no groups
               aggregate_id=<group or order id>,
               aggregate_version=<monotonic per aggregate>,
               occurred_at=<when it became ready, UTC>,
               payload={
                   "orderId": "…", "pickupNumber": "42",
                   "workflowMode": "ORDER_PROCESS",   # DIRECT_SALE never sends "ready"
                   "partial": False,
                   "contact": {"phone": "050…", "firstName": "דנה"},  # the order's contact snapshot
               })
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.outbox import OUTBOX_PENDING, OutboxEvent

#: The event types the notification service understands today.
READY_FOR_PICKUP = "ReadyForPickup"
READY_REVOKED = "ReadyRevoked"
HANDED_OVER = "HandedOver"
ORDER_CANCELLED = "OrderCancelled"
FULFILLMENT_EVENTS = (READY_FOR_PICKUP, READY_REVOKED, HANDED_OVER, ORDER_CANCELLED)


def emit_event(
    db: Session,
    *,
    tenant_id: Any,
    event_type: str,
    aggregate_type: str,
    aggregate_id: Any,
    aggregate_version: int = 1,
    occurred_at: Optional[datetime] = None,
    payload: Optional[Dict[str, Any]] = None,
    company_id: Any = None,
    shop_id: Any = None,
    dedupe_key: Optional[str] = None,
) -> OutboxEvent:
    key = (dedupe_key or f"{event_type}:{aggregate_type}:{aggregate_id}:v{int(aggregate_version)}")[:300]
    existing = (
        db.query(OutboxEvent)
        .filter(OutboxEvent.tenant_id == tenant_id, OutboxEvent.dedupe_key == key)
        .first()
    )
    if existing is not None:
        return existing
    when = occurred_at or datetime.now(timezone.utc)
    row = OutboxEvent(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=company_id,
        shop_id=shop_id,
        aggregate_type=str(aggregate_type)[:40],
        aggregate_id=str(aggregate_id)[:100],
        aggregate_version=int(aggregate_version),
        event_type=str(event_type)[:60],
        dedupe_key=key,
        occurred_at=when,
        payload=dict(payload or {}),
        state=OUTBOX_PENDING,
        available_at=when,
        attempts=0,
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        existing = (
            db.query(OutboxEvent)
            .filter(OutboxEvent.tenant_id == tenant_id, OutboxEvent.dedupe_key == key)
            .first()
        )
        if existing is None:
            raise
        return existing
    return row
