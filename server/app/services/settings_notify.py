"""Notify POS machines via Ably that settings for their till/area/shop/company/tenant changed."""
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.services.ably_notify import publish_settings_notify


def _notify_machines(db: Session, machines: list, reason: str) -> None:
    for m in machines:
        tid = str(m.tenant_id) if m.tenant_id else None
        if tid:
            publish_settings_notify(tid, str(m.id), reason=reason)


def notify_machine_settings(db: Session, machine: POSMachine, reason: str) -> None:
    """Notify the one till whose own settings layer changed."""
    if machine.is_active:
        _notify_machines(db, [machine], reason)


def notify_machines_for_area_settings(db: Session, area_id: str, reason: str) -> None:
    """Notify every active machine standing in this area (point of sale)."""
    machines = db.query(POSMachine).filter(
        POSMachine.area_id == area_id,
        POSMachine.is_active.is_(True),
    ).all()
    _notify_machines(db, machines, reason)


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


def notify_machines_for_tenant_settings(db: Session, tenant_id: str, reason: str) -> None:
    """Notify all active machines in every shop of every company under this tenant."""
    company_ids = [
        str(row[0])
        for row in db.query(Company.id).filter(Company.tenant_id == tenant_id).all()
    ]
    if not company_ids:
        return
    shop_ids = [
        str(row[0])
        for row in db.query(Shop.id).filter(Shop.company_id.in_(company_ids)).all()
    ]
    if not shop_ids:
        return
    machines = db.query(POSMachine).filter(
        POSMachine.shop_id.in_(shop_ids),
        POSMachine.is_active.is_(True),
    ).all()
    _notify_machines(db, machines, reason)
