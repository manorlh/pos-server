"""
Lazy Clerk user provisioning on first authenticated request (no webhook).
"""
from __future__ import annotations

import re
import uuid
from typing import Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import User, UserRole
from app.services.clerk_profile import ClerkProfile, fetch_clerk_profile

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_USERNAME_RE = re.compile(r"[^a-zA-Z0-9_]")


def resolve_clerk_user(db: Session, clerk_user_id: str, *, allow_self_service: bool) -> Optional[User]:
    """
    Find, link, or provision an internal user for a verified Clerk session.
    Returns None when the caller should respond with 'not provisioned'.
    """
    user = db.query(User).filter(User.clerk_user_id == clerk_user_id).first()
    if user:
        return user

    user = _link_unclaimed_super_admin(db, clerk_user_id)
    if user:
        return user

    profile = fetch_clerk_profile(clerk_user_id)
    if profile:
        user = _link_invited_user_by_email(db, clerk_user_id, profile.email)
        if user:
            return user

    if not allow_self_service or profile is None:
        return None

    return _provision_self_service_user(db, clerk_user_id, profile)


def _link_unclaimed_super_admin(db: Session, clerk_user_id: str) -> Optional[User]:
    user = (
        db.query(User)
        .filter(User.clerk_user_id.is_(None), User.role == UserRole.SUPER_ADMIN)
        .first()
    )
    if not user:
        return None
    user.clerk_user_id = clerk_user_id
    db.commit()
    db.refresh(user)
    return user


def _link_invited_user_by_email(db: Session, clerk_user_id: str, email: str) -> Optional[User]:
    user = (
        db.query(User)
        .filter(func.lower(User.email) == email.lower(), User.clerk_user_id.is_(None))
        .first()
    )
    if not user:
        return None
    user.clerk_user_id = clerk_user_id
    db.commit()
    db.refresh(user)
    return user


def _provision_self_service_user(db: Session, clerk_user_id: str, profile: ClerkProfile) -> Optional[User]:
    try:
        tenant = Tenant(
            name=_unique_tenant_name(db, profile),
            slug=_unique_slug(db, profile),
            timezone="Asia/Jerusalem",
            default_currency="ILS",
            locale="he-IL",
        )
        user = User(
            clerk_user_id=clerk_user_id,
            email=profile.email,
            username=_unique_username(db, profile),
            hashed_password=None,
            role=UserRole.DISTRIBUTOR,
            is_active=True,
        )
        db.add(tenant)
        db.add(user)
        db.flush()

        tenant.created_by_user_id = user.id
        user.tenant_id = tenant.id
        db.add(
            TenantMembership(
                tenant_id=tenant.id,
                user_id=user.id,
                role=TenantMembershipRole.TENANT_OWNER,
                is_default=True,
            )
        )
        db.commit()
        db.refresh(user)
        return user
    except IntegrityError:
        db.rollback()
        return db.query(User).filter(User.clerk_user_id == clerk_user_id).first()


def _tenant_display_name(profile: ClerkProfile) -> str:
    parts = [profile.first_name, profile.last_name]
    name = " ".join(p for p in parts if p).strip()
    if name:
        return name
    local = profile.email.split("@", 1)[0]
    return local or "My workspace"


def _unique_tenant_name(db: Session, profile: ClerkProfile) -> str:
    base = _tenant_display_name(profile)[:240]
    for attempt in range(8):
        suffix = "" if attempt == 0 else f" ({uuid.uuid4().hex[:4]})"
        name = f"{base}{suffix}"[:255]
        exists = db.query(Tenant.id).filter(Tenant.name == name).first()
        if not exists:
            return name
    return f"{base} {uuid.uuid4().hex[:6]}"[:255]


def _unique_slug(db: Session, profile: ClerkProfile) -> str:
    base = _slugify(_tenant_display_name(profile)) or _slugify(profile.email.split("@", 1)[0]) or "workspace"
    for attempt in range(8):
        suffix = "" if attempt == 0 else f"-{uuid.uuid4().hex[:6]}"
        slug = f"{base}{suffix}"[:255]
        exists = db.query(Tenant.id).filter(Tenant.slug == slug).first()
        if not exists:
            return slug
    return f"{base}-{uuid.uuid4().hex[:8]}"[:255]


def _unique_username(db: Session, profile: ClerkProfile) -> str:
    candidates = []
    if profile.clerk_username:
        candidates.append(_sanitize_username(profile.clerk_username))
    candidates.append(_sanitize_username(profile.email.split("@", 1)[0]))
    candidates.append(_sanitize_username(profile.clerk_user_id.replace("user_", "clerk_")))

    for base in candidates:
        if not base:
            continue
        for attempt in range(8):
            suffix = "" if attempt == 0 else f"_{uuid.uuid4().hex[:4]}"
            username = f"{base}{suffix}"[:100]
            exists = db.query(User.id).filter(User.username == username).first()
            if not exists:
                return username
    return f"user_{uuid.uuid4().hex[:8]}"[:100]


def _slugify(value: str) -> str:
    slug = _SLUG_RE.sub("-", value.lower()).strip("-")
    return slug[:200]


def _sanitize_username(value: str) -> str:
    cleaned = _USERNAME_RE.sub("_", value.strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned[:80]
