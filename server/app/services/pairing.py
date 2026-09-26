import secrets
import uuid
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
from app.models.trading_day import TradingDay, TradingDayStatus
from app.services.machine_health import serial_from_device_info
from app.services.register_number import assign_register_number, set_machine_shop
from app.services import machine_catalog
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
    target_machine_id: Optional[uuid.UUID] = None,
) -> PairingCode:
    """
    Create a new pairing code, optionally with company/shop pre-assignment.

    `target_machine_id` makes it a *replacement* code: the device that redeems it adopts
    that existing machine row rather than creating a new one. See `validate_pairing_code`.
    """
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
        target_machine_id=target_machine_id,
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

    if pairing_code.target_machine_id is not None:
        pos_machine = adopt_machine(
            db,
            pairing_code.target_machine_id,
            device_info=device_info,
            machine_name=machine_name,
        )
        if pos_machine is None:
            return None
    else:
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
        # The till already puts its serial in `device_info` at pairing time, on both
        # the code path (POST /pairing/validate) and the QR path (POST
        # /pairing/device/register → claim). Lift it into the column so a machine is
        # identifiable by the number printed on the box from the moment it is paired,
        # rather than only after its first heartbeat. Heartbeats then keep it fresh.
        serial_number=serial_from_device_info(device_info),
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

    # Also settles the register number: the shop's next one, or the one this machine
    # already holds in this shop. Every pairing flow that lands a till in a shop —
    # the assign endpoint, a code pre-assigned to a shop, a field install — comes
    # through here.
    previous_shop_id = machine.shop_id
    set_machine_shop(db, machine, shop_id)
    # A till's own list was chosen out of its old shop's catalog; see machine_catalog.
    if previous_shop_id is not None and str(previous_shop_id) != str(machine.shop_id):
        machine_catalog.reset_for_new_shop(db, machine)
    if shop.tenant_id:
        machine.tenant_id = shop.tenant_id
    machine.pairing_status = PairingStatus.ASSIGNED
    db.commit()
    db.refresh(machine)
    return machine


def adopt_machine(
    db: Session,
    machine_id: uuid.UUID,
    *,
    device_info: Optional[dict] = None,
    machine_name: Optional[str] = None,
) -> Optional[POSMachine]:
    """
    Hand an existing terminal's identity to a replacement device.

    The row keeps its id, its `machine_code`, its shop and its register number, so every
    document already filed against it still refers to the till the shop knows, and the
    day's reporting does not split across two machines halfway through an afternoon.

    Two things are deliberate:

    * **`token_version` is bumped.** Machine tokens do not expire, so this is the
      revocation: the unit being replaced is holding a token that would otherwise keep
      working, and a terminal that was lost rather than broken is a terminal in someone
      else's hands.
    * **An open trading day blocks the adoption.** The replacement would inherit a day it
      has no records for, and its Z — computed from its own local rows — would declare a
      fraction of what the shop actually took. The day must be closed first, which is what
      `administrative_close` is for.

    `device_info` and the name are refreshed, because the hardware genuinely changed.
    """
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine is None:
        return None

    open_day = (
        db.query(TradingDay)
        .filter(
            TradingDay.machine_id == machine.id,
            TradingDay.status == TradingDayStatus.OPEN,
        )
        .first()
    )
    if open_day is not None:
        raise PairingAssignmentError(
            "This terminal still has an open trading day. Close it first — a replacement "
            "cannot issue a Z for sales it never saw."
        )

    if device_info:
        machine.device_info = device_info
    if machine_name:
        machine.name = machine_name
    machine.pairing_status = PairingStatus.PAIRED if machine.shop_id is None else PairingStatus.ASSIGNED
    machine.is_active = True
    machine.token_version = (machine.token_version or 1) + 1
    # The replacement has reported nothing yet; carrying the dead unit's last backlog
    # forward would show the new terminal as holding sales it has never seen.
    machine.pending_count = None
    machine.pending_documents = None
    machine.pending_count_at = None
    # Same row, so the same register number — the replacement is the till the shop
    # already calls "register 2". This keeps it; it only draws a number if the row is
    # in a shop and somehow never got one.
    assign_register_number(db, machine)
    db.flush()
    return machine
