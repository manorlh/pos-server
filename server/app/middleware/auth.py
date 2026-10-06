from dataclasses import dataclass
from typing import Optional, Tuple
import uuid
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.user import User, UserRole
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.pairing_session import PairingSession
from app.models.tenant_membership import TenantMembership
from app.services.clerk_auth import verify_clerk_token
from app.services.clerk_provision import resolve_clerk_user
from app.config import get_settings
from app.services.auth import decode_token, decode_jwt_payload
from app.services.company_hierarchy import user_covers_company, user_may_use_machine
from app.services.pairing_mobile import get_valid_pairing_session
from app.models.elevated_session import ElevatedSession
from app.services.elevation import (
    consume_per_action_use,
    resolve_session,
    session_has_scope,
)
from app.services.permissions import Scope, pos_user_till_scopes, requires_per_action_reauth
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


def _machine_from_sync_token(payload: dict, machine_id: str, db: Session) -> POSMachine:
    """The machine a machine JWT names, for /sync/{machine_id}/… (sub must match)."""
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


def _check_sync_user_tenancy(db: Session, user: User, machine: POSMachine) -> None:
    """
    A dashboard user acting on /sync/{machine_id}/… must be in the machine's tenant.

    `_check_machine_access` is role-only for a distributor and a super admin, and these
    paths carry no `X-Tenant-Id`, so a user token reached any tenant's till. Now: a
    super admin passes; a distributor only for their own terminals; anyone else only
    for a till of a tenant they are a member of — never a till with no tenant.
    """
    if user.role == UserRole.SUPER_ADMIN:
        return
    if user.role == UserRole.DISTRIBUTOR:
        if str(machine.distributor_id) != str(user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        return
    if machine.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
    member = (
        db.query(TenantMembership.id)
        .filter(
            TenantMembership.user_id == user.id,
            TenantMembership.tenant_id == machine.tenant_id,
        )
        .first()
    )
    if member is None and str(getattr(user, "tenant_id", None)) != str(machine.tenant_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")


def get_pos_machine_for_sync_path(
    machine_id: str,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> POSMachine:
    """
    Resolve POSMachine for /sync/{machine_id}/... using either:
    - Machine JWT (type=machine, sub must equal machine_id), or
    - Clerk / legacy user JWT with RBAC (same rules as dashboard), in the machine's
      tenant (`_check_sync_user_tenancy`).
    """
    token = credentials.credentials
    payload = decode_jwt_payload(token)
    if payload and payload.get("type") == "machine":
        return _machine_from_sync_token(payload, machine_id, db)

    current_user = _resolve_user_from_bearer_token(token, db)
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    if not machine.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Machine has been removed")
    _check_machine_access(current_user, machine, db)
    _check_sync_user_tenancy(db, current_user, machine)
    _bind_machine_context(machine)
    return machine


#: 403 detail for a dashboard (user) token on a till-only endpoint.
MACHINE_TOKEN_REQUIRED = "machine_token_required"


def get_pos_machine_from_sync_machine_token(
    machine_id: str,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> POSMachine:
    """
    Machine JWT only, for the till's own shift writes (open, close, ack, last-closed).

    A shift is opened and closed by its till; nobody at a desk has any business filing
    a close with a count, or acknowledging a close instruction, in a till's name. A
    user token is refused (403 `machine_token_required`) rather than admitted with RBAC.
    """
    payload = decode_jwt_payload(credentials.credentials)
    if not payload or payload.get("type") != "machine":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MACHINE_TOKEN_REQUIRED)
    return _machine_from_sync_token(payload, machine_id, db)


# ── "מכשיר תצוגה אינו קופה" (docs/SPEC_DEVICE_ROLE_MODEL.md §2.2) ──────────────────────
# A KDS screen / the "מוכן / לא מוכן" board (`pos_machines.is_fiscal` false) sells nothing:
# every fiscal till endpoint — documents, shifts, Z, transmissions, payments, vouchers,
# tables, kiosk orders — carries one of these (`dependencies=FISCAL_SYNC_PATH` /
# `FISCAL_MACHINE_TOKEN`, matching the route's own machine dependency, which FastAPI then
# resolves once). 403 `{"detail": "device_not_fiscal", "message": <Hebrew>}`.
# tests/test_display_devices.py walks `app.routes`: a new till write must be classified.


def require_fiscal_machine(machine: POSMachine = Depends(get_pos_machine_for_sync_path)) -> POSMachine:
    """`get_pos_machine_for_sync_path`, refusing a display device (403 `device_not_fiscal`)."""
    from app.services.display_devices import refuse_unless_fiscal

    refuse_unless_fiscal(machine)
    return machine


def require_fiscal_machine_token(
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
) -> POSMachine:
    """`get_pos_machine_from_sync_machine_token`, refusing a display device (403 `device_not_fiscal`)."""
    from app.services.display_devices import refuse_unless_fiscal

    refuse_unless_fiscal(machine)
    return machine


#: For a route whose machine comes from `get_pos_machine_for_sync_path`.
FISCAL_SYNC_PATH = [Depends(require_fiscal_machine)]
#: For a route whose machine comes from `get_pos_machine_from_sync_machine_token`.
FISCAL_MACHINE_TOKEN = [Depends(require_fiscal_machine_token)]


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


def _elevation_401(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": ELEVATION_HEADER},
    )


def _checked_grant(
    db: Session, machine: POSMachine, raw_token: str, scope: Scope
) -> ElevatedSession:
    """
    Resolve `raw_token` into a grant good for `scope` at `machine`, or raise.

    Does not spend a per-action grant — resolving is not acting. The caller decides
    when the action is actually happening and calls `consume_per_action_use` then.
    """
    session = resolve_session(db, raw_token)
    if session is None:
        # Expired, revoked, unknown, or held by someone since deactivated or
        # demoted. Not distinguished on the wire: the till's only useful response
        # to any of them is to ask for a PIN again.
        raise _elevation_401("elevation_expired")
    if str(session.machine_id) != str(machine.id):
        # A grant is bound to the till it was issued at, so one cannot be carried
        # to a second terminal in the same shop.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="elevation_wrong_machine",
        )
    if not session_has_scope(session, scope):
        # Two different refusals wearing one check. A scope never granted is a 403:
        # this person cannot authorise this, and a different person is needed. A
        # per-action scope already spent is a 401: the same person can, they just
        # have to type their PIN again, which is exactly what one-PIN-one-action
        # means.
        if scope.value in (session.scopes or []):
            raise _elevation_401("elevation_already_used")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"elevation_missing_scope:{scope.value}",
        )
    return session


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

    A per-action scope is spent here, in the dependency: for these endpoints the
    request *is* the action, so there is no later point at which the decision to act
    is still open. An endpoint that can still refuse the work after authenticating —
    the Z upsert, which may answer 409 and ask the till to flush and retry — must use
    `elevation_if_offered` and consume for itself, or a retry finds the PIN burned.
    """

    def dependency(
        machine: POSMachine = Depends(get_pos_machine_for_sync_path),
        elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
        db: Session = Depends(get_db),
    ) -> ElevatedSession:
        if not elevation_token:
            raise _elevation_401("elevation_required")
        session = _checked_grant(db, machine, elevation_token, scope)
        if requires_per_action_reauth(scope) and not consume_per_action_use(db, session):
            # Lost a race with another request holding the same token. The read above
            # said unspent; the locked re-read said otherwise, and the locked one wins.
            raise _elevation_401("elevation_already_used")
        return session

    return dependency


#: Which till user is signed in at the calling till. Sent on catalog writes so a shop
#: manager's own authority can stand in for a grant. See `require_catalog_authority`.
POS_USER_HEADER = "X-Pos-User-Id"


@dataclass(frozen=True)
class CatalogActor:
    """
    Who a catalog write is attributed to. Exactly one field is set.

    `user_id` when a cloud account's grant authorised it; `pos_user_id` when a till user
    did — through a grant they took by username, or on their own signature with none.
    """

    user_id: Optional[uuid.UUID] = None
    pos_user_id: Optional[uuid.UUID] = None


def _operator_with_authority(
    db: Session, machine: POSMachine, raw_id: Optional[str], scope: Scope
) -> Optional[PosUser]:
    """The signed-in till user named by `raw_id`, if they may do `scope` at `machine` alone."""
    if not raw_id or machine.shop_id is None:
        return None
    try:
        pos_user_id = uuid.UUID(str(raw_id).strip())
    except ValueError:
        return None
    operator = (
        db.query(PosUser)
        .filter(
            PosUser.id == pos_user_id,
            # Their own shop only. A till cannot lend its authority to a user from
            # another shop by naming them, because the name has to resolve *here*.
            PosUser.shop_id == machine.shop_id,
            PosUser.is_active.is_(True),
        )
        .first()
    )
    if operator is None or scope not in pos_user_till_scopes(operator.role):
        return None
    return operator


def require_catalog_authority(scope: Scope = Scope.CATALOG_WRITE):
    """
    Build a dependency that accepts a grant for `scope`, *or* a signed-in operator who holds it.

    `require_elevated` demanded a grant from everybody, so a shop manager signed in at
    their own till typed their own PIN a second time to fix a price. That second PIN
    was never what bounded the damage: every catalog endpoint confines a till's write to
    the till's shop by itself — price and listing land on the shop's override row, a
    master another shop lists answers 403, a category rename lands on the shop's own
    override. What the grant added was a name for the audit, and the signed-in operator
    is a name.

    **What this trusts.** The till's word for who is signed in — the same word the cloud
    already takes for `cashier_id` on every document it files. Bounded by the machine
    token (a till speaks only for its own shop) and by the cloud's own roster: the
    operator must be an active till user of this machine's shop whose role, read here
    and not from the till, carries `scope`. A till naming a cashier gets nothing.

    **Order.** A grant, when presented, wins and is checked exactly as strictly as
    before — a cashier's till with a manager's grant attributes the write to the manager.
    With neither a usable grant nor an operator who holds the scope, the answer is the
    same 401 `elevation_required`, which is what makes the till ask for someone who does.
    """

    def dependency(
        machine: POSMachine = Depends(get_pos_machine_for_sync_path),
        elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
        operator_id: Optional[str] = Header(None, alias=POS_USER_HEADER),
        db: Session = Depends(get_db),
    ) -> CatalogActor:
        if elevation_token:
            session = _checked_grant(db, machine, elevation_token, scope)
            if requires_per_action_reauth(scope) and not consume_per_action_use(db, session):
                raise _elevation_401("elevation_already_used")
            return CatalogActor(user_id=session.user_id, pos_user_id=session.pos_user_id)

        operator = _operator_with_authority(db, machine, operator_id, scope)
        if operator is None:
            raise _elevation_401("elevation_required")
        return CatalogActor(pos_user_id=operator.id)

    return dependency


def elevation_if_offered(scope: Scope):
    """
    Build a dependency that accepts a grant for `scope` if one is presented, else None.

    For endpoints elevation cannot be made mandatory on. The person standing at a
    till is a `pos_users` row — admin, manager or cashier — and that enum is not the
    cloud `users` enum grants are issued from. A till whose own operator already has
    the authority never elevates at all, so demanding a token here would break the
    ordinary case: a manager-operated till closing its own day.

    So: absent means "no claim of approval", which is normal and proceeds. Present
    means the claim is checked as strictly as `require_elevated` checks it, and a bad
    token fails the request rather than being quietly ignored — a token that is
    expired, for the wrong till, or already spent is a signal, not noise.

    Deliberately does *not* consume. The caller acts first on its own preconditions
    and consumes only when the action is certain.
    """

    def dependency(
        machine: POSMachine = Depends(get_pos_machine_for_sync_path),
        elevation_token: Optional[str] = Header(None, alias=ELEVATION_HEADER),
        db: Session = Depends(get_db),
    ) -> Optional[ElevatedSession]:
        if not elevation_token:
            return None
        return _checked_grant(db, machine, elevation_token, scope)

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
