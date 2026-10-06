"""
Employee attendance ("נוכחות עובדים") — phase 1. See app/models/attendance.py and
docs/SPEC_ATTENDANCE.md.

**The rule this module exists to keep** (spec §2): attendance is not the POS login.
Nothing here reads `pos_user_sessions`, the idle lock or a sign-out to start or end a
shift — the only things that end one are an explicit clock-out from a till
(`apply_till_action`, type `clock_out`) and a recorded manager action
(`manager_close`, an approved correction). The live page *shows* which till an
employee is signed in at, and that is all the login is used for.

The till's side is offline-first. Every action arrives through the till's outbox,
possibly late, possibly twice, possibly out of order, so applying one is:

* **idempotent by the till's ids** — the shift's id is made at clock-in, a break's when it
  starts, a correction request's when it is filed; replaying an action finds the row and
  its time already set;
* **set-once per field** — a till never overwrites a time the cloud already has (a
  manager's correction in particular), and a finished shift is never reopened;
* **lenient** — a till's fact is never refused for a rule (open tables, a missing
  approval): the till decided with what it knew. What the cloud would have objected to
  is *flagged* for a manager instead (`flags`), and a shift whose clock-out a manager
  approved over open tables is an exception ("חריגות").

Device time and cloud time are both kept per action. The device's clock offset is
measured from the action's `sentAt` (the device's clock when the outbox delivered it)
against the cloud's clock on arrival — not from the action's own time, which may be
hours old after an offline stretch — and a gap above `CLOCK_SKEW_FLAG_SECONDS` is
flagged. Keeping both times is not by itself a defence against a tampered clock (§44);
it makes one visible.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.attendance import (
    ADJUSTMENT_FIELDS,
    DEFAULT_EMPLOYEE_ROLES,
    AttendanceAdjustment,
    AttendanceBreak,
    AttendanceShift,
    EmployeeRole,
)
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser, PosUserRole
from app.models.shop import Shop
from app.models.tables import TableOrder
from app.models.user import User, UserRole
from app.services.areas import as_utc
from app.services.company_hierarchy import visible_shop_ids
from app.services.permission_matrix import SHOP_SCOPED_ROLES, Action, Resource, may

logger = logging.getLogger(__name__)

# ── The parameters (built-in till parameters, app/services/till_parameters.py) ──

PARAM_ENABLED = "attendanceEnabled"
PARAM_REQUIRE_CLOCK_IN = "requireClockInBeforeLogin"
PARAM_PREVENT_OPEN_TABLES = "preventClockOutWithOpenTables"
PARAM_REQUIRE_MANAGER = "requireManagerForClockOut"

#: A device clock this far from the cloud's (either way) is flagged on the shift.
CLOCK_SKEW_FLAG_SECONDS = 5 * 60
#: A corrected time may not be later than now by more than this (a device a little ahead).
FUTURE_TOLERANCE = timedelta(minutes=5)
#: The exceptions ("חריגות") type every manual attendance change is reported as.
EXCEPTION_TYPE = "attendance_manual"

TILL_ACTION_TYPES = ("clock_in", "break_start", "break_end", "clock_out", "correction_request")
#: The kinds an employee may request, and the times each needs.
REQUEST_KINDS = ("missing_in", "missing_out", "wrong_time", "break")

FLAG_CLOCK_SKEW = "clock_skew"
FLAG_OVERLAP = "overlap"
FLAG_OPEN_TABLES = "open_tables"
FLAG_APPROVAL_UNVERIFIED = "approval_unverified"
FLAG_LATE_EVENT = "late_event"


class AttendanceError(ValueError):
    """A request the cloud cannot apply; `code` is what the API answers."""

    def __init__(self, code: str, status_code: int = 400, **info: Any):
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.info = info


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = as_utc(moment)
    return moment.isoformat() if moment is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value).strip())
    except (TypeError, ValueError):
        return None


def bool_of(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("true", "1", "yes", "כן"):
            return True
        if text in ("false", "0", "no", "לא"):
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


@dataclass(frozen=True)
class Policy:
    """The four parameters; the defaults change nothing for a shop that never set them."""

    enabled: bool = False
    require_clock_in: bool = False
    prevent_open_tables: bool = True
    require_manager: bool = False


def policy_of(parameters: Dict[str, Any]) -> Policy:
    return Policy(
        enabled=bool_of(parameters.get(PARAM_ENABLED), False),
        require_clock_in=bool_of(parameters.get(PARAM_REQUIRE_CLOCK_IN), False),
        prevent_open_tables=bool_of(parameters.get(PARAM_PREVENT_OPEN_TABLES), True),
        require_manager=bool_of(parameters.get(PARAM_REQUIRE_MANAGER), False),
    )


def policy_for_machine(db: Session, machine: POSMachine) -> Policy:
    from app.services.till_parameters import till_parameters_for_machine

    return policy_of(till_parameters_for_machine(db, machine).parameters)


def policy_for_shop(db: Session, shop: Shop) -> Policy:
    from app.services.till_parameters import resolve_for_shop

    return policy_of(resolve_for_shop(db, shop))


# ── Names ────────────────────────────────────────────────────────────────────


def pos_user_name(pos_user: Optional[PosUser]) -> Optional[str]:
    if pos_user is None:
        return None
    full = " ".join(p for p in (pos_user.first_name or "", pos_user.last_name or "") if p).strip()
    return full or pos_user.username


def dashboard_user_name(user: Optional[User]) -> Optional[str]:
    if user is None:
        return None
    return user.username or user.email


def _company_of(db: Session, shop_id: Any) -> Optional[uuid.UUID]:
    row = db.query(Shop.company_id).filter(Shop.id == shop_id).first()
    return row[0] if row else None


# ── Computing a shift ────────────────────────────────────────────────────────


def breaks_of(db: Session, shift_ids: Iterable[Any]) -> Dict[str, List[AttendanceBreak]]:
    ids = [i for i in {_uuid(s) for s in shift_ids} if i is not None]
    out: Dict[str, List[AttendanceBreak]] = {str(i): [] for i in ids}
    if not ids:
        return out
    rows = (
        db.query(AttendanceBreak)
        .filter(AttendanceBreak.shift_id.in_(ids))
        .order_by(AttendanceBreak.start_at)
        .all()
    )
    for row in rows:
        out.setdefault(str(row.shift_id), []).append(row)
    return out


def _seconds(start: Optional[datetime], end: Optional[datetime]) -> int:
    start, end = as_utc(start), as_utc(end)
    if start is None or end is None or end <= start:
        return 0
    return int((end - start).total_seconds())


def break_seconds(shift: AttendanceShift, breaks: Sequence[AttendanceBreak], now: datetime) -> int:
    """Break time inside the shift; an open break counts until now (or the clock-out)."""
    cap = as_utc(shift.clock_out_at) or now
    total = 0
    for b in breaks:
        end = as_utc(b.end_at) or cap
        total += _seconds(b.start_at, min(end, cap))
    return total


def worked_seconds(shift: AttendanceShift, breaks: Sequence[AttendanceBreak], now: datetime) -> int:
    """From clock-in to clock-out (or now, while open), less the breaks."""
    end = as_utc(shift.clock_out_at) or now
    return max(0, _seconds(shift.clock_in_at, end) - break_seconds(shift, breaks, now))


def _pending_count(db: Session, shift_id: Any) -> int:
    return (
        db.query(AttendanceAdjustment)
        .filter(AttendanceAdjustment.shift_id == shift_id, AttendanceAdjustment.status == "pending")
        .count()
    )


def refresh_status(db: Session, shift: AttendanceShift, breaks: Optional[Sequence[AttendanceBreak]] = None) -> str:
    """
    The state, from the times rather than from the order actions arrived in: finished
    once clocked out (pending approval while a correction of it waits), on break while a
    break is open, else working.
    """
    if breaks is None:
        breaks = breaks_of(db, [shift.id]).get(str(shift.id), [])
    if shift.clock_out_at is not None:
        status = "pending_approval" if _pending_count(db, shift.id) else "finished"
    elif any(b.end_at is None for b in breaks):
        status = "on_break"
    else:
        status = "working"
    shift.status = status
    return status


def _add_flag(shift: AttendanceShift, flag: str) -> None:
    flags = list(shift.flags or [])
    if flag not in flags:
        flags.append(flag)
        shift.flags = flags


def _set_detail(shift: AttendanceShift, key: str, value: Any) -> None:
    details = dict(shift.details or {})
    details[key] = value
    shift.details = details


def break_out(row: AttendanceBreak) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "startAt": _iso(row.start_at),
        "endAt": _iso(row.end_at),
        "startDeviceAt": _iso(row.start_device_at),
        "endDeviceAt": _iso(row.end_device_at),
        "source": row.source,
    }


def shift_out(
    db: Session,
    shift: AttendanceShift,
    *,
    breaks: Optional[Sequence[AttendanceBreak]] = None,
    now: Optional[datetime] = None,
    pos_user: Optional[PosUser] = None,
) -> Dict[str, Any]:
    now = now or _now()
    if breaks is None:
        breaks = breaks_of(db, [shift.id]).get(str(shift.id), [])
    if pos_user is None:
        pos_user = db.get(PosUser, shift.pos_user_id)
    open_break = next((b for b in breaks if b.end_at is None), None)
    return {
        "id": str(shift.id),
        "posUserId": str(shift.pos_user_id),
        "posUserName": pos_user_name(pos_user),
        "workerNumber": pos_user.worker_number if pos_user is not None else None,
        "shopId": str(shift.shop_id),
        "status": shift.status,
        "source": shift.source,
        "roleId": str(shift.employee_role_id) if shift.employee_role_id else None,
        "roleName": shift.employee_role_name,
        "clockInAt": _iso(shift.clock_in_at),
        "clockInDeviceAt": _iso(shift.clock_in_device_at),
        "clockInServerAt": _iso(shift.clock_in_server_at),
        "clockInMachineId": str(shift.clock_in_machine_id) if shift.clock_in_machine_id else None,
        "clockOutAt": _iso(shift.clock_out_at),
        "clockOutDeviceAt": _iso(shift.clock_out_device_at),
        "clockOutServerAt": _iso(shift.clock_out_server_at),
        "clockOutMachineId": str(shift.clock_out_machine_id) if shift.clock_out_machine_id else None,
        "closedBy": shift.closed_by,
        "closedByName": shift.closed_by_name,
        "closeReason": shift.close_reason,
        "breakSince": _iso(open_break.start_at) if open_break is not None else None,
        "breaks": [break_out(b) for b in breaks],
        "breakSeconds": break_seconds(shift, breaks, now),
        "workedSeconds": worked_seconds(shift, breaks, now),
        "clockSkewSeconds": shift.clock_skew_seconds,
        "flags": list(shift.flags or []),
    }


# ── Open tables ("לא ניתן לסיים משמרת") ─────────────────────────────────────


def open_tables_for(db: Session, shop_id: Any, pos_user_id: Any) -> List[Dict[str, Any]]:
    """
    The open tables whose waiter is this employee, as the cloud has them: the synced
    mode's orders and what single-till mode tills reported. A table is its waiter's, else
    its opener's — as the waiters' report counts them.
    """
    ident = str(pos_user_id)
    rows = (
        db.query(TableOrder)
        .filter(
            TableOrder.shop_id == shop_id,
            TableOrder.status == "open",
            or_(
                TableOrder.waiter_pos_user_id == ident,
                (TableOrder.waiter_pos_user_id.is_(None)) & (TableOrder.opened_by_pos_user_id == ident),
            ),
        )
        .order_by(TableOrder.opened_at)
        .all()
    )
    return [
        {
            "orderId": str(o.id),
            "tableId": str(o.table_id),
            "number": o.table_number,
            "name": o.table_name,
            "total": float(o.total or 0),
            "guests": o.guests,
            "openedAt": _iso(o.opened_at),
        }
        for o in rows
    ]


def open_table_counts(db: Session, shop_ids: Iterable[Any]) -> Dict[Tuple[str, str], int]:
    """(shop id, waiter id) → open tables, for the live page in one query."""
    ids = [i for i in {_uuid(s) for s in shop_ids} if i is not None]
    if not ids:
        return {}
    out: Dict[Tuple[str, str], int] = {}
    for shop_id, waiter, opener in (
        db.query(TableOrder.shop_id, TableOrder.waiter_pos_user_id, TableOrder.opened_by_pos_user_id)
        .filter(TableOrder.shop_id.in_(ids), TableOrder.status == "open")
        .all()
    ):
        who = waiter or opener
        if who:
            key = (str(shop_id), str(who))
            out[key] = out.get(key, 0) + 1
    return out


# ── The till's actions ───────────────────────────────────────────────────────


def _pos_user_of_shop(db: Session, machine: POSMachine, pos_user_id: Any) -> PosUser:
    ident = _uuid(pos_user_id)
    pos_user = (
        db.query(PosUser).filter(PosUser.id == ident, PosUser.shop_id == machine.shop_id).first()
        if ident is not None
        else None
    )
    if pos_user is None:
        raise AttendanceError("pos_user_not_found", 404)
    return pos_user


def _role_snapshot(db: Session, pos_user: PosUser) -> Tuple[Optional[uuid.UUID], Optional[str]]:
    role_id = getattr(pos_user, "employee_role_id", None)
    if role_id is None:
        return None, None
    role = db.get(EmployeeRole, role_id)
    return role_id, (role.name if role is not None else None)


def _note_skew(shift: AttendanceShift, sent_at: Optional[datetime], now: datetime) -> None:
    """The device's clock against the cloud's, at delivery; the largest gap is kept."""
    sent_at = as_utc(sent_at)
    if sent_at is None:
        return
    offset = int((now - sent_at).total_seconds())
    if shift.clock_skew_seconds is None or abs(offset) > abs(shift.clock_skew_seconds):
        shift.clock_skew_seconds = offset
    if abs(offset) >= CLOCK_SKEW_FLAG_SECONDS:
        _add_flag(shift, FLAG_CLOCK_SKEW)


def _flag_overlaps(db: Session, shift: AttendanceShift) -> None:
    """
    Another open shift of the same employee: two tills clocked them in while neither could
    see the other (offline). Both are kept and flagged — which one is real is a manager's
    call, made with a correction or a close.
    """
    others = (
        db.query(AttendanceShift)
        .filter(
            AttendanceShift.pos_user_id == shift.pos_user_id,
            AttendanceShift.id != shift.id,
            AttendanceShift.clock_out_at.is_(None),
        )
        .all()
    )
    for other in others:
        _add_flag(other, FLAG_OVERLAP)
    if others:
        _add_flag(shift, FLAG_OVERLAP)


def _ensure_shift(
    db: Session,
    machine: POSMachine,
    pos_user: PosUser,
    body,
    now: datetime,
) -> Tuple[AttendanceShift, bool]:
    """
    The action's shift, made from what the action carries when the cloud has not heard of
    it yet: a clock-in, or any later action that overtook it (or whose clock-in was lost).
    """
    shift = db.get(AttendanceShift, body.shift_id)
    if shift is not None:
        if shift.pos_user_id != pos_user.id or shift.tenant_id != machine.tenant_id:
            raise AttendanceError("attendance_id_conflict", 409)
        return shift, False
    if body.type == "clock_in":
        clock_in = as_utc(body.at)
        machine_in = machine.id
    else:
        clock_in = as_utc(body.shift_clock_in_at) or as_utc(body.at)
        machine_in = _uuid(body.shift_clock_in_machine_id)
        if machine_in is not None and db.get(POSMachine, machine_in) is None:
            machine_in = None
    role_id, role_name = _role_snapshot(db, pos_user)
    shift = AttendanceShift(
        id=body.shift_id,
        tenant_id=machine.tenant_id,
        company_id=_company_of(db, machine.shop_id),
        shop_id=machine.shop_id,
        area_id=machine.area_id,
        pos_user_id=pos_user.id,
        employee_role_id=role_id,
        employee_role_name=role_name,
        status="working",
        source="till",
        clock_in_at=clock_in,
        clock_in_device_at=clock_in,
        clock_in_server_at=now,
        clock_in_machine_id=machine_in,
    )
    if body.type != "clock_in":
        # The clock-in itself never arrived (yet): what we have is the later action's copy.
        _add_flag(shift, FLAG_LATE_EVENT)
    db.add(shift)
    db.flush()
    _flag_overlaps(db, shift)
    return shift, True


def _verify_approver(db: Session, machine: POSMachine, approval) -> Tuple[Optional[str], bool]:
    """
    The manager a till says approved, by the till's word (a PIN checked against the
    roster on the till, offline) — the same word the cloud takes for `cashier_id`. Known
    as a manager of this shop → verified; anyone else is kept and flagged.
    """
    if approval is None or not getattr(approval, "pos_user_id", None):
        return None, False
    ident = _uuid(approval.pos_user_id)
    approver = (
        db.query(PosUser).filter(PosUser.id == ident, PosUser.shop_id == machine.shop_id).first()
        if ident is not None
        else None
    )
    name = pos_user_name(approver) or getattr(approval, "name", None)
    return name, approver is not None and approver.role == PosUserRole.SHOP_MANAGER


def apply_till_action(db: Session, machine: POSMachine, body, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    One attendance action from a till's outbox. Returns `{"status": accepted|duplicate,
    "shift": …}` (and `"adjustment"` for a correction request). The caller commits.
    """
    now = now or _now()
    if machine.shop_id is None:
        raise AttendanceError("machine_not_assigned", 409)
    if body.type not in TILL_ACTION_TYPES:
        raise AttendanceError("unknown_action", 422)
    pos_user = _pos_user_of_shop(db, machine, body.pos_user_id)

    if body.type == "correction_request":
        return _apply_correction_request(db, machine, pos_user, body, now)
    if body.shift_id is None:
        raise AttendanceError("shift_id_required", 422)

    shift, created = _ensure_shift(db, machine, pos_user, body, now)
    changed = created
    at = as_utc(body.at)

    if body.type == "break_start" or body.type == "break_end":
        if body.break_id is None:
            raise AttendanceError("break_id_required", 422)
        row = db.get(AttendanceBreak, body.break_id)
        if row is not None and row.shift_id != shift.id:
            raise AttendanceError("attendance_id_conflict", 409)
        if row is None:
            start = at if body.type == "break_start" else (as_utc(body.break_started_at) or at)
            row = AttendanceBreak(
                id=body.break_id,
                shift_id=shift.id,
                tenant_id=shift.tenant_id,
                pos_user_id=shift.pos_user_id,
                source="till",
                start_at=start,
                start_device_at=start,
                start_server_at=now,
                start_machine_id=machine.id,
            )
            db.add(row)
            changed = True
            if shift.clock_out_at is not None:
                _add_flag(shift, FLAG_LATE_EVENT)
        if body.type == "break_end" and row.end_at is None:
            end = at
            # Never before its start (a device clock moved back in between).
            if as_utc(row.start_at) and end < as_utc(row.start_at):
                end = as_utc(row.start_at)
            row.end_at = end
            row.end_device_at = at
            row.end_server_at = now
            row.end_machine_id = machine.id
            changed = True
        db.flush()

    elif body.type == "clock_out":
        if shift.clock_out_at is None:
            out = at
            if as_utc(shift.clock_in_at) and out < as_utc(shift.clock_in_at):
                out = as_utc(shift.clock_in_at)
            shift.clock_out_at = out
            shift.clock_out_device_at = at
            shift.clock_out_server_at = now
            shift.clock_out_machine_id = machine.id
            shift.closed_by = "self"
            shift.closed_by_pos_user_id = str(pos_user.id)
            shift.closed_by_name = pos_user_name(pos_user)
            if body.reason:
                shift.close_reason = body.reason[:2000]
            # A clock-out during a break ends the break with it.
            for b in breaks_of(db, [shift.id]).get(str(shift.id), []):
                if b.end_at is None:
                    b.end_at = out
                    b.end_device_at = at
                    b.end_server_at = now
                    b.end_machine_id = machine.id
            approval = getattr(body, "approval", None)
            if approval is not None:
                name, verified = _verify_approver(db, machine, approval)
                _set_detail(shift, "clockOutApproval", {
                    "posUserId": approval.pos_user_id,
                    "name": name,
                    "reason": approval.reason,
                    "verified": verified,
                })
                if not verified:
                    _add_flag(shift, FLAG_APPROVAL_UNVERIFIED)
            tables = list(getattr(body, "open_tables", None) or [])
            if tables:
                _set_detail(shift, "openTablesAtClockOut", [t.model_dump(by_alias=True) for t in tables])
                _add_flag(shift, FLAG_OPEN_TABLES)
                _report_till_exception(db, machine, shift, pos_user, approval, tables, now)
            changed = True
        db.flush()

    _note_skew(shift, getattr(body, "sent_at", None), now)
    refresh_status(db, shift)
    db.flush()
    return {"status": "accepted" if changed else "duplicate", "shift": shift_out(db, shift, now=now, pos_user=pos_user)}


