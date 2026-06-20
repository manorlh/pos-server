import uuid as uuid_mod
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_distributor,
    get_pairing_session_user,
)
from app.middleware.rate_limit import check_rate_limit, check_rate_limit_by_key
from app.models.pairing_session import PairingSession
from app.models.user import User
from app.schemas.pairing_mobile import (
    DevicePollWaitingResponse,
    DeviceRegisterRequest,
    DeviceRegisterResponse,
    MobileClaimRequest,
    MobileClaimResponse,
    MobileCompanyRow,
    MobileContextResponse,
    MobileSessionPatchRequest,
    MobileShopRow,
    PairingSessionCreateResponse,
    PairingSessionSummary,
)
from app.services.pairing_mobile import (
    PairingMobileError,
    build_mobile_url,
    claim_device_pairing,
    create_pairing_session,
    list_active_pairing_sessions,
    list_companies_for_pairing_session,
    list_shops_for_pairing_session,
    poll_device_credentials,
    register_device_pairing_request,
    revoke_pairing_session,
    update_pairing_session_defaults,
)

router = APIRouter(prefix="/pairing", tags=["pairing-mobile"])
settings = get_settings()


@router.post("/sessions", response_model=PairingSessionCreateResponse, status_code=status.HTTP_201_CREATED)
def create_session(
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Start a 12h field-install session; scan resulting QR on distributor phone."""
    session, token = create_pairing_session(db, current_user, active_tenant_id)
    return PairingSessionCreateResponse(
        session_id=session.id,
        session_token=token,
        expires_at=session.expires_at,
        mobile_url=build_mobile_url(token),
        session_expire_hours=settings.pairing_session_expire_hours,
    )


@router.get("/sessions/active", response_model=List[PairingSessionSummary])
def list_active_sessions(
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rows = list_active_pairing_sessions(db, current_user.id, active_tenant_id)
    return rows


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_session(
    session_id: str,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    try:
        sid = uuid_mod.UUID(str(session_id))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid session id") from exc
    row = revoke_pairing_session(db, sid, current_user.id, active_tenant_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/mobile/context", response_model=MobileContextResponse)
def mobile_context(
    company_id: Optional[str] = Query(None, alias="companyId"),
    session_user: tuple = Depends(get_pairing_session_user),
    db: Session = Depends(get_db),
):
    session, user = session_user
    companies = list_companies_for_pairing_session(db, session, user)
    cid: Optional[uuid_mod.UUID] = None
    if company_id:
        try:
            cid = uuid_mod.UUID(str(company_id))
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid companyId") from exc
    elif session.default_company_id:
        cid = session.default_company_id
    shops = list_shops_for_pairing_session(db, session, user, company_id=cid) if cid else []
    return MobileContextResponse(
        session_expires_at=session.expires_at,
        session_expire_hours=settings.pairing_session_expire_hours,
        machines_paired_count=session.machines_paired_count or 0,
        default_company_id=session.default_company_id,
        default_shop_id=session.default_shop_id,
        companies=[MobileCompanyRow.model_validate(c) for c in companies],
        shops=[MobileShopRow.model_validate(s) for s in shops],
    )


@router.patch("/mobile/session", response_model=MobileContextResponse)
def mobile_patch_session(
    body: MobileSessionPatchRequest,
    session_user: tuple = Depends(get_pairing_session_user),
    db: Session = Depends(get_db),
):
    session, user = session_user
    try:
        from app.services.pairing import PairingAssignmentError

        update_pairing_session_defaults(db, session, body.company_id, body.shop_id)
    except PairingAssignmentError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    db.refresh(session)
    cid = body.company_id or session.default_company_id
    shops = list_shops_for_pairing_session(db, session, user, company_id=cid) if cid else []
    companies = list_companies_for_pairing_session(db, session, user)
    return MobileContextResponse(
        session_expires_at=session.expires_at,
        session_expire_hours=settings.pairing_session_expire_hours,
        machines_paired_count=session.machines_paired_count or 0,
        default_company_id=session.default_company_id,
        default_shop_id=session.default_shop_id,
        companies=[MobileCompanyRow.model_validate(c) for c in companies],
        shops=[MobileShopRow.model_validate(s) for s in shops],
    )


@router.post("/mobile/claim", response_model=MobileClaimResponse)
def mobile_claim(
    body: MobileClaimRequest,
    request: Request,
    session_user: tuple = Depends(get_pairing_session_user),
    db: Session = Depends(get_db),
):
    session, user = session_user
    check_rate_limit_by_key(f"claim:{session.jti}", max_calls=60, window_seconds=60)
    try:
        _row, machine, company, shop = claim_device_pairing(
            db,
            session,
            user,
            body.device_nonce.strip(),
            body.company_id,
            body.shop_id,
            machine_name=body.machine_name,
        )
    except PairingMobileError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return MobileClaimResponse(
        machine_id=machine.id,
        machine_code=machine.machine_code,
        company_name=company.name,
        shop_name=shop.name,
    )


@router.post("/device/register", response_model=DeviceRegisterResponse, status_code=status.HTTP_201_CREATED)
def device_register(
    body: DeviceRegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    check_rate_limit(request, "device_register", max_calls=10, window_seconds=60)
    row = register_device_pairing_request(
        db,
        device_info=body.device_info,
        machine_name=body.machine_name,
    )
    return DeviceRegisterResponse(device_nonce=row.device_nonce, expires_at=row.expires_at)


@router.get("/device/{nonce}/status")
def device_poll_status(
    nonce: str,
    request: Request,
    db: Session = Depends(get_db),
):
    check_rate_limit(request, "device_poll", max_calls=120, window_seconds=60)
    check_rate_limit_by_key(f"poll:{nonce}", max_calls=120, window_seconds=60)
    poll_status, payload = poll_device_credentials(db, nonce)
    if poll_status == "waiting":
        return DevicePollWaitingResponse()
    if poll_status == "expired":
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Device pairing request expired")
    if poll_status == "gone":
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Credentials already delivered or unknown device")
    return payload
