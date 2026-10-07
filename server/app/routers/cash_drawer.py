"""
"מגירת מזומן" (docs/SPEC_ROLES_PERMISSIONS.md; the owner's drawer spec §14–§16).

Till (machine token), idempotent by the client's id:

    POST /sync/{machine_id}/cash-drawer/events      a drawer opening attempt, or a permission
                                                     override / refusal (§14)
    POST /sync/{machine_id}/cash-drawer/movements   Cash In / Cash Out / Deposit / a count (§7, §9)

Dashboard (§16), scoped like the exceptions (every role but the cashier):

    GET /cash-drawer/events                 the openings report + its KPIs, with the filters of §16
    GET /cash-drawer/movements              the cash movements + their totals
    GET /cash-drawer/shifts/{id}/timeline   one shift's drawer story: openings, movements,
                                             counts, the expected balance and the exceptions
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    FISCAL_MACHINE_TOKEN,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.audit_exception import AuditException
from app.models.cash_drawer import CashDrawerEvent, CashMovement
from app.models.pos_machine import POSMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.schemas.cash_drawer import CashMovementIn, DrawerEventIn, IngestOut
from app.services import cash_drawer as svc
from app.services import exceptions as exc_svc
from app.services.company_hierarchy import descendant_company_ids
from app.services.scoping import scope_query_by_user

router = APIRouter(prefix="/cash-drawer", tags=["cash-drawer"])
till_router = APIRouter(prefix="/sync", tags=["cash-drawer"])

PAGE_SIZE_MAX = 500


# ── Till ──────────────────────────────────────────────────────────────────────


def _assigned(machine: POSMachine) -> None:
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")


# A till's own drawer: never a display device's (FISCAL_MACHINE_TOKEN, tests/test_display_devices.py).
@till_router.post("/{machine_id}/cash-drawer/events", response_model=IngestOut, dependencies=FISCAL_MACHINE_TOKEN)
def post_drawer_event(
    machine_id: str,
    body: DrawerEventIn,
    response: Response,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """201 the first time, 200 for a resend; 409 when the id is another till's. Detection never refuses it."""
    _assigned(machine)
    existing = db.get(CashDrawerEvent, body.id)
    if existing is not None and existing.machine_id != machine.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="event_id_conflict")
    event, created = svc.record_event(db, machine, body)
    db.commit()
    if created:
        exc_svc.detect_safely(db, lambda d, e: svc.detect_event(d, machine, e), event)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return IngestOut(id=event.id, status="accepted" if created else "duplicate")


@till_router.post("/{machine_id}/cash-drawer/movements", response_model=IngestOut, dependencies=FISCAL_MACHINE_TOKEN)
def post_cash_movement(
    machine_id: str,
    body: CashMovementIn,
    response: Response,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    _assigned(machine)
    existing = db.get(CashMovement, body.id)
    if existing is not None and existing.machine_id != machine.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="movement_id_conflict")
    movement, created = svc.record_movement(db, machine, body)
    db.commit()
    if created:
        exc_svc.detect_safely(db, lambda d, m: svc.detect_movement(d, machine, m), movement)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return IngestOut(id=movement.id, status="accepted" if created else "duplicate")


# ── Dashboard ─────────────────────────────────────────────────────────────────


def _require_reader(user: User) -> None:
    if user.role == UserRole.CASHIER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _split(raw: Optional[str]) -> List[str]:
    return [p.strip() for p in (raw or "").split(",") if p.strip()]


def _base(db: Session, user: User, tenant_id, model, *, from_date, to_date, company_id, shop_id, machine_id,
          employee, shift_id):
    _require_reader(user)
    query = scope_query_by_user(
        db.query(model).filter(model.tenant_id == tenant_id), user, db,
        shop_column=model.shop_id, machine_column=model.machine_id,
    )
    from app.services.reports import resolve_report_window

    window = resolve_report_window(db, tenant_id, from_date=from_date, to_date=to_date)
    if query is None:
        return None, window
    if shift_id is None:
        query = query.filter(model.occurred_at >= window.start, model.occurred_at < window.end)
    else:
        query = query.filter(model.shift_id == shift_id)
    if company_id is not None:
        query = query.filter(model.company_id.in_([company_id, *descendant_company_ids(db, company_id)]))
    if shop_id is not None:
        query = query.filter(model.shop_id == shop_id)
    if machine_id is not None:
        query = query.filter(model.machine_id == machine_id)
    if employee:
        query = query.filter(model.employee_id == employee)
    return query, window


