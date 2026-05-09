from typing import List
import uuid as uuid_mod
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.pairing_code import PairingCodeCreate, PairingCodeResponse, PairingCodeValidate, MachineAssignRequest
from app.schemas.pos_machine import POSMachineResponse
from app.models.pairing_code import PairingCode
from app.models.merchant import Merchant
from app.models.user import User
from app.middleware.auth import get_current_distributor, get_active_tenant_id, ensure_same_tenant
from app.services.pairing import (
    create_pairing_code,
    validate_pairing_code,
    assign_machine_to_merchant,
)
from app.services.shop_validation import shop_belongs_to_merchant
from app.services.auth import create_machine_token
from app.config import get_settings

router = APIRouter(prefix="/pairing", tags=["pairing"])
settings = get_settings()


@router.post("/generate", response_model=PairingCodeResponse, status_code=status.HTTP_201_CREATED)
def generate_pairing_code(
    current_user: User = Depends(get_current_distributor),  # Distributor or super admin
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Generate a pairing code (distributor/super_admin only)"""
    ensure_same_tenant(current_user.tenant_id, active_tenant_id)
    pairing_code = create_pairing_code(db, current_user.id)
    return pairing_code


@router.post("/validate", response_model=dict)
def validate_pairing(
    pairing_data: PairingCodeValidate,
    db: Session = Depends(get_db)
):
    """Validate and activate pairing code (public endpoint for desktop client)"""
    machine = validate_pairing_code(
        db,
        pairing_data.code,
        pairing_data.device_info,
        pairing_data.machine_name
    )
    
    if not machine:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired pairing code"
        )
    
    # Generate machine authentication token
    machine_token = create_machine_token(str(machine.id))
    
    # Return machine credentials
    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        "merchantId": str(machine.merchant_id) if machine.merchant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "accessToken": machine_token,
        "mqttClientId": machine.mqtt_client_id,
        "mqttUsername": machine.mqtt_client_id,  # Using client ID as username
        "mqttPassword": machine_token,  # Using token as password (can be improved)
        "apiUrl": f"{settings.api_v1_prefix}",
        "mqttBrokerUrl": f"{settings.mqtt_broker_host}:{settings.mqtt_broker_port}",
    }


@router.get("/codes", response_model=List[PairingCodeResponse])
def list_pairing_codes(
    current_user: User = Depends(get_current_distributor),  # Distributor or super admin
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List pairing codes (distributor/super_admin only)"""
    query = db.query(PairingCode)
    
    # Filter by distributor if not super admin
    if current_user.role.value != "super_admin":
        query = query.filter(PairingCode.distributor_id == current_user.id)
    
    codes = query.order_by(PairingCode.created_at.desc()).all()
    codes = [c for c in codes if c.pos_machine is None or c.pos_machine.tenant_id == active_tenant_id]
    return codes


@router.get("/codes/{code_id}", response_model=PairingCodeResponse)
def get_pairing_code(
    code_id: str,
    current_user: User = Depends(get_current_distributor),  # Distributor or super admin
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Get pairing code details"""
    code = db.query(PairingCode).filter(PairingCode.id == code_id).first()
    if not code:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pairing code not found"
        )
    
    # Check permissions
    if current_user.role.value != "super_admin" and code.distributor_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied"
        )
    
    if code.pos_machine and code.pos_machine.tenant_id is not None:
        ensure_same_tenant(code.pos_machine.tenant_id, active_tenant_id)
    return code


@router.post("/machines/{machine_id}/assign", response_model=POSMachineResponse)
def assign_machine(
    machine_id: str,
    assign_data: MachineAssignRequest,
    current_user: User = Depends(get_current_distributor),  # Distributor or super admin
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Assign paired machine to merchant (distributor/super_admin only)"""
    mid = uuid_mod.UUID(str(assign_data.merchant_id))
    sid = assign_data.shop_id
    if sid is not None and not shop_belongs_to_merchant(db, sid, mid):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="shopId does not belong to this merchant",
        )

    merchant = db.query(Merchant).filter(Merchant.id == mid).first()
    if not merchant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant not found")
    ensure_same_tenant(merchant.tenant_id, active_tenant_id)
    if current_user.role.value != "super_admin" and merchant.distributor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    machine = assign_machine_to_merchant(
        db,
        uuid_mod.UUID(str(machine_id)),
        mid,
        shop_id=sid,
    )

    if not machine:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to assign machine. Machine may not exist or is not in paired status."
        )
    
    return machine

