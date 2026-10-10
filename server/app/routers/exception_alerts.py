"""
"התראות SMS על חריגות" — the alert rules of a company / shop (app/services/exception_alerts).

Dashboard (Clerk/user JWT + X-Tenant-Id):

GET    /exception-alerts/provider?companyId=      → where messages go: "dry_run" (nothing is
                                                    sent — the default) or the 019 queue and its mode
GET    /exception-alerts/rules?companyId=&shopId= → the rules (+ `canWrite` each)
POST   /exception-alerts/rules                    → a new rule (body: companyId, shopId?, fields)
PUT    /exception-alerts/rules/{id}               → change it (fields left out keep their value)
DELETE /exception-alerts/rules/{id}               → remove it (kept for its history, never sends)
POST   /exception-alerts/rules/{id}/test          → "שליחת הודעת בדיקה" to its recipients
GET    /exception-alerts/rules/{id}/changes       → who changed it, when, before → after
GET    /exception-alerts/dispatches?ruleId=       → its latest SMS attempts (sent / dry run / held back)
GET    /exception-alerts/users?companyId=         → the company's dashboard users (to label a number)

Permissions are those of the other company / shop settings: a company-wide rule is
written by whoever writes the company's settings (super admin, distributor, the company
manager over it); a shop rule also by that shop's manager. Reading follows writing — the
rules hold staff phone numbers — and a shop manager sees their own shop's rules only.
Every change (and every test message) is written to `exception_alert_rule_changes`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.company import Company
from app.models.exception_alerts import ExceptionAlertDispatch, ExceptionAlertRule, ExceptionAlertRuleChange
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services.exception_alerts import engine as E
from app.services.exception_alerts import rules as R
from app.services.exception_alerts import sms as SMS
from app.services.exception_alerts.log import aware

router = APIRouter(prefix="/exception-alerts", tags=["exception-alerts"])

#: Never see or write SMS alert rules.
NO_ACCESS_ROLES = {UserRole.CASHIER, UserRole.SHIFT_SUPERVISOR}


def _deny(detail: str = "Insufficient permissions") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def _rule_error(exc: R.RuleError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.as_json())


def _company(db: Session, user: User, tenant_id: Any, company_id: Any) -> Company:
    from app.routers.companies import _check_company_access

    if user.role in NO_ACCESS_ROLES:
        raise _deny()
    try:
        cid = uuid.UUID(str(company_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="companyId is required") from None
    company = db.get(Company, cid)
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    ensure_same_tenant(company.tenant_id, tenant_id)
    if user.role == UserRole.SHOP_MANAGER and user.shop_id:
        # A shop manager reaches the company through their shop (they may carry no company id).
        from app.services.company_hierarchy import descendant_company_ids

        own = db.get(Shop, user.shop_id)
        if own is not None and own.company_id in descendant_company_ids(db, company.id):
            return company
    _check_company_access(user, company, db)
    return company


def _shop(db: Session, user: User, tenant_id: Any, company: Company, shop_id: Any) -> Optional[Shop]:
    from app.routers.shops import _check_shop_access
    from app.services.company_hierarchy import descendant_company_ids

    if shop_id in (None, ""):
        return None
    try:
        sid = uuid.UUID(str(shop_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="shopId is invalid") from None
    shop = db.get(Shop, sid)
    if shop is None or shop.company_id not in descendant_company_ids(db, company.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    _check_shop_access(user, shop, db)
    return shop


def can_write(db: Session, user: User, company: Company, shop: Optional[Shop]) -> bool:
    """The other settings' rule: company-wide → company settings; a shop → that shop's settings."""
    from app.routers.settings import _check_company_settings_write, _check_shop_settings_write

    if user.role in NO_ACCESS_ROLES:
        return False
    try:
        if shop is None:
            _check_company_settings_write(user, company, db)
        else:
            _check_shop_settings_write(user, shop, db)
        return True
    except HTTPException:
        return False


def _may_read(db: Session, user: User, rule: ExceptionAlertRule) -> bool:
    if user.role in NO_ACCESS_ROLES:
        return False
    if user.role == UserRole.SHOP_MANAGER:
        return rule.shop_id is not None and rule.shop_id == user.shop_id
    return True


def _load_rule(db: Session, user: User, tenant_id: Any, rule_id: uuid.UUID):
    rule = db.get(ExceptionAlertRule, rule_id)
    if rule is None or rule.deleted_at is not None or rule.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    company = _company(db, user, tenant_id, rule.company_id)
    shop = _shop(db, user, tenant_id, company, rule.shop_id) if rule.shop_id else None
    if not _may_read(db, user, rule):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    return rule, company, shop


def _record_change(db: Session, rule: ExceptionAlertRule, action: str, old: Optional[Dict[str, Any]],
                   new: Optional[Dict[str, Any]], user: User) -> None:
    role = getattr(user.role, "value", user.role)
    db.add(ExceptionAlertRuleChange(
        id=uuid.uuid4(),
        tenant_id=rule.tenant_id,
        rule_id=rule.id,
        action=action,
        old_value=old,
        new_value=new,
        user_id=user.id,
        user_email=(user.email or None) and str(user.email)[:255],
        user_role=str(role)[:32] if role is not None else None,
        created_at=datetime.now(timezone.utc),
    ))


def _out(db: Session, user: User, rule: ExceptionAlertRule, company: Company, shop: Optional[Shop],
         shop_names: Optional[Dict[Any, str]] = None) -> Dict[str, Any]:
    body = R.as_json(rule)
    body["shopName"] = (shop.name if shop is not None else None) or (shop_names or {}).get(rule.shop_id)
    body["canWrite"] = can_write(db, user, company, shop)
    body["createdAt"] = aware(rule.created_at).isoformat() if rule.created_at else None
    body["updatedAt"] = aware(rule.updated_at).isoformat() if rule.updated_at else None
    return body


# ── Provider ─────────────────────────────────────────────────────────────────


@router.get("/provider")
def get_provider(
    company_id: uuid.UUID = Query(..., alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Where the alerts go. `dryRun: true` = nothing leaves the server (the UI says so)."""
    company = _company(db, current_user, active_tenant_id, company_id)
    return SMS.get_provider().describe(db, active_tenant_id, company.id)


