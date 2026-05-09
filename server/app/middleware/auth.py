from typing import Optional
import uuid
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.user import User, UserRole
from app.models.pos_machine import POSMachine
from app.models.tenant_membership import TenantMembership
from app.services.clerk_auth import verify_clerk_token
from app.services.auth import decode_token, decode_jwt_payload

security = HTTPBearer()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """Authenticate via Clerk JWT. Falls back to legacy username token (not machine JWT)."""
    token = credentials.credentials
    payload = decode_jwt_payload(token)
    if payload and payload.get("type") == "machine":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Use machine-specific endpoints with this token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _resolve_user_from_bearer_token(token, db)


def get_current_super_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Super admin access required")
    return current_user


def get_current_distributor(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in [UserRole.DISTRIBUTOR, UserRole.SUPER_ADMIN]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Distributor access required")
    return current_user


def get_current_merchant(current_user: User = Depends(get_current_user)) -> User:
    allowed = [
        UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
        UserRole.DISTRIBUTOR, UserRole.SUPER_ADMIN,
    ]
    if current_user.role not in allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Merchant access required")
    return current_user


def _check_machine_access(user: User, machine: POSMachine):
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return
    if user.role == UserRole.MERCHANT_ADMIN and machine.merchant_id == user.merchant_id:
        return
    if user.role == UserRole.COMPANY_MANAGER and machine.shop and machine.shop.company_id == user.company_id:
        return
    if user.role in (UserRole.SHOP_MANAGER, UserRole.CASHIER) and machine.shop_id == user.shop_id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def get_pos_machine_for_sync_path(
    machine_id: str,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> POSMachine:
    """
    Resolve POSMachine for /sync/{machine_id}/... using either:
    - Machine JWT (type=machine, sub must equal machine_id), or
    - Clerk / legacy user JWT with RBAC (same rules as dashboard).
    """
    token = credentials.credentials
    payload = decode_jwt_payload(token)
    if payload and payload.get("type") == "machine":
        if str(payload.get("sub")) != str(machine_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Machine token does not match machineId in path",
            )
        machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
        if not machine:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
        # Decommissioned devices (DELETE /machines/{id} → soft mode) keep their
        # row for FK integrity but must be locked out of sync immediately so the
        # old machine token stops working.
        if not machine.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Machine has been removed")
        return machine

    current_user = _resolve_user_from_bearer_token(token, db)
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    if not machine.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Machine has been removed")
    _check_machine_access(current_user, machine)
    return machine


def _resolve_user_from_bearer_token(token: str, db: Session) -> User:
    """Shared user resolution for Clerk and legacy username tokens (raises on failure)."""
    clerk_user_id = verify_clerk_token(token)
    if clerk_user_id:
        user = db.query(User).filter(User.clerk_user_id == clerk_user_id).first()
        if user is None:
            user = (
                db.query(User)
                .filter(User.clerk_user_id.is_(None), User.role == UserRole.SUPER_ADMIN)
                .first()
            )
            if user:
                user.clerk_user_id = clerk_user_id
                db.commit()
                db.refresh(user)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not provisioned. Contact your administrator.",
            )
        if not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user")
        return user

    token_data = decode_token(token)
    if token_data and token_data.username:
        user = db.query(User).filter(User.username == token_data.username).first()
        if user and user.is_active:
            return user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user_flexible(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """Same as get_current_user but delegates to _resolve_user_from_bearer_token."""
    return _resolve_user_from_bearer_token(credentials.credentials, db)


def get_pos_machine_from_machine_token(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> POSMachine:
    """Machine JWT only: sub is machine UUID. Used for GET /machines/me."""
    token = credentials.credentials
    payload = decode_jwt_payload(token)
    if not payload or payload.get("type") != "machine" or not payload.get("sub"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Machine authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    machine_id = str(payload.get("sub"))
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    if not machine.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Machine has been removed")
    return machine


def get_active_tenant_id(
    x_tenant_id: Optional[str] = Header(None, alias="X-Tenant-Id"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> uuid.UUID:
    if not x_tenant_id:
        single = (
            db.query(TenantMembership.tenant_id)
            .filter(TenantMembership.user_id == current_user.id)
            .order_by(TenantMembership.is_default.desc(), TenantMembership.created_at.asc())
            .limit(2)
            .all()
        )
        if len(single) == 1:
            return single[0][0]
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing X-Tenant-Id header",
        )
    try:
        tenant_id = uuid.UUID(str(x_tenant_id))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid X-Tenant-Id",
        ) from exc

    if current_user.role == UserRole.SUPER_ADMIN:
        return tenant_id

    membership = (
        db.query(TenantMembership)
        .filter(
            TenantMembership.user_id == current_user.id,
            TenantMembership.tenant_id == tenant_id,
        )
        .first()
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="tenant_forbidden",
        )
    return tenant_id


def ensure_same_tenant(entity_tenant_id: Optional[uuid.UUID], active_tenant_id: uuid.UUID) -> None:
    if entity_tenant_id is not None and entity_tenant_id != active_tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