def _apply_correction_request(db: Session, machine: POSMachine, pos_user: PosUser, body, now: datetime) -> Dict[str, Any]:
    """"בקשת תיקון נוכחות" from a till: pending until a manager decides. Idempotent by its id."""
    c = body.correction
    if c is None:
        raise AttendanceError("correction_required", 422)
    existing = db.get(AttendanceAdjustment, c.id)
    if existing is not None:
        if existing.pos_user_id != pos_user.id:
            raise AttendanceError("attendance_id_conflict", 409)
        shift = db.get(AttendanceShift, existing.shift_id) if existing.shift_id else None
        return {
            "status": "duplicate",
            "adjustment": adjustment_out(db, existing),
            "shift": shift_out(db, shift, now=now) if shift is not None else None,
        }
    if c.kind not in REQUEST_KINDS:
        raise AttendanceError("unknown_kind", 422)
    shift = db.get(AttendanceShift, body.shift_id) if body.shift_id else None
    if shift is not None and shift.pos_user_id != pos_user.id:
        raise AttendanceError("attendance_id_conflict", 409)
    if shift is None and body.shift_id is not None and getattr(body, "shift_clock_in_at", None) is not None:
        # About a shift whose clock-in has not arrived (yet): placed from the request's copy,
        # so approving a "missing clock-in" corrects it instead of opening a second one.
        shift, _ = _ensure_shift(db, machine, pos_user, body, now)
    adj = AttendanceAdjustment(
        id=c.id,
        tenant_id=machine.tenant_id,
        company_id=_company_of(db, machine.shop_id),
        shop_id=machine.shop_id,
        shift_id=shift.id if shift is not None else None,
        break_id=c.break_id,
        pos_user_id=pos_user.id,
        kind=c.kind,
        field=_field_for(c.kind, c.field),
        original_time=_original_time(db, shift, c.kind, _field_for(c.kind, c.field), c.break_id),
        requested_time=as_utc(c.requested_time),
        requested_end_time=as_utc(c.requested_end_time),
        reason=(c.reason or "")[:2000] or None,
        status="pending",
        source="till",
        requested_by_pos_user_id=str(pos_user.id),
        requested_by_name=pos_user_name(pos_user),
        requested_machine_id=machine.id,
        requested_device_at=as_utc(body.at),
        requested_at=now,
    )
    db.add(adj)
    db.flush()
    if shift is not None:
        refresh_status(db, shift)
        db.flush()
    return {
        "status": "accepted",
        "adjustment": adjustment_out(db, adj),
        "shift": shift_out(db, shift, now=now, pos_user=pos_user) if shift is not None else None,
    }


