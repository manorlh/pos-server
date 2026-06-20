"""Notify POS machines via MQTT that the pos_users roster for their shop changed."""
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
        tid = str(m.tenant_id) if m.tenant_id else None
        if tid:
            mqtt_service.publish_pos_users_notify(tid, str(m.id), reason=reason)
