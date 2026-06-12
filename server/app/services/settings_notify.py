"""Notify POS machines via MQTT that settings for their shop/company changed."""
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.services.mqtt import mqtt_service


def _notify_machines(db: Session, machines: list, reason: str) -> None:
    for m in machines:
        mid = str(m.merchant_id) if m.merchant_id else None
        if mid:
            mqtt_service.publish_settings_notify(mid, str(m.id), reason=reason)


def notify_machines_for_shop_settings(db: Session, shop_id: str, reason: str) -> None:
    """Notify every active machine assigned to this shop that settings changed."""
    machines = db.query(POSMachine).filter(
        POSMachine.shop_id == shop_id,
        POSMachine.is_active.is_(True),
    ).all()
    _notify_machines(db, machines, reason)


def notify_machines_for_company_settings(db: Session, company_id: str, reason: str) -> None:
    """Notify all active machines in every shop belonging to this company."""
    shop_ids = [
        str(row[0])
        for row in db.query(Shop.id).filter(Shop.company_id == company_id).all()
    ]
    if not shop_ids:
        return
    machines = db.query(POSMachine).filter(
        POSMachine.shop_id.in_(shop_ids),
        POSMachine.is_active.is_(True),
    ).all()
    _notify_machines(db, machines, reason)