# ── The till's view ──────────────────────────────────────────────────────────


def open_shift_of(db: Session, pos_user_id: Any) -> Optional[AttendanceShift]:
    """The employee's open shift, at any till; the latest when two are open (flagged)."""
    return (
        db.query(AttendanceShift)
        .filter(AttendanceShift.pos_user_id == pos_user_id, AttendanceShift.clock_out_at.is_(None))
        .order_by(AttendanceShift.clock_in_at.desc())
        .first()
    )


def till_state(
    db: Session,
    machine: POSMachine,
    pos_user: PosUser,
    *,
    shift_id: Any = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    What a till shows after a PIN ("במשמרת מ־17:02"): the employee's open shift wherever
    it was opened, the shift the till asked about (closed by a manager since?), their
    open tables, waiting corrections and today's worked time. Read only.
    """
    now = now or _now()
    shift = open_shift_of(db, pos_user.id)
    known = None
    asked = _uuid(shift_id)
    if asked is not None:
        row = db.get(AttendanceShift, asked)
        if row is not None and row.pos_user_id == pos_user.id:
            known = row
    day_start = now - timedelta(hours=24)
    recent = (
        db.query(AttendanceShift)
        .filter(AttendanceShift.pos_user_id == pos_user.id, AttendanceShift.clock_in_at >= day_start)
        .all()
    )
    breaks = breaks_of(db, [r.id for r in recent] + ([shift.id] if shift else []) + ([known.id] if known else []))
    role_id, role_name = _role_snapshot(db, pos_user)
    pending = (
        db.query(AttendanceAdjustment)
        .filter(AttendanceAdjustment.pos_user_id == pos_user.id, AttendanceAdjustment.status == "pending")
        .count()
    )
    return {
        "serverTime": _iso(now),
        "enabled": policy_for_machine(db, machine).enabled,
        "posUserId": str(pos_user.id),
        "roleName": role_name,
        "shift": shift_out(db, shift, breaks=breaks.get(str(shift.id), []), now=now, pos_user=pos_user) if shift else None,
        "known": shift_out(db, known, breaks=breaks.get(str(known.id), []), now=now, pos_user=pos_user) if known else None,
        "openTables": open_tables_for(db, machine.shop_id, pos_user.id),
        "pendingCorrections": pending,
        "last24hSeconds": sum(worked_seconds(r, breaks.get(str(r.id), []), now) for r in recent),
    }


# ── Corrections and manager actions ──────────────────────────────────────────


def _field_for(kind: str, field: Optional[str]) -> Optional[str]:
    if kind == "missing_in":
        return "clock_in"
    if kind == "missing_out":
        return "clock_out"
    if field in ADJUSTMENT_FIELDS:
        return field
    if kind == "wrong_time":
        return None
    return None


def _original_time(db: Session, shift: Optional[AttendanceShift], kind: str, field: Optional[str], break_id: Any) -> Optional[datetime]:
    if shift is None:
        return None
    if field == "clock_in":
        return shift.clock_in_at
    if field == "clock_out":
        return shift.clock_out_at
    if field in ("break_start", "break_end") and break_id:
        row = db.get(AttendanceBreak, _uuid(break_id))
        if row is not None and row.shift_id == shift.id:
            return row.start_at if field == "break_start" else row.end_at
    return None


def _snapshot(db: Session, shift: Optional[AttendanceShift]) -> Optional[Dict[str, Any]]:
    if shift is None:
        return None
    return {
        "clockInAt": _iso(shift.clock_in_at),
        "clockOutAt": _iso(shift.clock_out_at),
        "status": shift.status,
        "closedBy": shift.closed_by,
        "breaks": [
            {"id": str(b.id), "startAt": _iso(b.start_at), "endAt": _iso(b.end_at)}
            for b in breaks_of(db, [shift.id]).get(str(shift.id), [])
        ],
    }


def _validate(db: Session, shift: AttendanceShift, now: datetime) -> None:
    """Clock-out after clock-in, every break inside the shift, nothing in the future."""
    cin, cout = as_utc(shift.clock_in_at), as_utc(shift.clock_out_at)
    if cin is None:
        raise AttendanceError("clock_in_required")
    if cin > now + FUTURE_TOLERANCE or (cout is not None and cout > now + FUTURE_TOLERANCE):
        raise AttendanceError("time_in_future")
    if cout is not None and cout <= cin:
        raise AttendanceError("clock_out_before_clock_in")
    for b in breaks_of(db, [shift.id]).get(str(shift.id), []):
        start, end = as_utc(b.start_at), as_utc(b.end_at)
        if start < cin or (end is not None and end <= start) or (cout is not None and (end or start) > cout):
            raise AttendanceError("break_outside_shift")


def _who(user: Optional[User] = None, pos_user: Optional[PosUser] = None) -> Dict[str, Any]:
    if user is not None:
        return {"user_id": user.id, "pos_user_id": None, "name": dashboard_user_name(user)}
    return {"user_id": None, "pos_user_id": str(pos_user.id) if pos_user else None, "name": pos_user_name(pos_user)}


def apply_adjustment(
    db: Session,
    adj: AttendanceAdjustment,
    *,
    approved_time: Optional[datetime],
    approved_end_time: Optional[datetime],
    decider: Dict[str, Any],
    now: datetime,
) -> AttendanceShift:
    """
    Make an approved correction true: the times change, the old and the new values are
    kept on the adjustment. Raises `AttendanceError` (and changes nothing the caller
    commits) when the result would not be a valid shift.
    """
    approved_time = as_utc(approved_time)
    approved_end_time = as_utc(approved_end_time)
    shift = db.get(AttendanceShift, adj.shift_id) if adj.shift_id else None
    old = _snapshot(db, shift)

    if adj.kind == "missing_in" and shift is None:
        if approved_time is None:
            raise AttendanceError("time_required")
        pos_user = db.get(PosUser, adj.pos_user_id)
        role_id, role_name = _role_snapshot(db, pos_user) if pos_user is not None else (None, None)
        shift = AttendanceShift(
            id=uuid.uuid4(),
            tenant_id=adj.tenant_id,
            company_id=adj.company_id,
            shop_id=adj.shop_id,
            pos_user_id=adj.pos_user_id,
            employee_role_id=role_id,
            employee_role_name=role_name,
            status="working",
            source="dashboard",
            clock_in_at=approved_time,
            clock_in_server_at=now,
        )
        if approved_end_time is not None:
            shift.clock_out_at = approved_end_time
            shift.clock_out_server_at = now
            shift.closed_by = "manager"
            shift.closed_by_user_id = decider.get("user_id")
            shift.closed_by_pos_user_id = decider.get("pos_user_id")
            shift.closed_by_name = decider.get("name")
            shift.close_reason = adj.reason
        db.add(shift)
        db.flush()
        adj.shift_id = shift.id
        if shift.clock_out_at is None:
            _flag_overlaps(db, shift)
    else:
        if shift is None:
            raise AttendanceError("shift_required")
        field = adj.field or _field_for(adj.kind, None)
        if adj.kind == "break":
            row = db.get(AttendanceBreak, adj.break_id) if adj.break_id else None
            if row is not None and row.shift_id != shift.id:
                raise AttendanceError("break_not_found", 404)
            if row is None:
                if approved_time is None:
                    raise AttendanceError("time_required")
                row = AttendanceBreak(
                    id=uuid.uuid4(), shift_id=shift.id, tenant_id=shift.tenant_id, pos_user_id=shift.pos_user_id,
                    source="dashboard", start_at=approved_time, start_server_at=now,
                    end_at=approved_end_time, end_server_at=now if approved_end_time else None,
                )
                db.add(row)
                adj.break_id = row.id
            elif field == "break_end":
                if approved_time is None:
                    raise AttendanceError("time_required")
                row.end_at = approved_time
                row.end_server_at = now
            else:
                if approved_time is None:
                    raise AttendanceError("time_required")
                row.start_at = approved_time
                if approved_end_time is not None:
                    row.end_at = approved_end_time
                    row.end_server_at = now
        elif field == "clock_in":
            if approved_time is None:
                raise AttendanceError("time_required")
            shift.clock_in_at = approved_time
        elif field == "clock_out":
            if approved_time is None:
                raise AttendanceError("time_required")
            if shift.clock_out_at is None:
                # A missing clock-out: the manager's decision ends the shift.
                shift.closed_by = "manager"
                shift.closed_by_user_id = decider.get("user_id")
                shift.closed_by_pos_user_id = decider.get("pos_user_id")
                shift.closed_by_name = decider.get("name")
                shift.close_reason = adj.reason
                shift.clock_out_server_at = now
                for b in breaks_of(db, [shift.id]).get(str(shift.id), []):
                    if b.end_at is None:
                        b.end_at = approved_time
                        b.end_server_at = now
            shift.clock_out_at = approved_time
        else:
            raise AttendanceError("field_required")
        db.flush()

    _validate(db, shift, now)
    adj.approved_time = approved_time
    adj.approved_end_time = approved_end_time
    adj.old_value = old
    db.flush()
    refresh_status(db, shift)
    adj.new_value = _snapshot(db, shift)
    db.flush()
    return shift


def decide(
    db: Session,
    adj: AttendanceAdjustment,
    *,
    approve: bool,
    approved_time: Optional[datetime] = None,
    approved_end_time: Optional[datetime] = None,
    note: Optional[str] = None,
    user: Optional[User] = None,
    now: Optional[datetime] = None,
) -> AttendanceAdjustment:
    """Approve (as requested, or edited: other times) or reject a pending request."""
    now = now or _now()
    if adj.status != "pending":
        raise AttendanceError("already_decided", 409)
    decider = _who(user=user)
    if approve:
        shift = apply_adjustment(
            db, adj,
            approved_time=approved_time if approved_time is not None else adj.requested_time,
            approved_end_time=approved_end_time if approved_end_time is not None else adj.requested_end_time,
            decider=decider, now=now,
        )
    else:
        shift = db.get(AttendanceShift, adj.shift_id) if adj.shift_id else None
    adj.status = "approved" if approve else "rejected"
    adj.decided_by_user_id = decider["user_id"]
    adj.decided_by_pos_user_id = decider["pos_user_id"]
    adj.decided_by_name = decider["name"]
    adj.decided_at = now
    adj.decision_note = (note or "")[:2000] or None
    db.flush()
    if shift is not None:
        refresh_status(db, shift)
        db.flush()
    if approve:
        record_manual_exception(db, adj, shift, now)
    return adj


def create_by_manager(
    db: Session,
    *,
    shop: Shop,
    pos_user: PosUser,
    kind: str,
    shift: Optional[AttendanceShift],
    field: Optional[str],
    break_id: Any,
    time: Optional[datetime],
    end_time: Optional[datetime],
    reason: str,
    user: User,
    now: Optional[datetime] = None,
) -> AttendanceAdjustment:
    """A manager's own correction from the dashboard: recorded, approved and applied at once."""
    now = now or _now()
    if kind not in REQUEST_KINDS:
        raise AttendanceError("unknown_kind", 422)
    if not (reason or "").strip():
        raise AttendanceError("reason_required")
    if shift is not None and shift.pos_user_id != pos_user.id:
        raise AttendanceError("shift_not_found", 404)
    who = _who(user=user)
    resolved = _field_for(kind, field)
    adj = AttendanceAdjustment(
        id=uuid.uuid4(),
        tenant_id=shop.tenant_id,
        company_id=shop.company_id,
        shop_id=shop.id,
        shift_id=shift.id if shift is not None else None,
        break_id=_uuid(break_id),
        pos_user_id=pos_user.id,
        kind=kind,
        field=resolved,
        original_time=_original_time(db, shift, kind, resolved, break_id),
        requested_time=as_utc(time),
        requested_end_time=as_utc(end_time),
        reason=reason.strip()[:2000],
        status="pending",
        source="dashboard",
        requested_by_user_id=user.id,
        requested_by_name=who["name"],
        requested_at=now,
    )
    db.add(adj)
    db.flush()
    return decide(db, adj, approve=True, user=user, now=now)


def manager_close(
    db: Session,
    shift: AttendanceShift,
    *,
    at: Optional[datetime],
    reason: str,
    user: User,
    ignore_open_tables: bool = False,
    now: Optional[datetime] = None,
) -> AttendanceAdjustment:
    """
    "סגירה ע״י מנהל": a manager ends an open shift (an employee who left without clocking
    out), at a time they choose (default now), with a mandatory reason. Refused over the
    employee's open tables under `preventClockOutWithOpenTables` unless the manager
    confirms (`ignore_open_tables`) — then the tables are kept on the shift and flagged.
    """
    now = now or _now()
    if shift.clock_out_at is not None:
        raise AttendanceError("shift_already_closed", 409)
    if not (reason or "").strip():
        raise AttendanceError("reason_required")
    shop = db.get(Shop, shift.shop_id)
    tables = open_tables_for(db, shift.shop_id, shift.pos_user_id)
    if tables and not ignore_open_tables and policy_for_shop(db, shop).prevent_open_tables:
        raise AttendanceError("open_tables", 409, tables=tables)
    at = as_utc(at) or now
    who = _who(user=user)
    old = _snapshot(db, shift)
    adj = AttendanceAdjustment(
        id=uuid.uuid4(),
        tenant_id=shift.tenant_id,
        company_id=shift.company_id,
        shop_id=shift.shop_id,
        shift_id=shift.id,
        pos_user_id=shift.pos_user_id,
        kind="manager_close",
        field="clock_out",
        original_time=None,
        requested_time=at,
        approved_time=at,
        reason=reason.strip()[:2000],
        status="approved",
        source="dashboard",
        requested_by_user_id=user.id,
        requested_by_name=who["name"],
        requested_at=now,
        decided_by_user_id=user.id,
        decided_by_name=who["name"],
        decided_at=now,
    )
    shift.clock_out_at = at
    shift.clock_out_server_at = now
    shift.closed_by = "manager"
    shift.closed_by_user_id = user.id
    shift.closed_by_name = who["name"]
    shift.close_reason = adj.reason
    for b in breaks_of(db, [shift.id]).get(str(shift.id), []):
        if b.end_at is None:
            b.end_at = max(at, as_utc(b.start_at))
            b.end_server_at = now
    if tables:
        _set_detail(shift, "openTablesAtClockOut", tables)
        _add_flag(shift, FLAG_OPEN_TABLES)
    db.flush()
    _validate(db, shift, now)
    adj.old_value = old
    db.add(adj)
    db.flush()
    refresh_status(db, shift)
    adj.new_value = _snapshot(db, shift)
    db.flush()
    record_manual_exception(db, adj, shift, now)
    return adj


# ── The exceptions ("חריגות") ────────────────────────────────────────────────


def _exception_machine(db: Session, shift: Optional[AttendanceShift], shop_id: Any) -> Optional[POSMachine]:
    """Exceptions belong to a till (their rules resolve per till): the shift's, else the shop's."""
    for ident in ((shift.clock_out_machine_id, shift.clock_in_machine_id) if shift is not None else ()):
        if ident is not None:
            machine = db.get(POSMachine, ident)
            if machine is not None:
                return machine
    return (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop_id)
        .order_by(POSMachine.is_active.desc(), POSMachine.created_at)
        .first()
    )


