"""Wire shapes of the attendance module ("נוכחות עובדים", app/services/attendance.py)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


# ── The till's outbox (`POST /sync/{machine_id}/attendance/actions`) ─────────


class AttendanceApprovalIn(_Camel):
    """A manager's PIN at the till (checked there, offline): a clock-out's approval, or `onBehalf`."""

    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    name: Optional[str] = Field(None, max_length=200)
    #: open_tables | require_manager | on_behalf
    reason: Optional[str] = Field(None, max_length=60)


class AttendanceOpenTableIn(_Camel):
    table_id: Optional[str] = Field(None, alias="tableId", max_length=100)
    number: Optional[int] = None
    name: Optional[str] = Field(None, max_length=100)
    #: Shekels.
    total: Optional[float] = None


class AttendanceCorrectionIn(_Camel):
    """"בקשת תיקון נוכחות": what and when, by the employee. `id` is the till's."""

    id: uuid.UUID
    kind: Literal["missing_in", "missing_out", "wrong_time", "break"]
    #: clock_in | clock_out | break_start | break_end — needed for wrong_time / an existing break.
    field: Optional[Literal["clock_in", "clock_out", "break_start", "break_end"]] = None
    break_id: Optional[uuid.UUID] = Field(None, alias="breakId")
    requested_time: Optional[datetime] = Field(None, alias="requestedTime")
    requested_end_time: Optional[datetime] = Field(None, alias="requestedEndTime")
    reason: Optional[str] = Field(None, max_length=2000)


class AttendanceActionIn(_Camel):
    """
    One attendance action, as the till's outbox delivers it. Idempotent by the ids it
    carries (the shift's, the break's, the correction's); `id` is the action's own, for
    the log. `at` is the device's clock when it happened; `sentAt` the device's clock when
    the outbox sent it — their gap from the cloud's clock is how a wrong device clock is
    told from an offline delay.
    """

    id: uuid.UUID
    type: Literal["clock_in", "break_start", "break_end", "clock_out", "correction_request"]
    pos_user_id: str = Field(..., alias="posUserId", max_length=100)
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    break_id: Optional[uuid.UUID] = Field(None, alias="breakId")
    at: datetime
    sent_at: Optional[datetime] = Field(None, alias="sentAt")
    #: The shift as the till knows it, for a cloud that has not heard of its clock-in.
    shift_clock_in_at: Optional[datetime] = Field(None, alias="shiftClockInAt")
    shift_clock_in_machine_id: Optional[str] = Field(None, alias="shiftClockInMachineId", max_length=100)
    #: A break's start, for a cloud that has not heard of it when its end arrives.
    break_started_at: Optional[datetime] = Field(None, alias="breakStartedAt")
    approval: Optional[AttendanceApprovalIn] = None
    open_tables: Optional[List[AttendanceOpenTableIn]] = Field(None, alias="openTables", max_length=200)
    reason: Optional[str] = Field(None, max_length=2000)
    correction: Optional[AttendanceCorrectionIn] = None
    #: "קוד עובד בכל פעולה": how the till confirmed the action — `code` (the employee's own
    #: code at that moment), `manager` (a manager's code, acting for them: `onBehalf`) or
    #: `session` (the till's signed-in session only). Plain text, not a closed list: a newer
    #: till's word (a card, say) must not park its outbox row. Never the code itself.
    verified_by: Optional[str] = Field(None, alias="verifiedBy", max_length=20)
    #: `clock` ("שעון נוכחות" on the sign-in screen) | `session` (inside a signed-in session).
    origin: Optional[str] = Field(None, max_length=20)
    #: The manager who acted for the employee, by their code at the till (offline, as `approval`).
    on_behalf: Optional[AttendanceApprovalIn] = Field(None, alias="onBehalf")


# ── The dashboard ────────────────────────────────────────────────────────────


class DecisionIn(_Camel):
    decision: Literal["approve", "reject"]
    #: "Edit": approve with other times than were asked for.
    approved_time: Optional[datetime] = Field(None, alias="approvedTime")
    approved_end_time: Optional[datetime] = Field(None, alias="approvedEndTime")
    note: Optional[str] = Field(None, max_length=2000)


class ManagerAdjustmentIn(_Camel):
    shop_id: uuid.UUID = Field(..., alias="shopId")
    pos_user_id: uuid.UUID = Field(..., alias="posUserId")
    kind: Literal["missing_in", "missing_out", "wrong_time", "break"]
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    field: Optional[Literal["clock_in", "clock_out", "break_start", "break_end"]] = None
    break_id: Optional[uuid.UUID] = Field(None, alias="breakId")
    time: Optional[datetime] = None
    end_time: Optional[datetime] = Field(None, alias="endTime")
    reason: str = Field(..., min_length=1, max_length=2000)


class ManagerCloseIn(_Camel):
    #: Default: now.
    at: Optional[datetime] = None
    reason: str = Field(..., min_length=1, max_length=2000)
    #: Close although the employee still has open tables (under preventClockOutWithOpenTables).
    ignore_open_tables: bool = Field(False, alias="ignoreOpenTables")


class EmployeeRoleIn(_Camel):
    name: str = Field(..., min_length=1, max_length=60)
    tip_weight: float = Field(1.0, alias="tipWeight", ge=0, le=100)
    sort_order: Optional[int] = Field(None, alias="sortOrder")


class EmployeeRolePatch(_Camel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    tip_weight: Optional[float] = Field(None, alias="tipWeight", ge=0, le=100)
    sort_order: Optional[int] = Field(None, alias="sortOrder")
    is_active: Optional[bool] = Field(None, alias="isActive")


class EmployeeRoleAssignIn(_Camel):
    #: Null: no job title.
    role_id: Optional[uuid.UUID] = Field(None, alias="roleId")