# ── Rules ────────────────────────────────────────────────────────────────────


@router.get("/rules")
def list_rules(
    company_id: uuid.UUID = Query(..., alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The company's rules (with `shopId`: those of that shop and the company-wide ones)."""
    company = _company(db, current_user, active_tenant_id, company_id)
    shop = _shop(db, current_user, active_tenant_id, company, shop_id)
    q = db.query(ExceptionAlertRule).filter(
        ExceptionAlertRule.tenant_id == active_tenant_id,
        ExceptionAlertRule.company_id == company.id,
        ExceptionAlertRule.deleted_at.is_(None),
    )
    if shop is not None:
        q = q.filter((ExceptionAlertRule.shop_id == shop.id) | (ExceptionAlertRule.shop_id.is_(None)))
    rows = [r for r in q.order_by(ExceptionAlertRule.created_at, ExceptionAlertRule.id).all()
            if _may_read(db, current_user, r)]
    shop_ids = {r.shop_id for r in rows if r.shop_id}
    shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(shop_ids))} if shop_ids else {}
    return {
        "companyId": str(company.id),
        "canWriteCompany": can_write(db, current_user, company, None),
        "canWriteShop": can_write(db, current_user, company, shop) if shop is not None else None,
        "provider": SMS.get_provider().describe(db, active_tenant_id, company.id),
        "rules": [_out(db, current_user, r, company, shops.get(r.shop_id)) for r in rows],
    }