def _record_exception(db: Session, machine: Optional[POSMachine], key: str, occurred_at: datetime,
                      pos_user_id: Any, details: Dict[str, Any]) -> None:
    """Never fails the change it reports: a savepoint, and an error is only logged."""
    if machine is None:
        return
    try:
        from app.services import exceptions as EX

        if EXCEPTION_TYPE not in getattr(EX, "RULES_BY_TYPE", {}):
            return
        with db.begin_nested():
            EX.record_z_exception(
                db, machine, exception_type=EXCEPTION_TYPE, key=key, occurred_at=occurred_at,
                details=details, pos_user_id=str(pos_user_id) if pos_user_id else None,
            )
    except Exception:  # noqa: BLE001 - the attendance change stands; the audit row is on the adjustment
        logger.exception("could not report attendance change %s to the exceptions", key)


def record_manual_exception(db: Session, adj: AttendanceAdjustment, shift: Optional[AttendanceShift], now: datetime) -> None:
    """A manual attendance change ("שינוי נוכחות ידני", §28) as an exception to review."""
    pos_user = db.get(PosUser, adj.pos_user_id)
    summary = " · ".join(p for p in (
        pos_user_name(pos_user),
        {"manager_close": "סגירה ע״י מנהל", "missing_in": "כניסה חסרה", "missing_out": "יציאה חסרה",
         "wrong_time": "תיקון שעה", "break": "תיקון הפסקה"}.get(adj.kind, adj.kind),
        f"אישר: {adj.decided_by_name}" if adj.decided_by_name else None,
        adj.reason,
    ) if p)
    _record_exception(
        db, _exception_machine(db, shift, adj.shop_id), f"{EXCEPTION_TYPE}:{adj.id}", now, adj.pos_user_id,
        {
            "source": "attendance",
            "summary": summary,
            "kind": adj.kind,
            "shiftId": str(shift.id) if shift is not None else None,
            "adjustmentId": str(adj.id),
            "reason": adj.reason,
            "decidedBy": adj.decided_by_name,
            "old": adj.old_value,
            "new": adj.new_value,
        },
    )


