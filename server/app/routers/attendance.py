"""
"נוכחות עובדים" — employee attendance, phase 1 (app/services/attendance.py,
docs/SPEC_ATTENDANCE.md). Separate from the till login (`user_sessions`) and from the
till's cash shift (`shifts`).

Till (machine JWT only):

POST /sync/{machine_id}/attendance/actions   one outbox action (clock_in, break_start,
                                             break_end, clock_out, correction_request);
                                             idempotent by the ids it carries
GET  /sync/{machine_id}/attendance/state     ?posUserId=&shiftId= — the employee's open
                                             shift (any till), open tables, corrections

Dashboard (Clerk; read: every role but the cashier, scoped like the reports; write: the
till users' managers — `Resource.POS_USER`, the pos-users page's own rule):

GET  /attendance/live                        "עובדים במשמרת"
GET  /attendance/report                      "דוח נוכחות"
GET  /attendance/adjustments                 corrections (?status=pending)
POST /attendance/adjustments                 a manager's own correction (applied at once)
POST /attendance/adjustments/{id}/decision   approve / reject / edit
GET  /attendance/shifts/{id}                 one shift, its breaks and its audit
POST /attendance/shifts/{id}/close           "סגירה ע״י מנהל" (reason required)
GET  /attendance/roles · POST · PATCH /{id} · POST /roles/defaults   job titles
GET  /attendance/employees?shopId=           the shop's till users with their job title
PUT  /attendance/employees/{pos_user_id}/role
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_from_sync_machine_token,
)
from app.models.attendance import AttendanceAdjustment, AttendanceShift, EmployeeRole
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.user import User
from app.routers.pos_users import _check_read, _check_write
from app.schemas.attendance import (
    AttendanceActionIn,
    DecisionIn,
    EmployeeRoleAssignIn,
    EmployeeRoleIn,
    EmployeeRolePatch,
    ManagerAdjustmentIn,
    ManagerCloseIn,
)
from app.services import attendance as svc

till_router = APIRouter(prefix="/sync", tags=["attendance"])
router = APIRouter(prefix="/attendance", tags=["attendance"])


def _error(err: svc.AttendanceError) -> HTTPException:
    return HTTPException(status_code=err.status_code, detail={"code": err.code, **(err.info or {})})


# ── The till ─────────────────────────────────────────────────────────────────


@till_router.post("/{machine_id}/attendance/actions")
def post_attendance_action(
    machine_id: str,
    body: AttendanceActionIn,
    response: Response,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    One action from the till's outbox. 201 when it changed something, 200 for a replay.
    A till's fact is never refused for a rule (open tables, a missing approval): what the
    cloud would object to is flagged on the shift for a manager.
    """
    try:
        try:
            result = svc.apply_till_action(db, machine, body)
            db.commit()
        except IntegrityError:
            # The same action twice at once: the other request wrote it; apply again,
            # which now finds its rows and answers as a replay.
            db.rollback()
            result = svc.apply_till_action(db, machine, body)
            db.commit()
    except svc.AttendanceError as err:
        db.rollback()
        raise _error(err)
    response.status_code = status.HTTP_201_CREATED if result["status"] == "accepted" else status.HTTP_200_OK
    return result


