"""
Club scope: one club per company, serving that company's shops and its subsidiaries'
(the nearest company up the tree that has an active club). Never across tenants.
Plus the dashboard's scope checks and the audit trail.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.club import ClubAuditEvent, ClubProgram
from app.models.company import Company
from app.models.user import User, UserRole
from app.services.company_hierarchy import ancestor_company_ids, company_scope_ids, user_covers_company

#: Roles that manage the club and provider settings (company level and up).
CLUB_ADMIN_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER)
#: Roles that may read the message log (a shop manager: their own shop only).
LOG_ROLES = CLUB_ADMIN_ROLES + (UserRole.SHOP_MANAGER,)


def error(code: str, http_status: int = 400, message: Optional[str] = None, retryable: bool = False, **extra: Any):
    """A structured API error (§31): code, user_message, retryable, correlation_id."""
    from app.observability.context import request_id_var

    detail: Dict[str, Any] = {
        "code": code,
        "userMessage": message,
        "retryable": retryable,
        "correlationId": request_id_var.get(),
    }
    detail.update(extra)
    return HTTPException(status_code=http_status, detail=detail)


def require_role(user: User, roles) -> None:
    if user.role not in roles:
        raise error("forbidden", status.HTTP_403_FORBIDDEN)


def resolve_company(db: Session, user: User, tenant_id: Any, company_id: Any) -> Company:
    """The company named by the dashboard — of the active tenant and in the caller's scope."""
    try:
        cid = uuid.UUID(str(company_id))
    except (TypeError, ValueError):
        raise error("company_required", 422) from None
    company = db.get(Company, cid)
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise error("company_not_found", 404)
    if user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR) and not user_covers_company(db, user, cid):
        raise error("forbidden", 403)
    return company


def visible_company_ids(db: Session, user: User) -> Optional[List[uuid.UUID]]:
    """None = every company of the active tenant; else the caller's companies."""
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return None
    if user.role == UserRole.COMPANY_MANAGER:
        return company_scope_ids(db, user)
    return []


def club_for_company(db: Session, tenant_id: Any, company_id: Any, *, active_only: bool = True) -> Optional[ClubProgram]:
    """The club serving [company_id]: its own, else the nearest ancestor's."""
    if not company_id:
        return None
    chain = [company_id] + list(ancestor_company_ids(db, company_id))
    rows = (
        db.query(ClubProgram)
        .filter(ClubProgram.tenant_id == tenant_id, ClubProgram.company_id.in_(chain))
        .all()
    )
    by_company = {str(r.company_id): r for r in rows}
    for cid in chain:
        club = by_company.get(str(cid))
        if club is not None and (club.is_active or not active_only):
            return club
    return None


def audit(
    db: Session,
    *,
    tenant_id: Any,
    company_id: Any = None,
    domain: str,
    subject_type: str,
    subject_id: Any = None,
    action: str,
    actor_user_id: Any = None,
    actor_machine_id: Any = None,
    reason: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> ClubAuditEvent:
    row = ClubAuditEvent(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=company_id,
        domain=domain,
        subject_type=subject_type,
        subject_id=subject_id,
        action=action,
        actor_user_id=actor_user_id,
        actor_machine_id=actor_machine_id,
        reason=(reason or None) and reason[:200],
        details=details or {},
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    return row