def _report_till_exception(db, machine, shift, pos_user, approval, tables, now) -> None:
    """Clocked out over open tables (on a manager's approval at the till) — an exception."""
    names = ", ".join(str(t.number) for t in tables if getattr(t, "number", None) is not None)
    approver = getattr(approval, "name", None) if approval is not None else None
    summary = " · ".join(p for p in (
        pos_user_name(pos_user),
        f"סיום משמרת עם שולחנות פתוחים ({names})" if names else "סיום משמרת עם שולחנות פתוחים",
        f"אישר: {approver}" if approver else None,
    ) if p)
    _record_exception(
        db, machine, f"{EXCEPTION_TYPE}:clock_out:{shift.id}", now, pos_user.id,
        {
            "source": "attendance",
            "summary": summary,
            "kind": "clock_out_open_tables",
            "shiftId": str(shift.id),
            "approvedBy": approver,
            "tables": [t.model_dump(by_alias=True) for t in tables],
        },
    )


def adjustment_out(db: Session, adj: AttendanceAdjustment, *, pos_user: Optional[PosUser] = None,
                   shop: Optional[Shop] = None) -> Dict[str, Any]:
    if pos_user is None:
        pos_user = db.get(PosUser, adj.pos_user_id)
    return {
        "id": str(adj.id),
        "shopId": str(adj.shop_id),
        "shopName": shop.name if shop is not None else None,
        "shiftId": str(adj.shift_id) if adj.shift_id else None,
        "breakId": str(adj.break_id) if adj.break_id else None,
        "posUserId": str(adj.pos_user_id),
        "posUserName": pos_user_name(pos_user),
        "kind": adj.kind,
        "field": adj.field,
        "originalTime": _iso(adj.original_time),
        "requestedTime": _iso(adj.requested_time),
        "requestedEndTime": _iso(adj.requested_end_time),
        "approvedTime": _iso(adj.approved_time),
        "approvedEndTime": _iso(adj.approved_end_time),
        "reason": adj.reason,
        "status": adj.status,
        "source": adj.source,
        "requestedByName": adj.requested_by_name,
        "requestedAt": _iso(adj.requested_at),
        "requestedDeviceAt": _iso(adj.requested_device_at),
        "requestedMachineId": str(adj.requested_machine_id) if adj.requested_machine_id else None,
        "decidedByName": adj.decided_by_name,
        "decidedAt": _iso(adj.decided_at),
        "decisionNote": adj.decision_note,
        "oldValue": adj.old_value,
        "newValue": adj.new_value,
    }


