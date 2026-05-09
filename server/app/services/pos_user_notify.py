"""Notify POS machines via MQTT that the pos_users roster for their shop changed.

POS-desktop reacts to `pos/.../pos-users/notify` by calling GET /sync/{machine_id}/pos-users.
Mirror of `catalog_notify.py`.
"""
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.services.mqtt import mqtt_service


def notify_machines_for_shop_pos_users(db: Session, shop_id: str, reason: str) -> None:
    """Notify every active machine assigned to this shop that pos_users changed."""
    machines = db.query(POSMachine).filter(
        POSMachine.shop_id == shop_id,
        POSMachine.is_active.is_(True),
    ).all()
    for m in machines:
        mid = str(m.merchant_id) if m.merchant_id else None
        if mid:
            mqtt_service.publish_pos_users_notify(mid, str(m.id), reason=reason)
