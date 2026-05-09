import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Optional
from sqlalchemy.orm import Session
from app.config import get_settings
from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine, PairingStatus
from app.models.merchant import Merchant
from app.models.user import User
import uuid

settings = get_settings()


def generate_pairing_code(length: int = None) -> str:
    """Generate a random alphanumeric pairing code"""
    if length is None:
        length = settings.pairing_code_length
    alphabet = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def create_pairing_code(db: Session, distributor_id: uuid.UUID) -> PairingCode:
    """Create a new pairing code"""
    code = generate_pairing_code()
    # Ensure code is unique
    while db.query(PairingCode).filter(PairingCode.code == code).first():
        code = generate_pairing_code()
    
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.pairing_code_expiry_minutes)
    
    pairing_code = PairingCode(
        code=code,
        distributor_id=distributor_id,
        expires_at=expires_at,
        is_used=False
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
    
    # Generate unique machine code
    machine_code = f"MACHINE-{uuid.uuid4().hex[:8].upper()}"
    while db.query(POSMachine).filter(POSMachine.machine_code == machine_code).first():
        machine_code = f"MACHINE-{uuid.uuid4().hex[:8].upper()}"
    
    # Generate MQTT client ID
    mqtt_client_id = f"pos-{uuid.uuid4().hex[:12]}"
    while db.query(POSMachine).filter(POSMachine.mqtt_client_id == mqtt_client_id).first():
        mqtt_client_id = f"pos-{uuid.uuid4().hex[:12]}"
    
    # Create POS machine
    machine_name = machine_name or f"POS Machine {machine_code}"
    pos_machine = POSMachine(
        distributor_id=pairing_code.distributor_id,
        name=machine_name,
        machine_code=machine_code,
        mqtt_client_id=mqtt_client_id,
        pairing_status=PairingStatus.PAIRED,
        device_info=device_info
    )
    db.add(pos_machine)
    
    # Mark pairing code as used
    pairing_code.is_used = True
    pairing_code.used_at = datetime.now(timezone.utc)
    pairing_code.pos_machine_id = pos_machine.id
    
    db.commit()
    db.refresh(pos_machine)
    return pos_machine


def assign_machine_to_merchant(
    db: Session,
    machine_id: uuid.UUID,
    merchant_id: uuid.UUID,
    shop_id: Optional[uuid.UUID] = None,
) -> Optional[POSMachine]:
    """Assign a paired machine to a merchant and optionally a shop."""
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        return None

    if machine.pairing_status != PairingStatus.PAIRED:
        return None

    machine.merchant_id = merchant_id
    merchant = db.query(Merchant).filter(Merchant.id == merchant_id).first()
    machine.tenant_id = merchant.tenant_id if merchant else machine.tenant_id
    machine.shop_id = shop_id
    machine.pairing_status = PairingStatus.ASSIGNED
    db.commit()
    db.refresh(machine)
    return machine

