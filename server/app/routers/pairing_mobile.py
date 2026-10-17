import uuid as uuid_mod
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
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
from app.models.shop import Shop
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
    DeviceRequestClaimIn,
)
from app.services import access
from app.services import training_mode as TM
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
from app.services.register_number import peek_next_register_number

router = APIRouter(prefix="/pairing", tags=["pairing-mobile"])
settings = get_settings()


@router.post("/sessions", response_model=PairingSessionCreateResponse, status_code=status.HTTP_201_CREATED)
def create_session(
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Start a 12h field-install session; scan resulting QR on distributor phone."""
    # "הוספת מכשירים": the super admin may have taken it from this role (app/services/access.py).
    access.require_feature(db, current_user, access.PAIR_DEVICES)
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
    # "הוספת מכשירים": the super admin may have taken it from this role (app/services/access.py).
    access.require_feature(db, current_user, access.PAIR_DEVICES)
    rows = list_active_pairing_sessions(db, current_user.id, active_tenant_id)
    return rows


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_session(
    session_id: str,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    # "הוספת מכשירים": the super admin may have taken it from this role (app/services/access.py).
    access.require_feature(db, current_user, access.PAIR_DEVICES)
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
            device_model=body.device_model,
        )
    except PairingMobileError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except TM.DeviceUnsupported as refused:
        # A Windows / browser device into a shop in training mode ("מצב הדרכה"): nothing created.
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    return MobileClaimResponse(
        machine_id=machine.id,
        machine_code=machine.machine_code,
        company_name=company.name,
        shop_name=shop.name,
        pos_number=machine.pos_number,
    )


@router.get("/mobile/shops/{shop_id}/next-register-number")
def mobile_next_register_number(
    shop_id: uuid_mod.UUID,
    session_user: tuple = Depends(get_pairing_session_user),
    db: Session = Depends(get_db),
):
    """
    Field install: the register number the next till claimed into this shop would get.

    The field-install page authenticates with a pairing-session token, not a dashboard
    login, so it cannot call `GET /shops/{id}/next-register-number`. Same peek, scoped
    to the session's tenant. Never allocates.
    """
    session, _user = session_user
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if not shop or shop.tenant_id != session.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    return {
        "shopId": str(shop.id),
        "nextRegisterNumber": peek_next_register_number(db, shop.id),
    }


@router.post("/device/register", response_model=DeviceRegisterResponse, status_code=status.HTTP_201_CREATED)
def device_register(
    body: DeviceRegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    check_rate_limit(request, "device_register", max_calls=100, window_seconds=60)
    row = register_device_pairing_request(
        db,
        device_info=body.device_info,
        machine_name=body.machine_name,
    )
    return DeviceRegisterResponse(
        device_nonce=row.device_nonce, expires_at=row.expires_at,
        device_code=row.device_code, code_expires_at=row.code_expires_at,
    )


# ── "צימוד מהענן" (P:/specs/foreign-records-upload.md §5.2, §6.2) ─────────────


@router.get("/code-preview")
def pairing_code_preview(
    request: Request,
    code: str = Query(..., min_length=1, max_length=32),
    db: Session = Depends(get_db),
):
    """
    What a pairing code pairs to, before the device redeems it (no auth, rate-limited per IP):
    `{"bound": true, machineId, machineName, posNumber, shopName, companyName}` for a code bound to an
    existing machine, `{"bound": false, shopName, companyName}` otherwise; 404 unknown / used / expired.
    """
    from app.services import cloud_pairing

    check_rate_limit(request, "pairing_code_preview", max_calls=30, window_seconds=60)
    out = cloud_pairing.code_preview(db, code)
    if out is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="pairing_code_unknown")
    return out


@router.get("/device-requests")
def list_device_requests(
    shop_id: Optional[uuid_mod.UUID] = Query(None, alias="shopId"),
    code: Optional[str] = Query(None, max_length=16),
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "מכשירים שממתינים לצימוד": waiting devices whose last pairing was in this tenant (narrowed to a shop),
    plus any waiting device by its exact `code`: [{id, deviceCode, codeExpiresAt, platform, model, serial,
    machineName, lastPairing, registeredAt}].
    """
    from app.services import cloud_pairing

    access.require_feature(db, current_user, access.PAIR_DEVICES)
    return {"items": cloud_pairing.list_requests(db, active_tenant_id, shop_id=shop_id, code=code)}


@router.post("/device-requests/claim")
def claim_device_request(
    body: DeviceRequestClaimIn,
    current_user: User = Depends(get_current_distributor),
    active_tenant_id: uuid_mod.UUID = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Claim a waiting device by its code: with `machineId` it becomes that existing machine (a bound code —
    the re-pair / replacement rules); without, a new machine in `shopId`. `confirm: true` required (422
    `confirm_required`). 404 `device_code_unknown`; 409 `adoption_refused` (an open shift of another
    device, card sales not transmitted) / `shop_inactive`. The credentials go to the device's nonce poll.
    """
    from app.services import cloud_pairing
    from app.services import display_devices

    access.require_feature(db, current_user, access.PAIR_DEVICES)
    if not body.confirm:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "confirm_required", "message": "יש לאשר את הצימוד"},
        )
    try:
        _row, _machine, out = cloud_pairing.claim(
            db, current_user, active_tenant_id, device_code=body.device_code, machine_id=body.machine_id,
            company_id=body.company_id, shop_id=body.shop_id, machine_name=body.machine_name,
        )
    except display_devices.PlatformMismatch as exc:
        db.rollback()
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content=exc.body)
    except TM.DeviceUnsupported as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    return out


@router.get("/device/{nonce}/status")
def device_poll_status(
    nonce: str,
    db: Session = Depends(get_db),
):
    poll_status, payload = poll_device_credentials(db, nonce)
    if poll_status == "waiting":
        return DevicePollWaitingResponse()
    if poll_status == "expired":
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Device pairing request expired")
    if poll_status == "gone":
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Credentials already delivered or unknown device")
    return payload
