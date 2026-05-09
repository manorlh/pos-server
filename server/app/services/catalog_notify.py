"""Notify POS machines via MQTT that catalog changed (POS pulls via HTTP GET)."""
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.services.mqtt import mqtt_service


def notify_machine_catalog_changed(merchant_id: str, machine_id: str, reason: str) -> None:
    if merchant_id and machine_id:
        mqtt_service.publish_catalog_notify(merchant_id, machine_id, reason=reason)


def notify_all_machines_for_merchant(db: Session, merchant_id: str, reason: str) -> None:
    machines = db.query(POSMachine).filter(
        POSMachine.merchant_id == merchant_id,
        POSMachine.is_active.is_(True),
    ).all()
    for m in machines:
        mqtt_service.publish_catalog_notify(str(m.merchant_id), str(m.id), reason=reason)


def notify_machines_for_shop(db: Session, shop_id: str, reason: str) -> None:
    """Notify every active machine assigned to this shop (merged catalog depends on shop overrides)."""
    machines = db.query(POSMachine).filter(
        POSMachine.shop_id == shop_id,
        POSMachine.is_active.is_(True),
    ).all()
    for m in machines:
        mid = str(m.merchant_id) if m.merchant_id else None
        if mid:
            mqtt_service.publish_catalog_notify(mid, str(m.id), reason=reason)
