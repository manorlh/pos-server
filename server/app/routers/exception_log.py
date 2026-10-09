"""
"יומן חריגות" — the exceptions log (app/services/exception_alerts).

Dashboard (Clerk/user JWT + X-Tenant-Id):

GET   /exception-log/kinds          → every kind (label, severity, amount / percent, where it links)
GET   /exception-log                → the log, filtered and paged (≤ 500 a page — the Excel
                                      export pages through it like the other reports)
GET   /exception-log/summary        → counts (open / handled, per kind, per employee) for the filters
GET   /exception-log/by-code/{code} → the entry of an SMS link (`<dashboard>/x/<code>`)
PATCH /exception-log/{id}           → "טופל" with a note, or back to open

Reading: every dashboard role but the cashier, scoped like the exceptions report (a
shop's people see their shop; a company manager their companies; a distributor what
they manage). Marking "טופל": not a cashier, not a shift supervisor. Every row carries the
SMS attempts its exception made (rule, masked number, sent / dry run / held back).
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, case, false, func, or_
from sqlalchemy.orm import Query as OrmQuery, Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.exception_alerts import ExceptionAlertDispatch, ExceptionAlertRule, ExceptionLogEntry
from app.models.pos_machine import POSMachine
from app.models.user import User, UserRole
from app.services.company_hierarchy import company_scope_ids, descendant_company_ids, visible_shop_ids
from app.services.exception_alerts import catalog as C
from app.services.exception_alerts import log as L
from app.services.permission_matrix import SHOP_SCOPED_ROLES

router = APIRouter(prefix="/exception-log", tags=["exception-log"])

NO_READ_ROLES = {UserRole.CASHIER}
NO_ACK_ROLES = {UserRole.CASHIER, UserRole.SHIFT_SUPERVISOR}
PAGE_SIZE_MAX = 500

DISPATCH_LABELS = {
    "dry_run": "הדמיה — לא נשלח",
    "queued": "בתור לשליחה",
    "sent": "נשלח",
    "sending": "בשליחה",
    "failed": "נכשל",
    "suppressed_rate_limit": "נחסם — הגבלת קצב",
    "suppressed_quiet_hours": "נחסם — שעות שקט",
    "suppressed_stale": "לא נשלח — אירוע ישן",
}


class AckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    acknowledged: bool = True
    note: Optional[str] = Field(None, max_length=2000)


# ── Scope ────────────────────────────────────────────────────────────────────


def scoped(db: Session, user: User, tenant_id: Any) -> Optional[OrmQuery]:
    """The entries this user may see in the active tenant; None = none at all."""
    if user.role in NO_READ_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    q = db.query(ExceptionLogEntry).filter(ExceptionLogEntry.tenant_id == tenant_id)
    if user.role == UserRole.SUPER_ADMIN:
        return q
    if user.role == UserRole.DISTRIBUTOR:
        from app.routers.tenants import _can_manage_tenant

        manages = _can_manage_tenant(user, tenant_id, db)
        mine = db.query(POSMachine.id).filter(POSMachine.distributor_id == user.id)
        return q.filter(or_(
            ExceptionLogEntry.machine_id.in_(mine),
            and_(ExceptionLogEntry.machine_id.is_(None), true_if(manages)),
        ))
    if user.role == UserRole.COMPANY_MANAGER and user.company_id:
        return q.filter(or_(
            ExceptionLogEntry.shop_id.in_(visible_shop_ids(db, user)),
            and_(ExceptionLogEntry.shop_id.is_(None), ExceptionLogEntry.company_id.in_(company_scope_ids(db, user))),
        ))
    if user.role in SHOP_SCOPED_ROLES and user.shop_id:
        return q.filter(ExceptionLogEntry.shop_id == user.shop_id)
    return None


def true_if(flag: bool):
    from sqlalchemy import true

    return true() if flag else false()


def _split(raw: Optional[str]) -> List[str]:
    return [p.strip() for p in (raw or "").split(",") if p.strip()]


def filtered(
    db: Session,
    user: User,
    tenant_id: Any,
    *,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    company_id: Optional[uuid.UUID] = None,
    shop_id: Optional[uuid.UUID] = None,
    area_id: Optional[uuid.UUID] = None,
    machine_id: Optional[uuid.UUID] = None,
    kinds: Optional[str] = None,
    severities: Optional[str] = None,
    employee: Optional[str] = None,
    acknowledged: Optional[bool] = None,
    code: Optional[str] = None,
    rule_id: Optional[uuid.UUID] = None,
) -> Optional[OrmQuery]:
    from app.services.reports import resolve_report_window

    q = scoped(db, user, tenant_id)
    if q is None:
        return None
    if code:
        # An SMS link names one entry, whatever its date.
        return q.filter(ExceptionLogEntry.short_code == code.strip().lower()[:16])
    window = resolve_report_window(db, tenant_id, from_date=from_date, to_date=to_date)
    q = q.filter(ExceptionLogEntry.occurred_at >= window.start, ExceptionLogEntry.occurred_at < window.end)
    if company_id is not None:
        q = q.filter(ExceptionLogEntry.company_id.in_(descendant_company_ids(db, company_id) or [company_id]))
    if shop_id is not None:
        q = q.filter(ExceptionLogEntry.shop_id == shop_id)
    if area_id is not None:
        q = q.filter(ExceptionLogEntry.area_id == area_id)
    if machine_id is not None:
        q = q.filter(ExceptionLogEntry.machine_id == machine_id)
    wanted = _split(kinds)
    if wanted:
        q = q.filter(ExceptionLogEntry.kind.in_(wanted))
    sev = [s for s in _split(severities) if s in C.SEVERITY_RANK]
    if _split(severities):
        q = q.filter(ExceptionLogEntry.severity.in_(sev or ["__none__"]))
    if employee:
        q = q.filter(ExceptionLogEntry.pos_user_id == employee)
    if acknowledged is True:
        q = q.filter(ExceptionLogEntry.acknowledged_at.isnot(None))
    elif acknowledged is False:
        q = q.filter(ExceptionLogEntry.acknowledged_at.is_(None))
    if rule_id is not None:
        q = q.filter(ExceptionLogEntry.id.in_(
            db.query(ExceptionAlertDispatch.entry_id).filter(ExceptionAlertDispatch.rule_id == rule_id)
        ))
    return q


# ── Rows ─────────────────────────────────────────────────────────────────────


def _labels(db: Session, rows: List[ExceptionLogEntry]) -> Dict[str, Dict[Any, Any]]:
    from app.models.shift import Shift
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea
    from app.models.transaction import Transaction
    from app.services.document_prefix import document_number_from

    shop_ids = {r.shop_id for r in rows if r.shop_id}
    area_ids = {r.area_id for r in rows if r.area_id}
    machine_ids = {r.machine_id for r in rows if r.machine_id}
    tx_ids = {r.transaction_id for r in rows if r.transaction_id}
    shift_ids = {r.shift_id for r in rows if r.shift_id}
    user_ids = {r.acknowledged_by_user_id for r in rows if r.acknowledged_by_user_id}
    entry_ids = [r.id for r in rows]
    docs = (
        db.query(Transaction.id, Transaction.transaction_number, Transaction.document_prefix,
                 Transaction.pos_number, Transaction.document_type)
        .filter(Transaction.id.in_(tx_ids)).all() if tx_ids else []
    )
    dispatches = (
        db.query(ExceptionAlertDispatch)
        # The SMS attempts only: a phone (push) attempt is its user's own (GET /push/history).
        .filter(ExceptionAlertDispatch.entry_id.in_(entry_ids), ExceptionAlertDispatch.channel == "sms")
        .order_by(ExceptionAlertDispatch.created_at)
        .all() if entry_ids else []
    )
    rule_ids = {d.rule_id for d in dispatches if d.rule_id}
    return {
        "shops": {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(shop_ids))} if shop_ids else {},
        "areas": {a.id: a.name for a in db.query(ShopArea).filter(ShopArea.id.in_(area_ids))} if area_ids else {},
        "machines": {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids))} if machine_ids else {},
        "documents": {d.id: document_number_from(d.transaction_number, d.document_prefix, d.pos_number) for d in docs},
        "documentTypes": {d.id: d.document_type for d in docs},
        "shifts": {s.id: s.sequence_number for s in db.query(Shift.id, Shift.sequence_number).filter(Shift.id.in_(shift_ids))} if shift_ids else {},
        "users": {u.id: (u.username or u.email) for u in db.query(User).filter(User.id.in_(user_ids))} if user_ids else {},
        "rules": {r.id: r.name for r in db.query(ExceptionAlertRule).filter(ExceptionAlertRule.id.in_(rule_ids))} if rule_ids else {},
        "dispatches": dispatches,
    }


def _iso(value) -> Optional[str]:
    value = L.aware(value)
    return value.isoformat() if value else None


def dispatch_json(d: ExceptionAlertDispatch, rule_names: Dict[Any, str]) -> Dict[str, Any]:
    return {
        "id": str(d.id),
        # "sms" | "push" ("התראות לטלפון": the recipient is the device's label).
        "channel": getattr(d, "channel", None) or "sms",
        "ruleId": str(d.rule_id) if d.rule_id else None,
        "ruleName": rule_names.get(d.rule_id),
        "kind": d.kind,
        "status": d.status,
        "statusLabel": DISPATCH_LABELS.get(d.status, d.status),
        "reason": d.reason,
        "recipient": d.recipient_masked,
        "recipientLabel": d.recipient_label,
        "provider": d.provider,
        "providerMode": d.provider_mode,
        "notificationId": str(d.notification_id) if d.notification_id else None,
        "digestId": str(d.digest_id) if d.digest_id and d.digest_id != d.id else None,
        "digestCount": d.digest_count,
        "text": d.text,
        "at": _iso(d.created_at),
    }


def entry_json(r: ExceptionLogEntry, labels: Dict[str, Dict[Any, Any]]) -> Dict[str, Any]:
    machine = labels["machines"].get(r.machine_id)
    spec = C.kind_spec(r.kind)
    sms = [dispatch_json(d, labels["rules"]) for d in labels["dispatches"] if d.entry_id == r.id]
    return {
        "id": str(r.id),
        "code": r.short_code,
        "kind": r.kind,
        "kindLabel": C.label_of(r.kind),
        "severity": r.severity,
        "source": r.source,
        "link": spec.link if spec is not None else "none",
        "occurredAt": _iso(r.occurred_at),
        "receivedAt": _iso(r.received_at),
        "companyId": str(r.company_id) if r.company_id else None,
        "shopId": str(r.shop_id) if r.shop_id else None,
        "shopName": labels["shops"].get(r.shop_id),
        "areaId": str(r.area_id) if r.area_id else None,
        "areaName": labels["areas"].get(r.area_id),
        "machineId": str(r.machine_id) if r.machine_id else None,
        "machineName": machine.name if machine is not None else None,
        "posNumber": (machine.pos_number or machine.machine_code) if machine is not None else None,
        "posUserId": r.pos_user_id,
        "posUserName": r.pos_user_name,
        "amount": float(r.amount) if r.amount is not None else None,
        "value": float(r.value) if r.value is not None else None,
        "threshold": float(r.threshold) if r.threshold is not None else None,
        "summary": r.summary,
        "details": r.details,
        "transactionId": str(r.transaction_id) if r.transaction_id else None,
        "transactionNumber": labels["documents"].get(r.transaction_id),
        "documentType": labels["documentTypes"].get(r.transaction_id),
        "shiftId": str(r.shift_id) if r.shift_id else None,
        "shiftNumber": labels["shifts"].get(r.shift_id),
        "zReportId": str(r.z_report_id) if r.z_report_id else None,
        "auditExceptionId": str(r.audit_exception_id) if r.audit_exception_id else None,
        "backfilled": bool(r.backfilled),
        "acknowledged": r.acknowledged_at is not None,
        "acknowledgedAt": _iso(r.acknowledged_at),
        "acknowledgedBy": labels["users"].get(r.acknowledged_by_user_id),
        "note": r.note,
        "sms": sms,
    }


# ── Routes ───────────────────────────────────────────────────────────────────


@router.get("/kinds")
def list_kinds(current_user: User = Depends(get_current_user)):
    if current_user.role in NO_READ_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return {
        "kinds": C.as_json(),
        "severities": [{"key": k, "label": C.SEVERITY_LABELS[k]} for k in ("high", "medium", "low")],
    }


def _bool(raw: Optional[str]) -> Optional[bool]:
    if raw in (None, "", "all"):
        return None
    return str(raw).lower() in ("1", "true", "yes", "acknowledged")


@router.get("")
def list_log(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[uuid.UUID] = Query(None, alias="areaId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    kinds: Optional[str] = Query(None, alias="kind", description="Comma-separated kinds"),
    severities: Optional[str] = Query(None, alias="severity", description="high,medium,low"),
    employee: Optional[str] = Query(None),
    acknowledged: Optional[str] = Query(None, description="true / false (empty = both)"),
    code: Optional[str] = Query(None, description="An SMS link's code"),
    rule_id: Optional[uuid.UUID] = Query(None, alias="ruleId"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=PAGE_SIZE_MAX, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Newest first. Dates are days in the tenant's timezone (default: the last 30 days)."""
    q = filtered(
        db, current_user, active_tenant_id, from_date=from_date, to_date=to_date, company_id=company_id,
        shop_id=shop_id, area_id=area_id, machine_id=machine_id, kinds=kinds, severities=severities,
        employee=employee, acknowledged=_bool(acknowledged), code=code, rule_id=rule_id,
    )
    if q is None:
        return {"total": 0, "page": page, "pageSize": page_size, "items": []}
    total = q.count()
    rows = (
        q.order_by(ExceptionLogEntry.occurred_at.desc(), ExceptionLogEntry.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    labels = _labels(db, rows)
    return {"total": total, "page": page, "pageSize": page_size, "items": [entry_json(r, labels) for r in rows]}


@router.get("/summary")
def log_summary(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[uuid.UUID] = Query(None, alias="areaId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    kinds: Optional[str] = Query(None, alias="kind"),
    severities: Optional[str] = Query(None, alias="severity"),
    employee: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Counts over the same filters (both open and handled): per kind, per employee, per severity."""
    q = filtered(
        db, current_user, active_tenant_id, from_date=from_date, to_date=to_date, company_id=company_id,
        shop_id=shop_id, area_id=area_id, machine_id=machine_id, kinds=kinds, severities=severities,
        employee=employee,
    )
    empty = {"total": 0, "open": 0, "acknowledged": 0, "byKind": [], "byEmployee": [], "bySeverity": []}
    if q is None:
        return empty
    is_open = func.sum(case((ExceptionLogEntry.acknowledged_at.is_(None), 1), else_=0))
    amount = func.coalesce(func.sum(func.abs(ExceptionLogEntry.amount)), 0)
    by_kind = q.with_entities(ExceptionLogEntry.kind, func.count(), is_open, amount).group_by(ExceptionLogEntry.kind).all()
    by_employee = (
        q.with_entities(ExceptionLogEntry.pos_user_id, func.max(ExceptionLogEntry.pos_user_name), func.count(), is_open)
        .group_by(ExceptionLogEntry.pos_user_id)
        .all()
    )
    by_severity = q.with_entities(ExceptionLogEntry.severity, func.count(), is_open).group_by(ExceptionLogEntry.severity).all()
    total = sum(int(c) for _k, c, _o, _a in by_kind)
    open_ = sum(int(o or 0) for _k, _c, o, _a in by_kind)
    return {
        "total": total,
        "open": open_,
        "acknowledged": total - open_,
        "byKind": sorted(
            [{"key": k, "label": C.label_of(k), "total": int(c), "open": int(o or 0), "amount": float(a or 0)}
             for k, c, o, a in by_kind],
            key=lambda r: -r["total"],
        ),
        "byEmployee": sorted(
            [{"key": k, "label": n, "total": int(c), "open": int(o or 0)} for k, n, c, o in by_employee if k],
            key=lambda r: -r["total"],
        ),
        "bySeverity": [{"key": k, "total": int(c), "open": int(o or 0)} for k, c, o in by_severity],
    }


@router.get("/by-code/{code}")
def entry_by_code(
    code: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The entry an SMS link names (`/x/<code>`), if this user may see it."""
    q = filtered(db, current_user, active_tenant_id, code=code)
    row = q.first() if q is not None else None
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    return entry_json(row, _labels(db, [row]))


@router.patch("/{entry_id}")
def acknowledge_entry(
    entry_id: uuid.UUID,
    body: AckIn = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"טופל" (with a note), or back to open. Mirrored onto the exceptions report's row."""
    if current_user.role in NO_ACK_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    q = scoped(db, current_user, active_tenant_id)
    row = q.filter(ExceptionLogEntry.id == entry_id).first() if q is not None else None
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")
    L.acknowledge(db, row, user=current_user, acknowledged=body.acknowledged, note=body.note)
    db.commit()
    db.refresh(row)
    return entry_json(row, _labels(db, [row]))
