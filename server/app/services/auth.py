from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from app.config import get_settings
from app.models.user import User, UserRole
from app.schemas.auth import TokenData

settings = get_settings()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against a hash"""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """Hash a password"""
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token"""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.jwt_access_token_expire_minutes)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return encoded_jwt


def create_machine_token(machine_id: str, token_version: int = 1) -> str:
    """
    Mint a machine token that does not expire on its own.

    A terminal is not a person: it does not sign in each morning, and an expiry is
    not a security control for it — it is a scheduled outage. A till whose token
    lapsed at 6am on a Sunday is simply a till that cannot trade, and nobody is on
    site to re-pair it.

    Not expiring is only safe because revocation is checked on *every* request
    rather than trusted to the clock: `get_pos_machine_for_sync_path` and
    `get_pos_machine_from_machine_token` both load the row and refuse an inactive
    machine. `token_version` closes the remaining gap — unpairing bumps it, so a
    terminal that is later re-paired and made active again does not resurrect the
    tokens it held before.

    Old tokens carry no `tv` claim. Those are read as version 1, which is the column
    default, so every terminal paired before this change keeps working untouched.
    """
    data = {"sub": machine_id, "type": "machine", "tv": int(token_version or 1)}
    # Deliberately no `exp`: python-jose only enforces the claim when it is present.
    return jwt.encode(data, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_pairing_session_token(
    distributor_id: str,
    tenant_id: str,
    jti: str,
    expires_hours: int | None = None,
) -> str:
    """Scoped JWT for mobile field-install (no Clerk on phone)."""
    if expires_hours is None:
        expires_hours = settings.pairing_session_expire_hours
    expires_delta = timedelta(hours=expires_hours)
    data = {
        "sub": distributor_id,
        "tenant_id": tenant_id,
        "jti": jti,
        "type": "pairing_session",
    }
    return create_access_token(data, expires_delta)


def decode_token(token: str) -> Optional[TokenData]:
    """Decode and validate a JWT token"""
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        username: str = payload.get("sub")
        user_id: str = payload.get("user_id")
        role: str = payload.get("role")
        if username is None:
            return None
        token_data = TokenData(username=username, user_id=user_id, role=role)
        return token_data
    except JWTError:
        return None


def decode_jwt_payload(token: str) -> Optional[dict]:
    """Return full JWT claims dict (including type=machine) or None if invalid."""
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None


def authenticate_user(db: Session, username: str, password: str) -> Optional[User]:
    """Authenticate a user by username and password"""
    user = db.query(User).filter(User.username == username).first()
    if not user:
        return None
    if not user.hashed_password:
        # Invited and Clerk-provisioned accounts carry no local password. Passing
        # None to passlib raises rather than returning False, which would turn a
        # wrong-credentials attempt into a 500 and, worse, distinguish these
        # accounts from ordinary ones by the shape of the failure.
        return None
    if not verify_password(password, user.hashed_password):
        return None
    if not user.is_active:
        return None
    return user


def get_user_by_username(db: Session, username: str) -> Optional[User]:
    """Get a user by username"""
    return db.query(User).filter(User.username == username).first()


def check_role_permission(user_role: UserRole, required_roles: list[UserRole]) -> bool:
    """Check if user role has permission based on required roles"""
    if UserRole.SUPER_ADMIN in required_roles:
        return user_role == UserRole.SUPER_ADMIN
    return user_role in required_roles