# ── The dashboard's scope ────────────────────────────────────────────────────

#: Dashboard roles that may not see attendance at all. A dashboard cashier account is not
#: linked to a till employee, so "their own" cannot be told apart; an employee sees their
#: own attendance at the till (`till_state`).
NO_READ_ROLES = frozenset({UserRole.CASHIER})
#: Who edits job titles (tenant-wide): the roles above a branch — like the chain's artwork.
ROLE_DEFINITION_ROLES = frozenset({UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER})


def may_read(user: User) -> bool:
    return user.role not in NO_READ_ROLES


def may_manage(user: User) -> bool:
    """Approve, edit, close: staffing is a manager's job — the till users' rule (`Resource.POS_USER`)."""
    return may(user.role, Resource.POS_USER, Action.WRITE)


def scope_shops(query, user: User, db: Session, shop_column):
    """
    The shops a dashboard user's attendance view covers: the super admin all of the
    tenant; a distributor the shops of their tills; a company manager their companies'
    (with subsidiaries); a branch role their branch. None: no access.
    """
    if not may_read(user):
        return None
    if user.role == UserRole.SUPER_ADMIN:
        return query
    if user.role == UserRole.DISTRIBUTOR:
        shops = db.query(POSMachine.shop_id).filter(POSMachine.distributor_id == user.id)
        return query.filter(shop_column.in_(shops))
    if user.role == UserRole.COMPANY_MANAGER and user.company_id:
        return query.filter(shop_column.in_(visible_shop_ids(db, user)))
    if user.role in SHOP_SCOPED_ROLES and user.shop_id:
        return query.filter(shop_column == user.shop_id)
    return None


