"""
What a consumer of the KDS's outbox events needs from the KDS (docs/SPEC_KDS.md §7).

The outbox itself (`outbox_events`, its lease and processing) is the notification
service's (app/models/outbox.py, app/services/notifications/). The KDS writes, in the
same transaction as the transition:

* `ReadyForPickup` — one per fulfillment group (dedupe key `ReadyForPickup:<group>`).
  An undo / handover / cancellation before any consumer took it suppresses it in place
  (`state=processed`, `result="suppressed:<reason>"`); ready again after an undo re-arms
  that same row. Never a second ReadyForPickup for a group.
* `ReadyRevoked` / `HandedOver` / `OrderCancelled` — only when a ReadyForPickup was
  already taken by a consumer, so it can cancel a message it queued and has not sent.

A consumer calls `still_valid` right before every send attempt and reads the contact
through `order_contact` (or the payload's `contactPhone`, present only when a message is
wanted, which it masks once taken).
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.kds import FulfillmentGroup, KitchenOrder
from app.models.outbox import OutboxEvent
from app.models.shop import Shop
from app.services.kds import READY_EVENT, is_suppressed


def _order_and_group(db: Session, event: OutboxEvent):
    payload = event.payload or {}
    order = db.query(KitchenOrder).filter(KitchenOrder.id == payload.get("orderId")).first()
    group = db.query(FulfillmentGroup).filter(FulfillmentGroup.id == payload.get("groupId")).first()
    return order, group


def still_valid(db: Session, event: OutboxEvent) -> Dict[str, Any]:
    """`{"valid": bool, "reason": str|None}` for a ReadyForPickup about to be acted on."""
    if event.event_type != READY_EVENT:
        return {"valid": False, "reason": "not_a_ready_event"}
    if is_suppressed(event):
        return {"valid": False, "reason": event.result}
    order, group = _order_and_group(db, event)
    if order is None or group is None or order.tenant_id != event.tenant_id:
        return {"valid": False, "reason": "order_gone"}
    if group.state != "ready_for_pickup":
        return {"valid": False, "reason": f"group_{group.state}"}
    if order.workflow_mode != "ORDER_PROCESS":
        return {"valid": False, "reason": "direct_sale"}
    if not (order.config_snapshot or {}).get("readyNotification"):
        return {"valid": False, "reason": "notification_off"}
    if not order.contact_phone:
        return {"valid": False, "reason": "no_contact"}
    return {"valid": True, "reason": None}


def order_contact(db: Session, event: OutboxEvent) -> Optional[Dict[str, Any]]:
    """The order contact snapshot (never the customer card's current phone)."""
    order, _ = _order_and_group(db, event)
    if order is None or order.tenant_id != event.tenant_id:
        return None
    shop = db.query(Shop).filter(Shop.id == order.shop_id).first()
    return {
        "phone": order.contact_phone,
        "pickupName": order.pickup_name,
        "pickupNumber": order.pickup_number,
        "displayRef": order.display_ref,
        "shopId": str(order.shop_id),
        "shopName": shop.name if shop else None,
    }