@till_router.get("/{machine_id}/attendance/state")
def get_attendance_state(
    machine_id: str,
    pos_user_id: str = Query(..., alias="posUserId"),
    shift_id: Optional[str] = Query(None, alias="shiftId"),
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """What the till shows after a PIN: "לא במשמרת" / "במשמרת מ־17:02" / "בהפסקה"."""
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")
    try:
        pos_user = svc._pos_user_of_shop(db, machine, pos_user_id)
    except svc.AttendanceError as err:
        raise _error(err)
    return svc.till_state(db, machine, pos_user, shift_id=shift_id)


# ── The dashboard: scope ─────────────────────────────────────────────────────


def _require_reader(user: User) -> None:
    if not svc.may_read(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _shop(db: Session, shop_id: Any, tenant_id) -> Shop:
    shop = db.get(Shop, svc._uuid(shop_id)) if svc._uuid(shop_id) else None
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    return shop


def _writable_shop(db: Session, shop_id: Any, user: User, tenant_id) -> Shop:
    shop = _shop(db, shop_id, tenant_id)
    _check_write(user, shop, db)
    return shop


def _visible_shift(db: Session, shift_id: uuid.UUID, user: User, tenant_id) -> AttendanceShift:
    _require_reader(user)
    query = db.query(AttendanceShift).filter(AttendanceShift.id == shift_id, AttendanceShift.tenant_id == tenant_id)
    query = svc.scope_shops(query, user, db, AttendanceShift.shop_id)
    shift = query.first() if query is not None else None
    if shift is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shift not found")
    return shift


# ── "עובדים במשמרת" and the report ──────────────────────────────────────────


@router.get("/live")
def get_live(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    role_id: Optional[uuid.UUID] = Query(None, alias="roleId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_reader(current_user)
    out = svc.live(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id, role_id=role_id)
    if out is None:
        return {"serverTime": None, "shifts": [], "counts": {"total": 0, "byStatus": {}, "byRole": {}}}
    return out


@router.get("/report")
def get_report(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    pos_user_id: Optional[uuid.UUID] = Query(None, alias="posUserId"),
    role_id: Optional[uuid.UUID] = Query(None, alias="roleId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    from app.services.reports import resolve_report_window

    _require_reader(current_user)
    window = resolve_report_window(db, active_tenant_id, from_date=from_date, to_date=to_date)
    out = svc.report(
        db, current_user, active_tenant_id, window=window,
        company_id=company_id, shop_id=shop_id, pos_user_id=pos_user_id, role_id=role_id,
    )
    if out is None:
        return {
            "window": window.to_schema().model_dump(by_alias=True, mode="json"),
            "rows": [], "byEmployee": [], "totals": {"shifts": 0, "workedSeconds": 0, "breakSeconds": 0},
        }
    return out


# ── Shifts ───────────────────────────────────────────────────────────────────


@router.get("/shifts/{shift_id}")
def get_shift(
    shift_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    shift = _visible_shift(db, shift_id, current_user, active_tenant_id)
    out = svc.shift_out(db, shift)
    out["details"] = shift.details or {}
    out["openTables"] = svc.open_tables_for(db, shift.shop_id, shift.pos_user_id) if shift.clock_out_at is None else []
    out["adjustments"] = svc.adjustments(db, current_user, active_tenant_id, shift_id=shift.id) or []
    return out


@router.post("/shifts/{shift_id}/close")
def close_shift(
    shift_id: uuid.UUID,
    body: ManagerCloseIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"סגירה ע״י מנהל". 409 `open_tables` (with the tables) unless `ignoreOpenTables`."""
    shift = _visible_shift(db, shift_id, current_user, active_tenant_id)
    _writable_shop(db, shift.shop_id, current_user, active_tenant_id)
    try:
        adj = svc.manager_close(
            db, shift, at=body.at, reason=body.reason, user=current_user,
            ignore_open_tables=body.ignore_open_tables,
        )
    except svc.AttendanceError as err:
        db.rollback()
        raise _error(err)
    db.commit()
    return {"shift": svc.shift_out(db, shift), "adjustment": svc.adjustment_out(db, adj)}


# ── Corrections ──────────────────────────────────────────────────────────────


@router.get("/adjustments")
def list_adjustments(
    status_filter: Optional[str] = Query(None, alias="status"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    pos_user_id: Optional[uuid.UUID] = Query(None, alias="posUserId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_reader(current_user)
    rows = svc.adjustments(
        db, current_user, active_tenant_id, status=status_filter,
        company_id=company_id, shop_id=shop_id, pos_user_id=pos_user_id,
    )
    return {"adjustments": rows or [], "canManage": svc.may_manage(current_user)}


@router.post("/adjustments", status_code=status.HTTP_201_CREATED)
def create_adjustment(
    body: ManagerAdjustmentIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A manager's own correction: recorded with its reason, approved and applied at once."""
    shop = _writable_shop(db, body.shop_id, current_user, active_tenant_id)
    pos_user = db.query(PosUser).filter(PosUser.id == body.pos_user_id, PosUser.shop_id == shop.id).first()
    if pos_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found")
    shift = None
    if body.shift_id is not None:
        shift = db.query(AttendanceShift).filter(
            AttendanceShift.id == body.shift_id, AttendanceShift.shop_id == shop.id
        ).first()
        if shift is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shift not found")
    try:
        adj = svc.create_by_manager(
            db, shop=shop, pos_user=pos_user, kind=body.kind, shift=shift, field=body.field,
            break_id=body.break_id, time=body.time, end_time=body.end_time, reason=body.reason,
            user=current_user,
        )
    except svc.AttendanceError as err:
        db.rollback()
        raise _error(err)
    db.commit()
    return svc.adjustment_out(db, adj, shop=shop)


@router.post("/adjustments/{adjustment_id}/decision")
def decide_adjustment(
    adjustment_id: uuid.UUID,
    body: DecisionIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Approve (as asked, or edited with `approvedTime`) or reject a pending request."""
    adj = db.query(AttendanceAdjustment).filter(
        AttendanceAdjustment.id == adjustment_id, AttendanceAdjustment.tenant_id == active_tenant_id
    ).first()
    if adj is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Adjustment not found")
    shop = _writable_shop(db, adj.shop_id, current_user, active_tenant_id)
    try:
        svc.decide(
            db, adj, approve=body.decision == "approve", approved_time=body.approved_time,
            approved_end_time=body.approved_end_time, note=body.note, user=current_user,
        )
    except svc.AttendanceError as err:
        db.rollback()
        raise _error(err)
    db.commit()
    return svc.adjustment_out(db, adj, shop=shop)


# ── Job titles ───────────────────────────────────────────────────────────────


def _require_role_editor(user: User) -> None:
    if user.role not in svc.ROLE_DEFINITION_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _roles_response(db: Session, tenant_id, include_inactive: bool, user: User) -> dict:
    roles = svc.roles_of(db, tenant_id, include_inactive=include_inactive)
    counts = {}
    if roles:
        for role_id, in db.query(PosUser.employee_role_id).filter(
            PosUser.employee_role_id.in_([r.id for r in roles]), PosUser.is_active.is_(True)
        ).all():
            counts[str(role_id)] = counts.get(str(role_id), 0) + 1
    return {
        "roles": [svc.role_out(r, employees=counts.get(str(r.id), 0)) for r in roles],
        "canEdit": user.role in svc.ROLE_DEFINITION_ROLES,
    }


@router.get("/roles")
def list_roles(
    include_inactive: bool = Query(False, alias="includeInactive"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_reader(current_user)
    return _roles_response(db, active_tenant_id, include_inactive, current_user)


@router.post("/roles/defaults")
def add_default_roles(
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"הוסף תפקידים מוצעים": מלצר, ברמן, ראנר, מארחת, אחמ״ש, מטבח — those missing."""
    _require_role_editor(current_user)
    svc.add_default_roles(db, active_tenant_id)
    db.commit()
    return _roles_response(db, active_tenant_id, True, current_user)


@router.post("/roles", status_code=status.HTTP_201_CREATED)
def create_role(
    body: EmployeeRoleIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_role_editor(current_user)
    try:
        name = svc.clean_role_name(body.name)
        weight = svc.clean_tip_weight(body.tip_weight)
    except svc.AttendanceError as err:
        raise _error(err)
    if db.query(EmployeeRole).filter(EmployeeRole.tenant_id == active_tenant_id, EmployeeRole.name == name).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "name_taken"})
    last = db.query(EmployeeRole).filter(EmployeeRole.tenant_id == active_tenant_id).count()
    role = EmployeeRole(
        id=uuid.uuid4(), tenant_id=active_tenant_id, name=name, tip_weight=weight,
        sort_order=body.sort_order if body.sort_order is not None else (last + 1) * 10, is_active=True,
    )
    db.add(role)
    db.commit()
    return svc.role_out(role)


@router.patch("/roles/{role_id}")
def update_role(
    role_id: uuid.UUID,
    body: EmployeeRolePatch,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    _require_role_editor(current_user)
    role = db.query(EmployeeRole).filter(EmployeeRole.id == role_id, EmployeeRole.tenant_id == active_tenant_id).first()
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")
    try:
        if body.name is not None:
            name = svc.clean_role_name(body.name)
            taken = db.query(EmployeeRole).filter(
                EmployeeRole.tenant_id == active_tenant_id, EmployeeRole.name == name, EmployeeRole.id != role.id
            ).first()
            if taken:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "name_taken"})
            role.name = name
        if body.tip_weight is not None:
            role.tip_weight = svc.clean_tip_weight(body.tip_weight)
    except svc.AttendanceError as err:
        raise _error(err)
    if body.sort_order is not None:
        role.sort_order = body.sort_order
    if body.is_active is not None:
        role.is_active = body.is_active
    db.commit()
    return svc.role_out(role)


@router.get("/employees")
def list_employees(
    shop_id: uuid.UUID = Query(..., alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The shop's till users with their job title — for the filters and for assigning one."""
    _require_reader(current_user)
    shop = _shop(db, shop_id, active_tenant_id)
    _check_read(current_user, shop, db)
    rows = (
        db.query(PosUser)
        .filter(PosUser.shop_id == shop.id, PosUser.is_active.is_(True))
        .order_by(PosUser.first_name, PosUser.username)
        .all()
    )
    roles = {str(r.id): r for r in svc.roles_of(db, active_tenant_id, include_inactive=True)}
    return {
        "employees": [
            {
                "id": str(p.id),
                "name": svc.pos_user_name(p),
                "username": p.username,
                "workerNumber": p.worker_number,
                "permissionRole": p.role.value if hasattr(p.role, "value") else str(p.role),
                "roleId": str(p.employee_role_id) if p.employee_role_id else None,
                "roleName": roles[str(p.employee_role_id)].name if p.employee_role_id and str(p.employee_role_id) in roles else None,
            }
            for p in rows
        ],
        "canManage": svc.may_manage(current_user),
    }


@router.put("/employees/{pos_user_id}/role")
def assign_role(
    pos_user_id: uuid.UUID,
    body: EmployeeRoleAssignIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The employee's job title (not their permissions — `role` stays as it is)."""
    pos_user = db.get(PosUser, pos_user_id)
    if pos_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found")
    _writable_shop(db, pos_user.shop_id, current_user, active_tenant_id)
    if body.role_id is not None:
        role = db.query(EmployeeRole).filter(
            EmployeeRole.id == body.role_id, EmployeeRole.tenant_id == active_tenant_id
        ).first()
        if role is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")
    pos_user.employee_role_id = body.role_id
    db.commit()
    return {"id": str(pos_user.id), "roleId": str(body.role_id) if body.role_id else None}
