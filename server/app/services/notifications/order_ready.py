"""
"ההזמנה מוכנה" (§15): KDS's `ReadyForPickup` outbox event → one service SMS.

Rules, in order:
* `workflowMode == DIRECT_SALE` never sends (§2, §8: "SMS לא יוצא במכירה ישירה").
* A partial readiness (`partial: true`) does not send "the order is ready" (P0 has no
  partial template).
* The number is the order's **contact snapshot** (`payload.contact.phone`) — not the
  club membership, not marketing consent, possibly unverified. No number → nothing.
* The company's provider account must exist with `OrderReady` switched on.
* Dedupe key `tenant:group:OrderReady:recipient:sms` — a double tap, an undo and
  "ready" again, a second KDS screen: one message. A message cancelled by an undo
  before anything went out is revived (it was never sent, so this is not a duplicate).
* TTL from the moment it became ready (config, default 10 minutes); the worker expires
  it after that, and re-checks before every attempt that the order was not handed over
  or cancelled and that "ready" still stands (`still_valid`).
* `ReadyRevoked` / `HandedOver` / `OrderCancelled` cancel what is still pending.

Once taken, the phone in the outbox payload is masked in place.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.models.notifications import ST_CANCELLED, ST_QUEUED, Notification
from app.models.outbox import OutboxEvent
from app.models.shop import Shop
from app.services.notifications import outbox as consumer
from app.services.notifications import service as S
from app.services.notifications import worker as W
from app.services.notifications.phone import PhoneError, mask_phone, normalize_mobile, phone_hash
from app.services.notifications.templates import TemplateError
from app.services.outbox import (
    FULFILLMENT_EVENTS,
    HANDED_OVER,
    ORDER_CANCELLED,
    READY_FOR_PICKUP,
    READY_REVOKED,
)

EVENT = "OrderReady"
REVOKED_REASON = "order_ready_revoked"

def kds_group_state(db: Session, tenant_id: Any, aggregate_id: str) -> Optional[str]:
    """
    The KDS fulfillment group's own state (`kds_groups`, app/models/kds.py) — the
    authority on "is it still ready". None when the aggregate is not a KDS group.
    """
    try:
        import uuid as _uuid

        from app.models.kds import FulfillmentGroup

        row = (
            db.query(FulfillmentGroup.state)
            .filter(FulfillmentGroup.tenant_id == tenant_id, FulfillmentGroup.id == _uuid.UUID(str(aggregate_id)))
            .first()
        )
    except Exception:  # noqa: BLE001 - not a UUID / no KDS table: fall back to the outbox
        return None
    if row is None:
        return None
    return {
        "ready_for_pickup": "ready",
        "waiting": "not_ready",
        "handed_over": "handed_over",
        "cancelled": "cancelled",
    }.get(row[0])


#: Authoritative answer from KDS: fn(db, tenant_id, aggregate_id) →
#: "ready" | "not_ready" | "handed_over" | "cancelled" | None (unknown → use the outbox).
FULFILLMENT_STATE_PROVIDER: Optional[Callable[[Session, Any, str], Optional[str]]] = kds_group_state


def _branch_name(shop: Optional[Shop]) -> str:
    name = ((shop.name if shop is not None else "") or "").strip()
    for prefix in ("סניף ", "סניף-"):
        if name.startswith(prefix) and len(name) > len(prefix):
            return name[len(prefix):].strip()
    return name


def _masked(raw: Any) -> str:
    try:
        return mask_phone(normalize_mobile(raw))
    except PhoneError:
        return "•••"


def _redact(event: OutboxEvent, now: datetime) -> None:
    payload = dict(event.payload or {})
    changed = False
    contact = payload.get("contact")
    if isinstance(contact, dict) and contact.get("phone"):
        payload["contact"] = {**contact, "phone": _masked(contact.get("phone"))}
        changed = True
    if payload.get("contactPhone"):
        payload["contactPhone"] = _masked(payload.get("contactPhone"))
        changed = True
    if changed:
        event.payload = payload
        event.payload_redacted_at = now


def _contact(db: Session, event: OutboxEvent, payload: dict) -> tuple:
    """
    (phone, first name) of the order's contact snapshot. KDS (app/services/kds.py) sends
    a flat `contactPhone`; the documented generic shape is `contact: {phone, firstName}`.
    The first name falls back to the KDS order's pickup name ("שם לאיסוף").
    """
    contact = payload.get("contact") if isinstance(payload.get("contact"), dict) else {}
    phone = contact.get("phone") or payload.get("contactPhone")
    first = contact.get("firstName") or payload.get("contactFirstName")
    if not first and payload.get("orderId"):
        try:
            import uuid as _uuid

            from app.models.kds import KitchenOrder

            row = (
                db.query(KitchenOrder.pickup_name)
                .filter(KitchenOrder.tenant_id == event.tenant_id, KitchenOrder.id == _uuid.UUID(str(payload["orderId"])))
                .first()
            )
            if row and row[0]:
                first = str(row[0]).split()[0]
        except Exception:  # noqa: BLE001 - the name is optional; the fallback text has none
            first = None
    return phone, first


def handle_ready(db: Session, event: OutboxEvent, now: datetime) -> str:
    payload = event.payload or {}
    try:
        if str(payload.get("workflowMode") or "").upper() == "DIRECT_SALE":
            return "skipped:direct_sale"
        if payload.get("partial"):
            return "skipped:partial_not_enabled"
        if "notify" in payload and not payload.get("notify"):
            # The till's configuration does not ask for the ready message.
            return "skipped:not_requested"
        raw_phone, first_name = _contact(db, event, payload)
        if not raw_phone:
            return "skipped:no_contact"
        try:
            recipient = normalize_mobile(raw_phone)
        except PhoneError as exc:
            return f"skipped:{exc.code}"
        shop = db.get(Shop, event.shop_id) if event.shop_id else None
        company_id = event.company_id or (shop.company_id if shop is not None else None)
        config = S.get_config(db, event.tenant_id, company_id)
        if config is None:
            return "skipped:no_provider_config"
        if not (config.enabled_events or {}).get(EVENT):
            return "skipped:event_disabled"
        pickup = str(payload.get("pickupNumber") or payload.get("displayRef") or "").strip()
        if not pickup:
            return "skipped:no_pickup_number"
        group = event.aggregate_id
        dedupe = f"{event.tenant_id}:{group}:{EVENT}:{phone_hash(recipient)}:sms"
        ttl = timedelta(minutes=max(1, int(config.order_ready_ttl_minutes or 10)))
        try:
            result = S.enqueue(
                db,
                tenant_id=event.tenant_id,
                company_id=company_id,
                shop_id=event.shop_id,
                event_type=EVENT,
                recipient_e164=recipient,
                variables={
                    "first_name": first_name,
                    "pickup_number": pickup,
                    # "בסניף {branch_name}": a shop named "סניף מרכז" is not "בסניף סניף מרכז".
                    "branch_name": _branch_name(shop),
                    "brand_name": S.brand_name_for(db, config, company_id),
                },
                dedupe_key=dedupe,
                ttl=ttl,
                expires_from=S.as_aware(event.occurred_at),
                aggregate_ref=group,
                context_label=f"הזמנה {pickup}",
                source_event_id=event.id,
                config=config,
                now=now,
            )
        except TemplateError as exc:
            return f"skipped:template:{exc.code}"
        n = result.notification
        if result.created:
            return f"queued:{n.id}"
        if n.state == ST_CANCELLED and (n.attempt_count or 0) == 0 and (n.state_reason or "") == REVOKED_REASON:
            # Undo before anything went out, then ready again: still one message.
            n.state = ST_QUEUED
            n.state_reason = "ready_again"
            n.final_at = None
            n.not_before = now
            n.expires_at = S.as_aware(event.occurred_at) + ttl
            n.source_event_id = event.id
            return f"revived:{n.id}"
        return f"duplicate:{n.id}"
    finally:
        _redact(event, now)


def handle_stop(db: Session, event: OutboxEvent, now: datetime) -> str:
    reason = {
        READY_REVOKED: REVOKED_REASON,
        HANDED_OVER: "order_handed_over",
        ORDER_CANCELLED: "order_cancelled",
    }[event.event_type]
    if event.event_type == READY_REVOKED and FULFILLMENT_STATE_PROVIDER is not None:
        if FULFILLMENT_STATE_PROVIDER(db, event.tenant_id, event.aggregate_id) == "ready":
            # Undone and ready again before this was read: the message still stands.
            return "ignored:ready_again"
    out = S.cancel_for_aggregate(db, event.tenant_id, event.aggregate_id, event_types=[EVENT], reason=reason, now=now)
    text = f"cancelled:{out.cancelled}"
    if out.already_sent:
        # An SMS cannot be taken back: the staff must know the customer was told "ready".
        text += f";already_sent:{out.already_sent}"
    if out.in_flight:
        text += f";in_flight:{out.in_flight}"
    return text


def still_valid(db: Session, n: Notification, now: datetime) -> Optional[str]:
    """Worker check before every attempt: why this "ready" SMS must not go now, or None."""
    if not n.aggregate_ref:
        return None
    if FULFILLMENT_STATE_PROVIDER is not None:
        state = FULFILLMENT_STATE_PROVIDER(db, n.tenant_id, n.aggregate_ref)
        if state == "handed_over":
            return "order_handed_over"
        if state == "cancelled":
            return "order_cancelled"
        if state == "not_ready":
            return REVOKED_REASON
        if state == "ready":
            return None
    latest = (
        db.query(OutboxEvent.event_type)
        .filter(
            OutboxEvent.tenant_id == n.tenant_id,
            OutboxEvent.aggregate_id == n.aggregate_ref,
            OutboxEvent.event_type.in_(FULFILLMENT_EVENTS),
        )
        .order_by(OutboxEvent.aggregate_version.desc(), OutboxEvent.occurred_at.desc())
        .first()
    )
    if latest is None or latest[0] == READY_FOR_PICKUP:
        return None
    return {
        READY_REVOKED: REVOKED_REASON,
        HANDED_OVER: "order_handed_over",
        ORDER_CANCELLED: "order_cancelled",
    }.get(latest[0])


consumer.HANDLERS[READY_FOR_PICKUP] = handle_ready
for _type in (READY_REVOKED, HANDED_OVER, ORDER_CANCELLED):
    consumer.HANDLERS[_type] = handle_stop
W.VALIDITY_CHECKS[EVENT] = still_valid
