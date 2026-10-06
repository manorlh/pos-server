from typing import List
import uuid as uuid_mod
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.pairing_code import (
    PairingCodeGenerateRequest,
    PairingCodeResponse,
    PairingCodeValidate,
    MachineAssignRequest,
)
from app.schemas.pos_machine import POSMachineResponse
from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.company import Company
from app.models.user import User
from app.middleware.auth import get_current_distributor, get_active_tenant_id, ensure_same_tenant
from app.services import access, device_profile
from app.services.pairing import (
    AdoptionRefused,
    PairingAssignmentError,
    create_pairing_code,
    validate_pairing_code,
    assign_machine_to_shop,
    resolve_pairing_assignment,
)
from app.services.auth import create_machine_token
from app.services.realtime_info import machine_realtime_connection_info

router = APIRouter(prefix="/pairing", tags=["pairing"])


@router.post("/generate", response_model=PairingCodeResponse, status_code=status.HTTP_201_CREATED)
def generate_pairing_code(
    body: PairingCodeGenerateRequest = PairingCodeGenerateRequest(),
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Generate a pairing code (distributor/super_admin only). Optional company/shop pre-assigns on validate.

    The code belongs to the *active* tenant. There used to be a check here that the
    user's home tenant (`user.tenant_id`, where the account was created) equals the
    active one, which stopped a distributor pairing tills in any organization they had
    switched into. Whether they may act in the active tenant at all is already decided
    by `get_active_tenant_id`, which requires a membership (or super admin), so that
    check refused nothing a membership did not already allow — only the legitimate case.
    """
    # "הוספת מכשירים": the super admin may have taken it from this role (app/services/access.py).
    access.require_feature(db, current_user, access.PAIR_DEVICES)

    try:
        company_id, shop_id = resolve_pairing_assignment(
            db,
            active_tenant_id,
            company_id=body.company_id,
            shop_id=body.shop_id,
        )
    except PairingAssignmentError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    if company_id is not None:
        company = db.query(Company).filter(Company.id == company_id).first()
        if not company:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        ensure_same_tenant(company.tenant_id, active_tenant_id)

    # "סוג מכשיר (תפקיד)" (docs/SPEC_DEVICE_ROLE_MODEL.md): a kiosk needs a shop and valid
    # controlling tills — said now, while the dialog is open (400 / 422, Hebrew `message`).
    try:
        device_role, kiosk_options = device_profile.check_pairing_request(
            db, role=body.device_role, shop_id=shop_id, kiosk=body.kiosk,
        )
    except device_profile.DeviceProfileRefused as refused:
        return JSONResponse(status_code=refused.status_code, content=refused.body)

    try:
        pairing_code = create_pairing_code(
            db,
            current_user.id,
            tenant_id=active_tenant_id,
            company_id=company_id,
            shop_id=shop_id,
            device_model=body.device_model,
            device_role=device_role,
            kiosk_options=kiosk_options,
        )
    except PairingAssignmentError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    return pairing_code


@router.post("/validate", response_model=dict)
def validate_pairing(
    pairing_data: PairingCodeValidate,
    db: Session = Depends(get_db)
):
    """Validate and activate pairing code (public endpoint for desktop client)."""
    try:
        machine = validate_pairing_code(
            db,
            pairing_data.code,
            pairing_data.device_info,
            pairing_data.machine_name
        )
    except AdoptionRefused as exc:
        # A replacement code whose terminal may not be replaced yet: an open shift, or
        # card sales it never transmitted (docs/SHIFTS_API.md §4.9). The code stays unused.
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    if not machine:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired pairing code"
        )

    machine_token = create_machine_token(str(machine.id), machine.token_version or 1)
    return machine_realtime_connection_info(machine=machine, access_token=machine_token)


@router.get("/codes", response_model=List[PairingCodeResponse])
def list_pairing_codes(
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """List pairing codes (distributor/super_admin only)."""
    # "הוספת מכשירים": the super admin may have taken it from this role (app/services/access.py).
    access.require_feature(db, current_user, access.PAIR_DEVICES)
    query = db.query(PairingCode).filter(PairingCode.tenant_id == active_tenant_id)

    if current_user.role.value != "super_admin":
        query = query.filter(PairingCode.distributor_id == current_user.id)

    return query.order_by(PairingCode.created_at.desc()).all()


@router.get("/codes/{code_id}", response_model=PairingCodeResponse)
def get_pairing_code(
    code_id: str,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Get pairing code details."""
    # "הוספת מכשירים": the super admin may have taken it from this role (app/services/access.py).
    access.require_feature(db, current_user, access.PAIR_DEVICES)
    code = db.query(PairingCode).filter(PairingCode.id == code_id).first()
    if not code:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pairing code not found")

    if current_user.role.value != "super_admin" and code.distributor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    ensure_same_tenant(code.tenant_id, active_tenant_id)
    return code


@router.post("/machines/{machine_id}/assign", response_model=POSMachineResponse)
def assign_machine(
    machine_id: str,
    assign_data: MachineAssignRequest,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db)
):
    """Assign paired machine to a shop (distributor/super_admin only)."""
    # "הוספת מכשירים": the super admin may have taken it from this role (app/services/access.py).
    access.require_feature(db, current_user, access.PAIR_DEVICES)
    sid = assign_data.shop_id
    shop = db.query(Shop).filter(Shop.id == sid).first()
    if not shop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, active_tenant_id)

    machine_uuid = uuid_mod.UUID(str(machine_id))
    machine_row = db.query(POSMachine).filter(POSMachine.id == machine_uuid).first()
    if not machine_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine_row.tenant_id, active_tenant_id)
    if current_user.role.value != "super_admin" and machine_row.distributor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    machine = assign_machine_to_shop(db, machine_uuid, sid)

    if not machine:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to assign machine. Machine may not exist or is not in paired status.",
        )

    return machine
