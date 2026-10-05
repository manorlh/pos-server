"""
Exceptions ("חריגות") — dashboard list, summary, review, rescan and rules; and the
till's own event push (`POST /sync/{machine_id}/events`).

Detection lives in `app.services.exceptions`. Reading is for every dashboard role but
the cashier, scoped like the transactions (`scope_query_by_user`); reviewing is for
managers (not a cashier, not a shift supervisor, whose role has no dashboard writes);
the rules are written under the same per-level rules as the POS settings.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import case, func
from sqlalchemy.orm import Query as OrmQuery, Session

from app.database import get_db
from app.middleware.auth import (
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.audit_exception import AuditException, ExceptionRuleValue, TillEvent
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.transaction import Transaction
from app.models.user import User, UserRole
from app.schemas.audit_exception import (
    BulkReviewIn,
    CountRow,
    ExceptionListResponse,
    ExceptionOut,
    ExceptionSummaryResponse,
    RescanIn,
    RescanOut,
    ReviewIn,
    RuleOut,
    RuleParamOut,
    RulesPut,
    RulesResponse,
    TillEventIn,
    TillEventOut,
)
from app.services import exceptions as svc
from app.services.areas import get_area
from app.services.company_hierarchy import descendant_company_ids
from app.services.scoping import scope_query_by_user

router = APIRouter(prefix="/exceptions", tags=["exceptions"])
till_router = APIRouter(prefix="/sync", tags=["exceptions"])

#: May not see exceptions at all.
NO_READ_ROLES = {UserRole.CASHIER}
#: May see, may not review.
NO_REVIEW_ROLES = {UserRole.CASHIER, UserRole.SHIFT_SUPERVISOR}

PAGE_SIZE_MAX = 500


# ── Till ─────────────────────────────────────────────────────────────────────


@till_router.post("/{machine_id}/events", response_model=TillEventOut)
def post_till_event(
    machine_id: str,
    body: TillEventIn,
    response: Response,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    One till event (a voided line, a cancelled basket, a completed basket's timing, a
    drawer opened without a sale). Idempotent by `id`: 201 the first time, 200 after.
    Detection runs on it at once; its failure never refuses the event.
    """
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")
    # "מצב הדרכה": a training event is quarantined (app/services/training_mode.py) — no
    # till event, no exception to review — and answered like a real one.
    from app.services import training_mode as TM

    training = TM.divert_till_event(db, machine, body)
    if training is not None:
        db.commit()
        response.status_code = status.HTTP_201_CREATED if training else status.HTTP_200_OK
        return TillEventOut(id=body.id, status="accepted" if training else "duplicate")
    existing = db.get(TillEvent, body.id)
    if existing is not None and existing.machine_id != machine.id:
        # Another till's id: nothing to overwrite, nothing to tell.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="event_id_conflict")
    event, created = svc.record_till_event(db, machine, body)
    db.commit()
    if created:
        svc.detect_safely(db, lambda d, e: svc.Detector(d).event(e), event)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return TillEventOut(id=event.id, status="accepted" if created else "duplicate")


# ── Scoping and filters ──────────────────────────────────────────────────────


def _require_reader(user: User) -> None:
    if user.role in NO_READ_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _require_reviewer(user: User) -> None:
    if user.role in NO_REVIEW_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _scoped(db: Session, user: User, tenant_id) -> Optional[OrmQuery]:
    _require_reader(user)
    query = db.query(AuditException).filter(AuditException.tenant_id == tenant_id)
    return scope_query_by_user(
        query, user, db, shop_column=AuditException.shop_id, machine_column=AuditException.machine_id
    )


def _window(db: Session, tenant_id, from_date: Optional[date], to_date: Optional[date]):
    from app.services.reports import resolve_report_window

    return resolve_report_window(db, tenant_id, from_date=from_date, to_date=to_date)


def _split(raw: Optional[str]) -> List[str]:
    return [p.strip() for p in (raw or "").split(",") if p.strip()]


