"""
"התראות בנייד שחובה להפעיל" (P:/specs/pwa-push-required.md, app/services/push_policy.py): the
dashboard's check on every open, and the policy's editors at each level.

GET /push/status?endpointHash=          → {required, source, default, devices, lastSuccessAt, tone,
                                           thisDeviceRegistered, thisDevice, configured, publicKey}
                                           (the caller's own: route rule SELF)
GET /companies/{id}/push-policy         → the company's own policy, what it inherits, the catalogue
PUT /companies/{id}/push-policy         → {required: mode | null, notify: {category: {...} | null}}
                                           (section "users" or "organization"; a company manager
                                           of the company, a distributor or the super admin)
GET /dashboard-access/push-policy       → per template and per role (the super admin's)
PUT /dashboard-access/push-policy       → {templates: {key: policy | null}, roles: {role: policy | null}}
GET /users/{id}/push-policy             → the user's own policy, the resolved one and their devices
PUT /users/{id}/push-policy             → {required: mode | null, notify?: {...}} (whoever may edit
                                           that user — never oneself, except the super admin)

A level's body replaces what that level sets; null / absent = inherit.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_super_admin, get_current_user
from app.models.company import Company
from app.models.user import User, UserRole
from app.services import push_policy as PP

router = APIRouter(tags=["push-policy"])

COMPANY_WRITE_ROLES = {UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER}


def _policy_error(exc: PP.PolicyError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"code": exc.code, "field": exc.field, "detail": exc.detail},
    )


def _clean(body: Any) -> Dict[str, Any]:
    try:
        return PP.clean_policy(body, strict=True)
    except PP.PolicyError as exc:
        raise _policy_error(exc) from None


# ── This device ──────────────────────────────────────────────────────────────


@router.get("/push/status")
def push_status(
    endpoint_hash: Optional[str] = Query(None, alias="endpointHash", max_length=64),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Every open of the dashboard on a phone: must notifications be on, and are they here."""
    return PP.status_for(db, current_user, active_tenant_id, endpoint_hash)


# ── Company ──────────────────────────────────────────────────────────────────


def _company(db: Session, company_id: uuid.UUID, user: User, active_tenant_id) -> Company:
    from app.routers.companies import _check_company_access

    company = db.get(Company, company_id)
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, active_tenant_id)
    _check_company_access(user, company, db)
    return company


def _company_out(db: Session, company: Company) -> Dict[str, Any]:
    return {
        "companyId": str(company.id),
        "policy": PP.policy_json(PP.company_policy(company)),
        "inherited": {
            "required": PP.inherited_company_required(db, company),
            "notify": PP.inherited_company_notify(db, company),
        },
        "catalogue": PP.catalogue_json(),
    }


@router.get("/companies/{company_id}/push-policy")
def get_company_push_policy(
    company_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _company(db, company_id, current_user, active_tenant_id)
    return {**_company_out(db, company), "canEdit": _may_write_company(db, current_user, company)}


def _may_write_company(db: Session, user: User, company: Company) -> bool:
    from app.services.company_hierarchy import user_covers_company

    if user.role not in COMPANY_WRITE_ROLES:
        return False
    return user.role != UserRole.COMPANY_MANAGER or user_covers_company(db, user, company.id)


@router.put("/companies/{company_id}/push-policy")
def put_company_push_policy(
    company_id: uuid.UUID,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _company(db, company_id, current_user, active_tenant_id)
    if not _may_write_company(db, current_user, company):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    PP.set_company_policy(company, _clean(body))
    db.commit()
    db.refresh(company)
    PP.forget(db)
    return {**_company_out(db, company), "canEdit": True}


# ── Templates and roles ──────────────────────────────────────────────────────


def _platform_out(db: Session) -> Dict[str, Any]:
    from app.services import dashboard_sections as DS

    value = PP.platform_policy(db)
    templates = PP.template_keys(db)
    return {
        "templates": {k: PP.policy_json(v) for k, v in value["templates"].items() if k in templates},
        "roles": {k: PP.policy_json(v) for k, v in value["roles"].items()},
        "templateList": [
            {"id": key, "name": name, "builtin": key in DS.BUILTIN_TEMPLATES} for key, name in templates.items()
        ],
        "catalogue": PP.catalogue_json(),
    }


@router.get("/dashboard-access/push-policy")
def get_platform_push_policy(current_user: User = Depends(get_current_super_admin), db: Session = Depends(get_db)):
    return _platform_out(db)


@router.put("/dashboard-access/push-policy")
def put_platform_push_policy(
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    try:
        PP.save_platform(db, body, current_user)
    except PP.PolicyError as exc:
        raise _policy_error(exc) from None
    db.commit()
    PP.forget(db)
    return _platform_out(db)


# ── One user ─────────────────────────────────────────────────────────────────


def _target(db: Session, user_id: uuid.UUID, active_tenant_id) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_same_tenant(user.tenant_id, active_tenant_id)
    return user


def _user_out(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    health = PP.health_for(db, [user.id]).get(user.id) or {}
    return {
        "userId": str(user.id),
        "policy": PP.policy_json(PP.user_policy(user)),
        "resolved": PP.resolve_required(db, user, tenant_id).as_json(),
        # What applies when the user's own is "inherit" (the form's "ירושה: …").
        "inherited": PP.resolve_required(db, user, tenant_id, above_user=True).as_json(),
        "health": health,
        "catalogue": PP.catalogue_json(),
    }


@router.get("/users/{user_id}/push-policy")
def get_user_push_policy(
    user_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.routers.users import USER_READ_ROLES, _check_scope_access

    user = _target(db, user_id, active_tenant_id)
    if current_user.id != user.id and (
        current_user.role not in USER_READ_ROLES or not _check_scope_access(current_user, user, db)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return _user_out(db, user, active_tenant_id)


@router.put("/users/{user_id}/push-policy")
def put_user_push_policy(
    user_id: uuid.UUID,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Set by whoever may edit this user; never by the user themselves (a requirement on them)."""
    from app.routers.users import ROLE_LEVEL, _check_scope_access

    user = _target(db, user_id, active_tenant_id)
    if current_user.role != UserRole.SUPER_ADMIN:
        if current_user.id == user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot set your own requirement")
        if not _check_scope_access(current_user, user, db):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        if ROLE_LEVEL.get(current_user.role, 0) <= ROLE_LEVEL.get(user.role, 0):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot modify a user with equal or higher role")
    policy = _clean(body)
    if "notify" not in (body or {}):
        # Only `required` sent: the user's own per-category choices stay.
        kept = PP.user_policy(user).get("notify")
        if kept:
            policy["notify"] = kept
    PP.set_user_policy(user, policy)
    db.commit()
    db.refresh(user)
    PP.forget(db)
    return _user_out(db, user, active_tenant_id)