def _labels(db: Session, rows) -> Dict[str, Dict[Any, Any]]:
    shop_ids = {r.shop_id for r in rows if r.shop_id}
    machine_ids = {r.machine_id for r in rows if r.machine_id}
    return {
        "shops": {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_(shop_ids))} if shop_ids else {},
        "machines": {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids))} if machine_ids else {},
    }


def _exceptions_by_event(db: Session, event_ids) -> Dict[Any, List[str]]:
    ids = [i for i in event_ids if i is not None]
    if not ids:
        return {}
    out: Dict[Any, List[str]] = {}
    for till_event_id, kind in (
        db.query(AuditException.till_event_id, AuditException.exception_type)
        .filter(AuditException.till_event_id.in_(ids))
        .all()
    ):
        out.setdefault(till_event_id, []).append(kind)
    return out


@router.get("/events")
def list_drawer_events(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    employee: Optional[str] = Query(None, description="A till user's id"),
    role: Optional[str] = Query(None, description="The employee's role at the time (its name)"),
    shift_id: Optional[uuid.UUID] = Query(None, alias="shiftId"),
    event_types: Optional[str] = Query(None, alias="eventType", description="Comma-separated: MANUAL,CASH_SALE…"),
    reason: Optional[str] = Query(None),
    approved_by_manager: Optional[bool] = Query(None, alias="managerApproval"),
    with_sale: Optional[bool] = Query(None, alias="withSale"),
    results: Optional[str] = Query(None, alias="result", description="approved,denied,failed"),
    exceptions_only: bool = Query(False, alias="exceptionsOnly"),
    category: str = Query("drawer"),
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=PAGE_SIZE_MAX, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The drawer openings report (spec §16), newest first, with the KPIs over all filtered rows."""
    query, window = _base(
        db, current_user, active_tenant_id, CashDrawerEvent, from_date=from_date, to_date=to_date,
        company_id=company_id, shop_id=shop_id, machine_id=machine_id, employee=employee, shift_id=shift_id,
    )
    empty = {"total": 0, "page": page, "pageSize": page_size, "rows": [], "kpis": svc.kpis([], []),
             "window": {"from": str(window.from_date), "to": str(window.to_date)}}
    if query is None:
        return empty
    if category in ("drawer", "permission"):
        query = query.filter(CashDrawerEvent.category == category)
    types = [t for t in _split(event_types) if t in svc.EVENT_TYPES]
    if _split(event_types):
        query = query.filter(CashDrawerEvent.event_type.in_(types or ["__none__"]))
    if role:
        query = query.filter(CashDrawerEvent.employee_role == role)
    if reason:
        query = query.filter(CashDrawerEvent.reason == reason)
    if approved_by_manager is True:
        query = query.filter(CashDrawerEvent.approver_id.isnot(None))
    elif approved_by_manager is False:
        query = query.filter(CashDrawerEvent.approver_id.is_(None))
    if with_sale is True:
        query = query.filter(CashDrawerEvent.sale_id.isnot(None))
    elif with_sale is False:
        query = query.filter(CashDrawerEvent.sale_id.is_(None))
    wanted_results = [r for r in _split(results) if r in svc.RESULTS]
    if _split(results):
        query = query.filter(CashDrawerEvent.result.in_(wanted_results or ["__none__"]))
    rows_all = query.order_by(CashDrawerEvent.occurred_at.desc(), CashDrawerEvent.id).all()
    exceptions = _exceptions_by_event(db, [r.id for r in rows_all])
    if exceptions_only:
        rows_all = [r for r in rows_all if r.id in exceptions]
    total = len(rows_all)
    rows = rows_all[(page - 1) * page_size: page * page_size]
    movements = []
    if rows_all:
        mq, _w = _base(
            db, current_user, active_tenant_id, CashMovement, from_date=from_date, to_date=to_date,
            company_id=company_id, shop_id=shop_id, machine_id=machine_id, employee=employee, shift_id=shift_id,
        )
        movements = mq.all() if mq is not None else []
    labels = _labels(db, rows)
    return {
        "total": total,
        "page": page,
        "pageSize": page_size,
        "rows": [svc.event_out(r, labels, exceptions) for r in rows],
        "kpis": svc.kpis(rows_all, movements, {r.id for r in rows_all if r.id in exceptions}),
        "window": {"from": str(window.from_date), "to": str(window.to_date)},
    }


@router.get("/movements")
def list_cash_movements(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    employee: Optional[str] = Query(None),
    shift_id: Optional[uuid.UUID] = Query(None, alias="shiftId"),
    types: Optional[str] = Query(None, alias="type", description="cash_in,cash_out,deposit,count"),
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=PAGE_SIZE_MAX, alias="pageSize"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Cash In / Out / Deposit / counts, newest first, with totals per type."""
    query, window = _base(
        db, current_user, active_tenant_id, CashMovement, from_date=from_date, to_date=to_date,
        company_id=company_id, shop_id=shop_id, machine_id=machine_id, employee=employee, shift_id=shift_id,
    )
    if query is None:
        return {"total": 0, "page": page, "pageSize": page_size, "rows": [], "totals": {}}
    wanted = [t for t in _split(types) if t in svc.MOVEMENT_TYPES]
    if _split(types):
        query = query.filter(CashMovement.movement_type.in_(wanted or ["__none__"]))
    rows_all = query.order_by(CashMovement.occurred_at.desc(), CashMovement.id).all()
    rows = rows_all[(page - 1) * page_size: page * page_size]
    totals: Dict[str, Dict[str, float]] = {}
    for m in rows_all:
        t = totals.setdefault(m.movement_type, {"count": 0, "amount": 0.0, "variance": 0.0})
        t["count"] += 1
        t["amount"] += float(m.amount or 0)
        t["variance"] += float(m.variance or 0)
    labels = _labels(db, rows)
    return {
        "total": len(rows_all),
        "page": page,
        "pageSize": page_size,
        "rows": [svc.movement_out(m, labels) for m in rows],
        "totals": totals,
        "window": {"from": str(window.from_date), "to": str(window.to_date)},
    }


@router.get("/shifts/{shift_id}/timeline")
def shift_drawer_timeline(
    shift_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    One shift's drawer story (spec §16 "Timeline"): every opening (and refused attempt),
    every movement and count, in time order, with the expected balance as the till saw it,
    the shift's opening float / expected / counted / variance and its exceptions — to tie a
    cash gap to the openings and outflows around it.
    """
    _require_reader(current_user)
    shift_q = scope_query_by_user(
        db.query(Shift).filter(Shift.id == shift_id, Shift.tenant_id == active_tenant_id), current_user, db,
        shop_column=Shift.shop_id, machine_column=Shift.machine_id,
    )
    shift = shift_q.first() if shift_q is not None else None
    if shift is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shift not found")
    events = (
        db.query(CashDrawerEvent).filter(CashDrawerEvent.shift_id == shift.id)
        .order_by(CashDrawerEvent.occurred_at).all()
    )
    movements = (
        db.query(CashMovement).filter(CashMovement.shift_id == shift.id).order_by(CashMovement.occurred_at).all()
    )
    exceptions = (
        db.query(AuditException).filter(AuditException.shift_id == shift.id)
        .order_by(AuditException.occurred_at).all()
    )
    by_event = _exceptions_by_event(db, [e.id for e in events])
    labels = _labels(db, events + movements)
    items: List[Dict[str, Any]] = [{"kind": "event", **svc.event_out(e, labels, by_event)} for e in events]
    items += [{"kind": "movement", **svc.movement_out(m, labels)} for m in movements]
    items.sort(key=lambda i: i.get("occurredAt") or "")
    sums = {t: sum(float(m.amount or 0) for m in movements if m.movement_type == t) for t in ("cash_in", "cash_out", "deposit")}
    return {
        "shift": {
            "id": str(shift.id),
            "machineId": str(shift.machine_id),
            "sequenceNumber": shift.sequence_number,
            "openedAt": svc._utc(shift.opened_at).isoformat() if shift.opened_at else None,
            "closedAt": svc._utc(shift.closed_at).isoformat() if shift.closed_at else None,
            "openingCash": float(shift.opening_cash) if shift.opening_cash is not None else None,
            "expectedCash": float(shift.expected_cash) if shift.expected_cash is not None else None,
            "countedCash": float(shift.counted_cash) if shift.counted_cash is not None else None,
            "discrepancy": float(shift.discrepancy) if shift.discrepancy is not None else None,
            "cashIn": sums["cash_in"],
            "cashOut": sums["cash_out"],
            "deposits": sums["deposit"],
        },
        "kpis": svc.kpis(events, movements, set(by_event)),
        "items": items,
        "exceptions": [
            {
                "id": str(x.id),
                "type": x.exception_type,
                "severity": x.severity,
                "status": x.status,
                "occurredAt": svc._utc(x.occurred_at).isoformat() if x.occurred_at else None,
                "amount": float(x.amount) if x.amount is not None else None,
                "posUserName": x.pos_user_name,
                "tillEventId": str(x.till_event_id) if x.till_event_id else None,
            }
            for x in exceptions
        ],
    }