def _filtered(
    db: Session,
    user: User,
    tenant_id,
    *,
    from_date: Optional[date],
    to_date: Optional[date],
    company_id: Optional[uuid.UUID],
    shop_id: Optional[uuid.UUID],
    area_id: Optional[uuid.UUID],
    machine_id: Optional[uuid.UUID],
    types: Optional[str],
    employee: Optional[str],
    statuses: Optional[str] = None,
):
    query = _scoped(db, user, tenant_id)
    window = _window(db, tenant_id, from_date, to_date)
    if query is None:
        return None, window
    query = query.filter(AuditException.occurred_at >= window.start, AuditException.occurred_at < window.end)
    if company_id is not None:
        query = query.filter(
            AuditException.company_id.in_([company_id, *descendant_company_ids(db, company_id)])
        )
    if shop_id is not None:
        query = query.filter(AuditException.shop_id == shop_id)
    if area_id is not None:
        query = query.filter(AuditException.area_id == area_id)
    if machine_id is not None:
        query = query.filter(AuditException.machine_id == machine_id)
    wanted_types = [t for t in _split(types) if t in svc.RULES_BY_TYPE]
    if _split(types):
        query = query.filter(AuditException.exception_type.in_(wanted_types or ["__none__"]))
    if employee:
        query = query.filter(AuditException.pos_user_id == employee)
    wanted_statuses = _split(statuses)
    if wanted_statuses:
        query = query.filter(AuditException.status.in_(wanted_statuses))
    return query, window


def _out(row: AuditException, labels: Dict[str, Dict[Any, Any]]) -> ExceptionOut:
    machine = labels["machines"].get(row.machine_id)
    return ExceptionOut(
        id=row.id,
        type=row.exception_type,
        severity=row.severity,
        status=row.status,
        occurred_at=svc._utc(row.occurred_at),
        detected_at=svc._utc(row.detected_at) or svc._utc(row.occurred_at),
        company_id=row.company_id,
        shop_id=row.shop_id,
        shop_name=labels["shops"].get(row.shop_id),
        area_id=row.area_id,
        area_name=labels["areas"].get(row.area_id),
        machine_id=row.machine_id,
        machine_name=machine.name if machine else None,
        pos_number=(machine.pos_number or machine.machine_code) if machine else None,
        shift_id=row.shift_id,
        shift_number=labels["shifts"].get(row.shift_id),
        transaction_id=row.transaction_id,
        transaction_number=labels["documents"].get(row.transaction_id),
        pos_user_id=row.pos_user_id,
        pos_user_name=row.pos_user_name,
        amount=float(row.amount) if row.amount is not None else None,
        value=float(row.value) if row.value is not None else None,
        threshold=float(row.threshold) if row.threshold is not None else None,
        details=row.details,
        reviewed_by=labels["reviewers"].get(row.reviewed_by_user_id),
        reviewed_at=svc._utc(row.reviewed_at),
        review_note=row.review_note,
    )


# ── List / summary ───────────────────────────────────────────────────────────


