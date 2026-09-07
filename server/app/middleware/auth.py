from typing import Optional, Tuple
import uuid
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.user import User, UserRole
from app.models.pos_machine import POSMachine
from app.models.pairing_session import PairingSession
from app.models.tenant_membership import TenantMembership
from app.services.clerk_auth import verify_clerk_token
from app.services.clerk_provision import resolve_clerk_user
from app.config import get_settings
from app.services.auth import decode_token, decode_jwt_payload
from app.services.company_hierarchy import user_covers_company, user_may_use_machine
from app.services.pairing_mobile import get_valid_pairing_session
from app.models.elevated_session import ElevatedSession
from app.services.elevation import resolve_session, session_has_scope
from app.services.permissions import Scope
from app.observability.context import set_request_context

security = HTTPBearer()
pairing_session_security = HTTPBearer(auto_error=True)
settings = get_settings()


def _bind_user_context(user: User) -> None:
    set_request_context(user_id=str(user.id))


def _bind_machine_context(machine: POSMachine) -> None:
    kwargs: dict[str, str] = {"machine_id": str(machine.id)}
    if machine.tenant_id is not None:
        kwargs["tenant_id"] = str(machine.tenant_id)
    set_request_context(**kwargs)


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
    if payload and payload.get("type") == "pairing_session":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Use mobile pairing endpoints with this token",
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


def get_current_machine_admin(current_user: User = Depends(get_current_user)) -> User:
    allowed = [
        UserRole.COMPANY_MANAGER, UserRole.SHOP_MANAGER,
        UserRole.DISTRIBUTOR, UserRole.SUPER_ADMIN,
    ]
    if current_user.role not in allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Machine admin access required")
    return current_user


def _check_machine_access(user: User, machine: POSMachine, db: Session):
    # The rule itself lives in company_hierarchy so the till's elevation grant and
    # this dashboard check cannot drift apart.
    if not user_may_use_machine(db, user, machine):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _require_current_token_version(payload: dict, machine: POSMachine) -> None:
    """
    Refuse a token minted before this terminal was last unpaired.

    Machine tokens no longer expire, so this is what makes revocation real: an admin
    unpairing bumps `token_version`, and every token issued under the old one stops
    working the instant it is next used — permanently, even if the terminal is
    re-paired and its row becomes active again.

    A token with no `tv` claim was minted before versioning existed and is read as
    version 1, matching the column default, so terminals paired before this change
    keep working until somebody actually unpairs them.
    """
    presented = payload.get("tv", 1)
    current = getattr(machine, "token_version", 1) or 1
    try:
        presented = int(presented)
    except (TypeError, ValueError):
        presented = 0
    if presented != int(current):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Machine token revoked; re-pair this terminal",
            headers={"WWW-Authenticate": "Bearer"},
        )


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
        _require_current_token_version(payload, machine)
        _bind_machine_context(machine)
        return machine

    current_user = _resolve_user_from_bearer_token(token, db)
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    if not machine.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Machine has been removed")
    _check_machine_access(current_user, machine, db)
    _bind_machine_context(machine)
    return machine


def _resolve_user_from_bearer_token(token: str, db: Session) -> User:
    """Shared user resolution for Clerk and legacy username tokens (raises on failure)."""
    clerk_user_id = verify_clerk_token(token)
    if clerk_user_id:
        user = resolve_clerk_user(
            db,
            clerk_user_id,
            allow_self_service=settings.allow_self_service_signup,
        )
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not provisioned. Contact your administrator.",
            )
        if not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user")
        _bind_user_context(user)
        return user

    token_data = decode_token(token)
    if token_data and token_data.username:
        user = db.query(User).filter(User.username == token_data.username).first()
        if user and user.is_active:
            _bind_user_context(user)
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
    _require_current_token_version(payload, machine)
    _bind_machine_context(machine)
    return machine


ELEVATION_HEADER = "X-Elevation-Token"


def require_elevated(scope: Scope):
    """
    Build a dependency that demands a live grant for `scope` at *this* machine.

    Two credentials, not one. `Authorization` still carries the machine token — it
    says which till is calling and, through the machine's shop, caps how far any
    grant can reach. The `X-Elevation-Token` header carries the grant itself, which
    says which person authorised this and what they may do. Neither is sufficient:
    a stolen machine token cannot write without a person, and a leaked grant is
    useless without the paired till it was issued to.

    The machine-token check is `get_pos_machine_for_sync_path`, so these endpoints
    keep the same 403 for a token whose `sub` does not match the path, and the same
    lockout for a decommissioned till.
    """

    def dependency(
        machine: POSMachine = Depends(get_pos_machine_for_sync_path),
        elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
        db: Session = Depends(get_db),
    ) -> ElevatedSession:
        if not elevation_token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="elevation_required",
                headers={"WWW-Authenticate": ELEVATION_HEADER},
            )
        session = resolve_session(db, elevation_token)
        if session is None:
            # Expired, revoked, unknown, or held by someone since deactivated or
            # demoted. Not distinguished on the wire: the till's only useful
            # response to any of them is to ask for a PIN again.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="elevation_expired",
                headers={"WWW-Authenticate": ELEVATION_HEADER},
            )
        if str(session.machine_id) != str(machine.id):
            # A grant is bound to the till it was issued at, so one cannot be
            # carried to a second terminal in the same shop.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="elevation_wrong_machine",
            )
        if not session_has_scope(session, scope):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"elevation_missing_scope:{scope.value}",
            )
        return session

    return dependency


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
            tenant_id = single[0][0]
            set_request_context(tenant_id=str(tenant_id))
            return tenant_id
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
        set_request_context(tenant_id=str(tenant_id))
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
    set_request_context(tenant_id=str(tenant_id))
    return tenant_id


def ensure_same_tenant(entity_tenant_id: Optional[uuid.UUID], active_tenant_id: uuid.UUID) -> None:
    if entity_tenant_id is not None and entity_tenant_id != active_tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")


def get_pairing_session_user(
    credentials: HTTPAuthorizationCredentials = Depends(pairing_session_security),
    db: Session = Depends(get_db),
) -> Tuple[PairingSession, User]:
    """Mobile field-install: pairing_session JWT only."""
    token = credentials.credentials
    payload = decode_jwt_payload(token)
    if not payload or payload.get("type") != "pairing_session":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Pairing session token required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    jti = payload.get("jti")
    if not jti:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid pairing session token",
        )
    session = get_valid_pairing_session(db, str(jti))
    if not session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Pairing session expired or revoked",
        )
    try:
        distributor_id = uuid.UUID(str(payload.get("sub")))
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid pairing session token",
        ) from exc
    if session.distributor_id != distributor_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid pairing session token",
        )
    user = db.query(User).filter(User.id == distributor_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user")
    if user.role not in (UserRole.DISTRIBUTOR, UserRole.SUPER_ADMIN):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Distributor access required")
    token_tenant = payload.get("tenant_id")
    if token_tenant and str(session.tenant_id) != str(token_tenant):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid pairing session token")
    set_request_context(user_id=str(user.id), tenant_id=str(session.tenant_id))
    return session, user