@router.post("/rules", status_code=status.HTTP_201_CREATED)
def create_rule(
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    company = _company(db, current_user, active_tenant_id, body.get("companyId"))
    shop = _shop(db, current_user, active_tenant_id, company, body.get("shopId"))
    if not can_write(db, current_user, company, shop):
        raise _deny()
    try:
        fields = R.clean(body)
    except R.RuleError as exc:
        raise _rule_error(exc) from None
    now = datetime.now(timezone.utc)
    rule = ExceptionAlertRule(
        id=uuid.uuid4(), tenant_id=active_tenant_id, company_id=company.id, shop_id=shop.id if shop else None,
        created_by=current_user.id, updated_by=current_user.id, created_at=now, updated_at=now,
    )
    R.apply(rule, fields)
    db.add(rule)
    db.flush()
    _record_change(db, rule, "create", None, R.audit_json(rule), current_user)
    db.commit()
    db.refresh(rule)
    return _out(db, current_user, rule, company, shop)


@router.put("/rules/{rule_id}")
def update_rule(
    rule_id: uuid.UUID,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rule, company, shop = _load_rule(db, current_user, active_tenant_id, rule_id)
    if not can_write(db, current_user, company, shop):
        raise _deny()
    before = R.audit_json(rule)
    try:
        fields = R.clean({k: v for k, v in body.items() if k not in ("companyId", "shopId", "id")},
                         partial_of=R.as_json(rule))
    except R.RuleError as exc:
        raise _rule_error(exc) from None
    R.apply(rule, fields)
    rule.updated_by = current_user.id
    rule.updated_at = datetime.now(timezone.utc)
    after = R.audit_json(rule)
    if after != before:
        _record_change(db, rule, "update", before, after, current_user)
    db.commit()
    db.refresh(rule)
    return _out(db, current_user, rule, company, shop)


@router.delete("/rules/{rule_id}")
def delete_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rule, company, shop = _load_rule(db, current_user, active_tenant_id, rule_id)
    if not can_write(db, current_user, company, shop):
        raise _deny()
    before = R.audit_json(rule)
    rule.deleted_at = datetime.now(timezone.utc)
    rule.enabled = False
    rule.updated_by = current_user.id
    _record_change(db, rule, "delete", before, None, current_user)
    db.commit()
    return {"deleted": True}


@router.post("/rules/{rule_id}/test")
def test_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "שליחת הודעת בדיקה": one short message to each recipient through the ACTIVE provider —
    in development the dry run (nothing is sent; `dryRun: true`), once configured the 019
    queue under its own mode. At most once a minute per rule.
    """
    rule, company, shop = _load_rule(db, current_user, active_tenant_id, rule_id)
    if not can_write(db, current_user, company, shop):
        raise _deny()
    provider = SMS.get_provider()
    description = provider.describe(db, active_tenant_id, company.id)
    try:
        rows = E.send_test(db, rule, user=current_user, provider=provider)
    except E.AlertError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from None
    _record_change(db, rule, "test", None, {"recipients": [d.recipient_masked for d in rows],
                                             "statuses": [d.status for d in rows]}, current_user)
    db.commit()
    from app.routers.exception_log import dispatch_json

    return {
        "provider": description,
        "dryRun": bool(description.get("dryRun")),
        "dispatches": [dispatch_json(d, {rule.id: rule.name}) for d in rows],
    }


@router.get("/rules/{rule_id}/changes")
def rule_changes(
    rule_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    rule, _company_, _shop_ = _load_rule(db, current_user, active_tenant_id, rule_id)
    rows = (
        db.query(ExceptionAlertRuleChange)
        .filter(ExceptionAlertRuleChange.rule_id == rule.id)
        .order_by(ExceptionAlertRuleChange.created_at.desc())
        .limit(limit)
        .all()
    )
    return {"changes": [
        {
            "id": str(c.id),
            "action": c.action,
            "oldValue": c.old_value,
            "newValue": c.new_value,
            "userEmail": c.user_email,
            "userRole": c.user_role,
            "at": aware(c.created_at).isoformat() if c.created_at else None,
        }
        for c in rows
    ]}


@router.get("/dispatches")
def list_dispatches(
    rule_id: uuid.UUID = Query(..., alias="ruleId"),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The rule's latest SMS attempts — every one, sent or held back — newest first."""
    from app.routers.exception_log import dispatch_json

    rule, _company_, _shop_ = _load_rule(db, current_user, active_tenant_id, rule_id)
    rows = (
        db.query(ExceptionAlertDispatch)
        .filter(ExceptionAlertDispatch.rule_id == rule.id)
        .order_by(ExceptionAlertDispatch.created_at.desc(), ExceptionAlertDispatch.id)
        .limit(limit)
        .all()
    )
    return {"dispatches": [dispatch_json(d, {rule.id: rule.name}) | {"entryId": str(d.entry_id) if d.entry_id else None}
                           for d in rows]}


@router.get("/users")
def list_users(
    company_id: uuid.UUID = Query(..., alias="companyId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The dashboard users of the company and its shops — to link a recipient number to a
    person (users carry no phone number of their own).
    """
    from app.services.company_hierarchy import descendant_company_ids

    company = _company(db, current_user, active_tenant_id, company_id)
    companies = descendant_company_ids(db, company.id) or [company.id]
    shop_ids = [s[0] for s in db.query(Shop.id).filter(Shop.company_id.in_(companies))]
    q = db.query(User).filter(User.is_active.is_(True), User.tenant_id == active_tenant_id)
    q = q.filter((User.company_id.in_(companies)) | (User.shop_id.in_(shop_ids or [uuid.uuid4()])))
    if current_user.role == UserRole.SHOP_MANAGER:
        q = q.filter(User.shop_id == current_user.shop_id)
    users: List[Dict[str, Any]] = []
    for u in q.order_by(User.username).limit(500):
        if u.role in (UserRole.CASHIER,):
            continue
        users.append({
            "id": str(u.id),
            "name": u.username,
            "email": u.email,
            "role": getattr(u.role, "value", u.role),
            "shopId": str(u.shop_id) if u.shop_id else None,
        })
    return {"users": users}