@router.get("", response_model=ExceptionListResponse, response_model_by_alias=True)
def list_exceptions(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[uuid.UUID] = Query(None, alias="areaId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    types: Optional[str] = Query(None, alias="type", description="Comma-separated exception types"),
    employee: Optional[str] = Query(None, description="A till user's id"),
    statuses: Optional[str] = Query(None, alias="status", description="new,reviewed,dismissed"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=PAGE_SIZE_MAX, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Newest first. Dates are days in the tenant's timezone (default: the last 30 days)."""
    query, _window_ = _filtered(
        db, current_user, active_tenant_id,
        from_date=from_date, to_date=to_date, company_id=company_id, shop_id=shop_id,
        area_id=area_id, machine_id=machine_id, types=types, employee=employee, statuses=statuses,
    )
    if query is None:
        return ExceptionListResponse(total=0, page=page, page_size=page_size, items=[])
    total = query.count()
    rows = (
        query.order_by(AuditException.occurred_at.desc(), AuditException.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    labels = svc.labels_for(db, rows)
    return ExceptionListResponse(
        total=total, page=page, page_size=page_size, items=[_out(r, labels) for r in rows]
    )


@router.get("/summary", response_model=ExceptionSummaryResponse, response_model_by_alias=True)
def exceptions_summary(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    area_id: Optional[uuid.UUID] = Query(None, alias="areaId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    types: Optional[str] = Query(None, alias="type"),
    employee: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Counts per status, per type and per employee, over the same filters (all statuses)."""
    query, _w = _filtered(
        db, current_user, active_tenant_id,
        from_date=from_date, to_date=to_date, company_id=company_id, shop_id=shop_id,
        area_id=area_id, machine_id=machine_id, types=types, employee=employee,
    )
    empty = ExceptionSummaryResponse(total=0, new=0, reviewed=0, dismissed=0, by_type=[], by_employee=[])
    if query is None:
        return empty

    is_new = func.sum(case((AuditException.status == "new", 1), else_=0))
    amount = func.coalesce(func.sum(func.abs(AuditException.amount)), 0)

    by_status = dict(
        query.with_entities(AuditException.status, func.count()).group_by(AuditException.status).all()
    )
    by_type = (
        query.with_entities(AuditException.exception_type, func.count(), is_new, amount)
        .group_by(AuditException.exception_type)
        .all()
    )
    by_employee = (
        query.with_entities(
            AuditException.pos_user_id, func.max(AuditException.pos_user_name), func.count(), is_new, amount
        )
        .group_by(AuditException.pos_user_id)
        .all()
    )
    return ExceptionSummaryResponse(
        total=sum(by_status.values()),
        new=by_status.get("new", 0),
        reviewed=by_status.get("reviewed", 0),
        dismissed=by_status.get("dismissed", 0),
        by_type=sorted(
            [CountRow(key=t, total=c, new=int(n or 0), amount=float(a or 0)) for t, c, n, a in by_type],
            key=lambda r: -r.total,
        ),
        by_employee=sorted(
            [
                CountRow(key=k, label=name, total=c, new=int(n or 0), amount=float(a or 0))
                for k, name, c, n, a in by_employee
            ],
            key=lambda r: -r.total,
        ),
    )


# ── Review ───────────────────────────────────────────────────────────────────


def _review(row: AuditException, body: ReviewIn, user: User) -> None:
    row.status = body.status
    if body.note is not None:
        row.review_note = body.note.strip() or None
    if body.status == "new":
        row.reviewed_by_user_id = None
        row.reviewed_at = None
    else:
        row.reviewed_by_user_id = user.id
        row.reviewed_at = datetime.now(timezone.utc)


@router.patch("/{exception_id}", response_model=ExceptionOut, response_model_by_alias=True)
def review_exception(
    exception_id: uuid.UUID,
    body: ReviewIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Mark reviewed / dismissed (with a note), or back to new."""
    _require_reviewer(current_user)
    query = _scoped(db, current_user, active_tenant_id)
    row = query.filter(AuditException.id == exception_id).first() if query is not None else None
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exception not found")
    _review(row, body, current_user)
    db.commit()
    db.refresh(row)
    return _out(row, svc.labels_for(db, [row]))


@router.post("/review", response_model=dict)
def review_exceptions(
    body: BulkReviewIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The same for many at once; ids the caller cannot see are skipped."""
    _require_reviewer(current_user)
    query = _scoped(db, current_user, active_tenant_id)
    rows = query.filter(AuditException.id.in_(body.ids)).all() if query is not None else []
    for row in rows:
        _review(row, body, current_user)
    db.commit()
    return {"updated": len(rows)}


# ── Rescan ───────────────────────────────────────────────────────────────────


@router.post("/rescan", response_model=RescanOut)
def rescan_exceptions(
    body: RescanIn,
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Detect over history in the range (default 30 days), within what the caller can
    see, under today's rules. Idempotent: what is already listed is not listed twice.
    """
    _require_reviewer(current_user)
    window = _window(
        db, active_tenant_id,
        date.fromisoformat(body.from_date) if body.from_date else None,
        date.fromisoformat(body.to_date) if body.to_date else None,
    )

    def scoped(query, shop_col, machine_col):
        return scope_query_by_user(query, current_user, db, shop_column=shop_col, machine_column=machine_col)

    tx_q = scoped(
        db.query(Transaction).filter(
            Transaction.tenant_id == active_tenant_id,
            Transaction.created_at >= window.start,
            Transaction.created_at < window.end,
        ),
        Transaction.shop_id, Transaction.machine_id,
    )
    shift_q = scoped(
        db.query(Shift).filter(
            Shift.tenant_id == active_tenant_id,
            Shift.status == ShiftStatus.CLOSED,
            Shift.closed_at >= window.start,
            Shift.closed_at < window.end,
        ),
        Shift.shop_id, Shift.machine_id,
    )
    event_q = scoped(
        db.query(TillEvent).filter(
            TillEvent.tenant_id == active_tenant_id,
            TillEvent.occurred_at >= window.start,
            TillEvent.occurred_at < window.end,
        ),
        TillEvent.shop_id, TillEvent.machine_id,
    )
    if tx_q is None or shift_q is None or event_q is None:
        return RescanOut(created=0, updated=0)
    if shop_id is not None:
        tx_q = tx_q.filter(Transaction.shop_id == shop_id)
        shift_q = shift_q.filter(Shift.shop_id == shop_id)
        event_q = event_q.filter(TillEvent.shop_id == shop_id)
    if machine_id is not None:
        tx_q = tx_q.filter(Transaction.machine_id == machine_id)
        shift_q = shift_q.filter(Shift.machine_id == machine_id)
        event_q = event_q.filter(TillEvent.machine_id == machine_id)
    detector = svc.rescan(db, transactions_query=tx_q, shifts_query=shift_q, events_query=event_q)
    db.commit()
    return RescanOut(created=detector.created, updated=detector.updated)


# ── Rules ────────────────────────────────────────────────────────────────────

LEVELS = ("tenant", "company", "shop", "area", "machine")


def _level_target(db: Session, user: User, tenant_id, level: str, target_id: Optional[uuid.UUID]):
    """The chain (most specific first) for the level, and the shop/company it sits in. Checks read access."""
    from app.routers.companies import _check_company_access
    from app.routers.shops import _check_shop_access

    _require_reader(user)
    if level not in LEVELS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="level must be one of " + ", ".join(LEVELS))
    if level == "tenant":
        return svc.chain_for(tenant_id=tenant_id), None, None
    if target_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="id is required")
    if level == "company":
        company = db.get(Company, target_id)
        if company is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        ensure_same_tenant(company.tenant_id, tenant_id)
        _check_company_access(user, company, db)
        return svc.chain_for(tenant_id=tenant_id, company_id=company.id), None, company
    if level == "shop":
        shop = db.get(Shop, target_id)
        if shop is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
        ensure_same_tenant(shop.tenant_id, tenant_id)
        _check_shop_access(user, shop, db)
        return svc.chain_for(tenant_id=tenant_id, company_id=shop.company_id, shop_id=shop.id), shop, None
    if level == "area":
        area = get_area(db, target_id)
        if area is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Area not found")
        ensure_same_tenant(area.tenant_id, tenant_id)
        shop = db.get(Shop, area.shop_id)
        _check_shop_access(user, shop, db)
        return (
            svc.chain_for(tenant_id=tenant_id, company_id=shop.company_id, shop_id=shop.id, area_id=area.id),
            shop,
            None,
        )
    machine = db.get(POSMachine, target_id)
    if machine is None or machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    ensure_same_tenant(machine.tenant_id, tenant_id)
    shop = db.get(Shop, machine.shop_id)
    _check_shop_access(user, shop, db)
    return (
        svc.chain_for(
            tenant_id=tenant_id, company_id=shop.company_id, shop_id=shop.id,
            area_id=machine.area_id, machine_id=machine.id,
        ),
        shop,
        None,
    )


def _can_write(db: Session, user: User, tenant_id, level: str, shop, company) -> bool:
    from app.routers.settings import _check_company_settings_write, _check_shop_settings_write
    from app.routers.tenants import _can_manage_tenant

    if user.role in NO_REVIEW_ROLES:
        return False
    try:
        if level == "tenant":
            return user.role == UserRole.SUPER_ADMIN or (
                user.role == UserRole.DISTRIBUTOR and _can_manage_tenant(user, tenant_id, db)
            )
        if level == "company":
            _check_company_settings_write(user, company, db)
            return True
        _check_shop_settings_write(user, shop, db)
        return True
    except HTTPException:
        return False


def _rules_response(db: Session, level: str, chain, can_write: bool) -> RulesResponse:
    rows = svc.rules_on_chain(db, chain)
    own_scope = chain[0]
    own = {r.exception_type: r for r in rows if (r.scope_type, svc._uuid(r.scope_id)) == own_scope}
    # The chain above this level: this level's own rows are off it, so ignored.
    inherited = svc.resolve_rules(rows, chain[1:])
    effective = svc.resolve_rules(rows, chain)
    out: List[RuleOut] = []
    for spec in svc.RULES:
        row = own.get(spec.type)
        out.append(RuleOut(
            type=spec.type,
            available=spec.available,
            source=spec.source,
            severity=spec.severity,
            default_enabled=spec.default_enabled,
            params=[
                RuleParamOut(key=p.key, default=p.default, min=p.minimum, max=p.maximum, integer=p.integer)
                for p in spec.params
            ],
            own_enabled=row.enabled if row is not None else None,
            own_params={k: v for k, v in ((row.params or {}) if row is not None else {}).items() if v is not None},
            inherited_enabled=inherited[spec.type].enabled,
            inherited_params=inherited[spec.type].params,
            inherited_sources=inherited[spec.type].sources,
            effective_enabled=effective[spec.type].enabled,
            effective_params=effective[spec.type].params,
        ))
    return RulesResponse(level=level, id=own_scope[1], can_write=can_write, rules=out)


@router.get("/rules", response_model=RulesResponse, response_model_by_alias=True)
def get_rules(
    level: str = Query(...),
    target_id: Optional[uuid.UUID] = Query(None, alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The exception types at one level: its own values, what it inherits and from where."""
    chain, shop, company = _level_target(db, current_user, active_tenant_id, level, target_id)
    return _rules_response(
        db, level, chain, _can_write(db, current_user, active_tenant_id, level, shop, company)
    )


@router.put("/rules", response_model=RulesResponse, response_model_by_alias=True)
def put_rules(
    body: RulesPut,
    level: str = Query(...),
    target_id: Optional[uuid.UUID] = Query(None, alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Set this level's own values for the types listed (`enabled: null` and no params =
    inherit everything again). Applies to detections from now on and to a rescan.
    """
    chain, shop, company = _level_target(db, current_user, active_tenant_id, level, target_id)
    if not _can_write(db, current_user, active_tenant_id, level, shop, company):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    scope_type, scope_id = chain[0]
    for item in body.rules:
        spec = svc.RULES_BY_TYPE.get(item.type)
        if spec is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"unknown type {item.type!r}")
        try:
            params = svc.clean_params(spec, item.params)
        except svc.RuleValueError as e:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
        row = (
            db.query(ExceptionRuleValue)
            .filter(
                ExceptionRuleValue.scope_type == scope_type,
                ExceptionRuleValue.scope_id == scope_id,
                ExceptionRuleValue.exception_type == spec.type,
            )
            .first()
        )
        if item.enabled is None and not params:
            if row is not None:
                db.delete(row)
            continue
        if row is None:
            row = ExceptionRuleValue(
                id=uuid.uuid4(), tenant_id=active_tenant_id, scope_type=scope_type,
                scope_id=scope_id, exception_type=spec.type,
            )
            db.add(row)
        row.enabled = item.enabled
        row.params = params or None
        row.updated_by = current_user.id
        row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _rules_response(db, level, chain, True)