def _company_filter(db: Session, query, company_id: Any, column):
    from app.services.company_hierarchy import descendant_company_ids

    if company_id is None:
        return query
    return query.filter(column.in_([company_id, *descendant_company_ids(db, company_id)]))


def _labels(db: Session, shifts: Sequence[AttendanceShift]) -> Dict[str, Dict[str, Any]]:
    users = {
        str(u.id): u for u in db.query(PosUser).filter(PosUser.id.in_({s.pos_user_id for s in shifts})).all()
    } if shifts else {}
    shops = {
        str(s.id): s for s in db.query(Shop).filter(Shop.id.in_({s.shop_id for s in shifts})).all()
    } if shifts else {}
    machine_ids = {m for s in shifts for m in (s.clock_in_machine_id, s.clock_out_machine_id) if m}
    machines = {
        str(m.id): m for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids)).all()
    } if machine_ids else {}
    return {"users": users, "shops": shops, "machines": machines}


def _machine_label(machine: Optional[POSMachine]) -> Optional[Dict[str, Any]]:
    if machine is None:
        return None
    return {"id": str(machine.id), "name": machine.name, "posNumber": machine.pos_number or machine.machine_code}


# ── "עובדים במשמרת" ──────────────────────────────────────────────────────────


def live(
    db: Session,
    user: User,
    tenant_id: Any,
    *,
    company_id: Any = None,
    shop_id: Any = None,
    role_id: Any = None,
    now: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """Every open shift in the caller's scope, as cards; None when the caller sees nothing."""
    now = now or _now()
    query = db.query(AttendanceShift).filter(
        AttendanceShift.tenant_id == tenant_id, AttendanceShift.clock_out_at.is_(None)
    )
    query = scope_shops(query, user, db, AttendanceShift.shop_id)
    if query is None:
        return None
    query = _company_filter(db, query, _uuid(company_id), AttendanceShift.company_id)
    if _uuid(shop_id) is not None:
        query = query.filter(AttendanceShift.shop_id == _uuid(shop_id))
    if _uuid(role_id) is not None:
        query = query.filter(AttendanceShift.employee_role_id == _uuid(role_id))
    shifts = query.order_by(AttendanceShift.clock_in_at).all()

    labels = _labels(db, shifts)
    breaks = breaks_of(db, [s.id for s in shifts])
    tables = open_table_counts(db, {s.shop_id for s in shifts})
    pending = {}
    if shifts:
        for sid, in (
            db.query(AttendanceAdjustment.shift_id)
            .filter(AttendanceAdjustment.shift_id.in_([s.id for s in shifts]), AttendanceAdjustment.status == "pending")
            .all()
        ):
            pending[str(sid)] = pending.get(str(sid), 0) + 1
    # Where they are signed in now — shown, never used to decide anything (§2).
    from app.models.pos_user_session import PosUserSession

    sessions = {}
    if shifts:
        for row in (
            db.query(PosUserSession)
            .filter(PosUserSession.pos_user_id.in_({s.pos_user_id for s in shifts}), PosUserSession.released_at.is_(None))
            .all()
        ):
            sessions[str(row.pos_user_id)] = row.machine_id
    session_machines = {
        str(m.id): m for m in db.query(POSMachine).filter(POSMachine.id.in_(set(sessions.values()))).all()
    } if sessions else {}

    cards = []
    for s in shifts:
        pu = labels["users"].get(str(s.pos_user_id))
        shop = labels["shops"].get(str(s.shop_id))
        out = shift_out(db, s, breaks=breaks.get(str(s.id), []), now=now, pos_user=pu)
        current = session_machines.get(str(sessions.get(str(s.pos_user_id)))) if str(s.pos_user_id) in sessions else None
        out.update({
            "shopName": shop.name if shop is not None else None,
            "durationSeconds": _seconds(s.clock_in_at, now),
            "openTables": tables.get((str(s.shop_id), str(s.pos_user_id)), 0),
            "pendingCorrections": pending.get(str(s.id), 0),
            "currentMachine": _machine_label(current),
            "signedIn": current is not None,
            "clockInMachine": _machine_label(labels["machines"].get(str(s.clock_in_machine_id))),
        })
        cards.append(out)
    by_status: Dict[str, int] = {}
    by_role: Dict[str, int] = {}
    for c in cards:
        by_status[c["status"]] = by_status.get(c["status"], 0) + 1
        by_role[c["roleName"] or ""] = by_role.get(c["roleName"] or "", 0) + 1
    return {
        "serverTime": _iso(now),
        "shifts": cards,
        "counts": {"total": len(cards), "byStatus": by_status, "byRole": by_role},
    }


# ── The attendance report ────────────────────────────────────────────────────


def report(
    db: Session,
    user: User,
    tenant_id: Any,
    *,
    window,
    company_id: Any = None,
    shop_id: Any = None,
    pos_user_id: Any = None,
    role_id: Any = None,
    now: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """
    One row per shift that started in the window (the organization's local days):
    date, in, out, breaks, worked hours and notes; and per employee, the totals. Phase 3's
    payroll export reads these rows — never with pay rules written into this function.
    """
    from app.services.reports import _load_zoneinfo

    now = now or _now()
    query = db.query(AttendanceShift).filter(
        AttendanceShift.tenant_id == tenant_id,
        AttendanceShift.clock_in_at >= window.start,
        AttendanceShift.clock_in_at < window.end,
    )
    query = scope_shops(query, user, db, AttendanceShift.shop_id)
    if query is None:
        return None
    query = _company_filter(db, query, _uuid(company_id), AttendanceShift.company_id)
    if _uuid(shop_id) is not None:
        query = query.filter(AttendanceShift.shop_id == _uuid(shop_id))
    if _uuid(pos_user_id) is not None:
        query = query.filter(AttendanceShift.pos_user_id == _uuid(pos_user_id))
    if _uuid(role_id) is not None:
        query = query.filter(AttendanceShift.employee_role_id == _uuid(role_id))
    shifts = query.order_by(AttendanceShift.clock_in_at).all()

    tz = _load_zoneinfo(window.tz_name)
    labels = _labels(db, shifts)
    breaks = breaks_of(db, [s.id for s in shifts])
    corrections: Dict[str, int] = {}
    if shifts:
        for sid, status in (
            db.query(AttendanceAdjustment.shift_id, AttendanceAdjustment.status)
            .filter(AttendanceAdjustment.shift_id.in_([s.id for s in shifts]))
            .all()
        ):
            if status == "approved":
                corrections[str(sid)] = corrections.get(str(sid), 0) + 1

    rows = []
    totals: Dict[str, Dict[str, Any]] = {}
    for s in shifts:
        pu = labels["users"].get(str(s.pos_user_id))
        shop = labels["shops"].get(str(s.shop_id))
        b = breaks.get(str(s.id), [])
        out = shift_out(db, s, breaks=b, now=now, pos_user=pu)
        local_in = as_utc(s.clock_in_at).astimezone(tz)
        notes = list(s.flags or [])
        if s.closed_by == "manager":
            notes.append("closed_by_manager")
        if s.clock_out_at is None:
            notes.append("open")
        if corrections.get(str(s.id)):
            notes.append("corrected")
        out.update({
            "date": local_in.date().isoformat(),
            "shopName": shop.name if shop is not None else None,
            "breakCount": len(b),
            "notes": notes,
            "correctionCount": corrections.get(str(s.id), 0),
            "clockInMachine": _machine_label(labels["machines"].get(str(s.clock_in_machine_id))),
            "clockOutMachine": _machine_label(labels["machines"].get(str(s.clock_out_machine_id))),
        })
        rows.append(out)
        t = totals.setdefault(str(s.pos_user_id), {
            "posUserId": str(s.pos_user_id),
            "posUserName": out["posUserName"],
            "workerNumber": out["workerNumber"],
            "roleName": out["roleName"],
            "shifts": 0,
            "workedSeconds": 0,
            "breakSeconds": 0,
            "openShifts": 0,
        })
        t["shifts"] += 1
        t["workedSeconds"] += out["workedSeconds"]
        t["breakSeconds"] += out["breakSeconds"]
        t["openShifts"] += 1 if s.clock_out_at is None else 0
    return {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"),
        "rows": rows,
        "byEmployee": sorted(totals.values(), key=lambda r: (r["posUserName"] or "")),
        "totals": {
            "shifts": len(rows),
            "workedSeconds": sum(r["workedSeconds"] for r in rows),
            "breakSeconds": sum(r["breakSeconds"] for r in rows),
        },
    }


def adjustments(
    db: Session,
    user: User,
    tenant_id: Any,
    *,
    status: Optional[str] = None,
    company_id: Any = None,
    shop_id: Any = None,
    pos_user_id: Any = None,
    shift_id: Any = None,
    limit: int = 500,
) -> Optional[List[Dict[str, Any]]]:
    query = db.query(AttendanceAdjustment).filter(AttendanceAdjustment.tenant_id == tenant_id)
    query = scope_shops(query, user, db, AttendanceAdjustment.shop_id)
    if query is None:
        return None
    query = _company_filter(db, query, _uuid(company_id), AttendanceAdjustment.company_id)
    if status:
        query = query.filter(AttendanceAdjustment.status.in_([s for s in status.split(",") if s]))
    if _uuid(shop_id) is not None:
        query = query.filter(AttendanceAdjustment.shop_id == _uuid(shop_id))
    if _uuid(pos_user_id) is not None:
        query = query.filter(AttendanceAdjustment.pos_user_id == _uuid(pos_user_id))
    if _uuid(shift_id) is not None:
        query = query.filter(AttendanceAdjustment.shift_id == _uuid(shift_id))
    rows = query.order_by(AttendanceAdjustment.requested_at.desc()).limit(limit).all()
    users = {str(u.id): u for u in db.query(PosUser).filter(PosUser.id.in_({r.pos_user_id for r in rows})).all()} if rows else {}
    shops = {str(s.id): s for s in db.query(Shop).filter(Shop.id.in_({r.shop_id for r in rows})).all()} if rows else {}
    return [adjustment_out(db, r, pos_user=users.get(str(r.pos_user_id)), shop=shops.get(str(r.shop_id))) for r in rows]


# ── Job titles ("תפקידים") ───────────────────────────────────────────────────


def role_out(role: EmployeeRole, *, employees: int = 0) -> Dict[str, Any]:
    return {
        "id": str(role.id),
        "name": role.name,
        "tipWeight": float(role.tip_weight if role.tip_weight is not None else 1),
        "sortOrder": role.sort_order,
        "isActive": bool(role.is_active),
        "employees": employees,
    }


def roles_of(db: Session, tenant_id: Any, *, include_inactive: bool = False) -> List[EmployeeRole]:
    query = db.query(EmployeeRole).filter(EmployeeRole.tenant_id == tenant_id)
    if not include_inactive:
        query = query.filter(EmployeeRole.is_active.is_(True))
    return query.order_by(EmployeeRole.sort_order, EmployeeRole.name).all()


def add_default_roles(db: Session, tenant_id: Any) -> List[EmployeeRole]:
    """The spec's six job titles, those missing by name. Idempotent; the caller commits."""
    existing = {r.name for r in db.query(EmployeeRole).filter(EmployeeRole.tenant_id == tenant_id).all()}
    added = []
    for i, (name, weight) in enumerate(DEFAULT_EMPLOYEE_ROLES):
        if name in existing:
            continue
        role = EmployeeRole(id=uuid.uuid4(), tenant_id=tenant_id, name=name, tip_weight=Decimal(weight),
                            sort_order=(i + 1) * 10, is_active=True)
        db.add(role)
        added.append(role)
    db.flush()
    return added


def clean_role_name(name: Any) -> str:
    text = str(name or "").strip()
    if not text:
        raise AttendanceError("name_required")
    if len(text) > 60:
        raise AttendanceError("name_too_long")
    return text


def clean_tip_weight(value: Any) -> Decimal:
    try:
        weight = Decimal(str(value))
    except Exception:  # noqa: BLE001
        raise AttendanceError("invalid_tip_weight")
    if weight < 0 or weight > 100:
        raise AttendanceError("invalid_tip_weight")
    return weight.quantize(Decimal("0.001"))
