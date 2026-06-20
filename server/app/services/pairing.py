import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from sqlalchemy.orm import Session
from app.config import get_settings
from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.company import Company
from app.models.shop import Shop
from app.models.user import User
from app.models.tenant_membership import TenantMembership
from app.services.shop_validation import shop_belongs_to_company
import uuid

settings = get_settings()


class PairingAssignmentError(ValueError):
    """Invalid company/shop pre-assignment for a pairing code."""


def resolve_tenant_id_for_user(db: Session, user_id: uuid.UUID) -> Optional[uuid.UUID]:
    """Tenant for pairing scope: user.tenant_id, else default membership."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return None
    if user.tenant_id:
        return user.tenant_id
    row = (
        db.query(TenantMembership.tenant_id)
        .filter(TenantMembership.user_id == user.id)
        .order_by(TenantMembership.is_default.desc(), TenantMembership.created_at.asc())
        .first()
    )
    return row[0] if row else None


def resolve_pairing_assignment(
    db: Session,
    tenant_id: uuid.UUID,
    company_id: Optional[uuid.UUID] = None,
    shop_id: Optional[uuid.UUID] = None,
) -> Tuple[Optional[uuid.UUID], Optional[uuid.UUID]]:
    """
    Resolve optional pre-assignment from dashboard company/shop picks.
    Returns (company_id, shop_id) or (None, None) when neither is set.
    """
    if company_id is None and shop_id is None:
        return None, None

    if shop_id is not None:
        shop = db.query(Shop).filter(Shop.id == shop_id).first()
        if not shop:
            raise PairingAssignmentError("Shop not found")
        company = db.query(Company).filter(Company.id == shop.company_id).first()
        if not company:
            raise PairingAssignmentError("Company not found for shop")
        if company_id is not None and shop.company_id != company_id:
            raise PairingAssignmentError("Shop does not belong to this company")
        if company.tenant_id != tenant_id:
            raise PairingAssignmentError("tenant_forbidden")
        return shop.company_id, shop_id

    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise PairingAssignmentError("Company not found")
    if company.tenant_id != tenant_id:
        raise PairingAssignmentError("tenant_forbidden")
    return company_id, None


def generate_pairing_code(length: int = None) -> str:
    """Generate a random alphanumeric pairing code"""
    if length is None:
        length = settings.pairing_code_length
    alphabet = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def create_pairing_code(
    db: Session,
    distributor_id: uuid.UUID,
    tenant_id: Optional[uuid.UUID] = None,
    company_id: Optional[uuid.UUID] = None,
    shop_id: Optional[uuid.UUID] = None,
) -> PairingCode:
    """Create a new pairing code, optionally with company/shop pre-assignment."""
    code = generate_pairing_code()
    while db.query(PairingCode).filter(PairingCode.code == code).first():
        code = generate_pairing_code()

    if shop_id is not None and company_id is not None:
        if not shop_belongs_to_company(db, shop_id, company_id):
            raise PairingAssignmentError("Shop does not belong to this company")

    expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.pairing_code_expiry_minutes)

    pairing_code = PairingCode(
        code=code,
        distributor_id=distributor_id,
        tenant_id=tenant_id,
        company_id=company_id,
        shop_id=shop_id,
        expires_at=expires_at,
        is_used=False,
    )
    db.add(pairing_code)
    db.commit()
    db.refresh(pairing_code)
    return pairing_code


def validate_pairing_code(
    db: Session,
    code: str,
    device_info: Optional[dict] = None,
    machine_name: Optional[str] = None
) -> Optional[POSMachine]:
    """Validate and activate a pairing code, creating a POS machine"""
    pairing_code = db.query(PairingCode).filter(PairingCode.code == code).first()

    if not pairing_code:
        return None

    if pairing_code.is_used:
        return None

    if datetime.now(timezone.utc) > pairing_code.expires_at:
        return None

    tenant_id = pairing_code.tenant_id or resolve_tenant_id_for_user(
        db, pairing_code.distributor_id
    )

    pos_machine = create_pos_machine(
        db,
        distributor_id=pairing_code.distributor_id,
        tenant_id=tenant_id,
        device_info=device_info,
        machine_name=machine_name,
    )

    pairing_code.is_used = True
    pairing_code.used_at = datetime.now(timezone.utc)
    pairing_code.pos_machine_id = pos_machine.id

    db.commit()
    db.refresh(pos_machine)

    if pairing_code.shop_id:
        assigned = assign_machine_to_shop(
            db,
            pos_machine.id,
            pairing_code.shop_id,
        )
        if assigned:
            pos_machine = assigned

    return pos_machine


def create_pos_machine(
    db: Session,
    *,
    distributor_id: uuid.UUID,
    tenant_id: Optional[uuid.UUID],
    device_info: Optional[dict] = None,
    machine_name: Optional[str] = None,
    pairing_session_id: Optional[uuid.UUID] = None,
) -> POSMachine:
    """Create a new POS machine row in PAIRED status (not yet assigned to a shop)."""
    machine_code = f"MACHINE-{uuid.uuid4().hex[:8].upper()}"
    while db.query(POSMachine).filter(POSMachine.machine_code == machine_code).first():
        machine_code = f"MACHINE-{uuid.uuid4().hex[:8].upper()}"

    mqtt_client_id = f"pos-{uuid.uuid4().hex[:12]}"
    while db.query(POSMachine).filter(POSMachine.mqtt_client_id == mqtt_client_id).first():
        mqtt_client_id = f"pos-{uuid.uuid4().hex[:12]}"

    resolved_name = machine_name or f"POS Machine {machine_code}"
    pos_machine = POSMachine(
        tenant_id=tenant_id,
        distributor_id=distributor_id,
        pairing_session_id=pairing_session_id,
        name=resolved_name,
        machine_code=machine_code,
        mqtt_client_id=mqtt_client_id,
        pairing_status=PairingStatus.PAIRED,
        device_info=device_info,
    )
    db.add(pos_machine)
    db.flush()
    return pos_machine


def assign_machine_to_shop(
    db: Session,
    machine_id: uuid.UUID,
    shop_id: uuid.UUID,
) -> Optional[POSMachine]:
    """Assign a paired machine to a shop."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        return None

    if machine.pairing_status != PairingStatus.PAIRED:
        return None

    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop:
        return None

    machine.shop_id = shop_id
    if shop.tenant_id:
        machine.tenant_id = shop.tenant_id
    machine.pairing_status = PairingStatus.ASSIGNED
    db.commit()
    db.refresh(machine)
    return machine
