"""
Employee attendance ("נוכחות עובדים", docs/SPEC_ATTENDANCE.md) — phase 1.

**Separate from the POS login on purpose** (the spec's §2): `pos_user_sessions` says who
is signed in at which till; this says who is *at work*. Signing in, switching user,
signing out, the idle lock or moving to another till never start or end an attendance
shift. Only an explicit clock-out (the employee at a till) or a recorded manager action
(a correction approved, a manager's close) ends one. Nor is it the till's cash shift
(`shifts`, X/Z): a waiter works one attendance shift across several tills' cash shifts.

Four tables:

* `employee_roles` — the tenant's job titles ("מלצר", "ברמן", "ראנר"…) with the tip weight
  phase 2's points-based tip pool will read. Not a permission: the till user's `role`
  (cashier / shop_manager) still decides what they may do. Linked from
  `pos_users.employee_role_id` (nullable).
* `attendance_shifts` — one stretch of work of one employee: clock-in, clock-out, who
  closed it and how. The id is the till's (a UUID made when the employee clocked in), so
  an offline till's replay is the same shift. Each end keeps three times: the official
  one (`clock_in_at`), what the device's clock said (`clock_in_device_at`) and when the
  cloud first heard of it (`clock_in_server_at`) — a gap between the device's clock and
  the cloud's is flagged for a manager (`clock_skew_seconds`, `flags`).
* `attendance_breaks` — the breaks of a shift; the id is the till's too.
* `attendance_adjustments` — every manual change, as a request and its decision: an
  employee's "בקשת תיקון נוכחות" from a till (pending until a manager approves, rejects
  or edits it), a manager's own correction, a manager's close. With the original, the
  requested and the approved time, the old and the new value, who, when, where and why —
  the attendance audit trail.

Extension points (phases 2/3): tip pools and settlements read the shifts' worked time and
`employee_role_id` / `tip_weight`; schedules ("סידור עבודה") will reference the shift to
compare planned with actual; payroll rules read the report, never this table's columns
directly.
"""
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

#: Not Working is simply "no open shift"; it is never stored.
ATTENDANCE_STATUSES = ("working", "on_break", "finished", "pending_approval")
ATTENDANCE_SOURCES = ("till", "dashboard")
#: self — the employee clocked out; manager — a manager's close or an approved correction.
CLOSED_BY = ("self", "manager")
ADJUSTMENT_KINDS = (
    # Requests (an employee at a till, or a manager on the dashboard).
    "missing_in", "missing_out", "wrong_time", "break",
    # A manager's direct actions, recorded for the audit.
    "manager_close",
)
ADJUSTMENT_FIELDS = ("clock_in", "clock_out", "break_start", "break_end")
ADJUSTMENT_STATUSES = ("pending", "approved", "rejected")

#: The job titles a tenant starts with ("הוסף תפקידים מוצעים"), with the spec's example
#: weights (§20). Editable; nothing in the code depends on these names.
DEFAULT_EMPLOYEE_ROLES = (
    ("מלצר", "1"),
    ("ברמן", "1"),
    ("ראנר", "0.7"),
    ("מארחת", "0.5"),
    ("אחמ״ש", "1.2"),
    ("מטבח", "0.6"),
)


class EmployeeRole(Base):
    __tablename__ = "employee_roles"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_employee_roles_tenant_name"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(60), nullable=False)
    #: Phase 2 (points-based tip pool): an employee's points = hours × this weight.
    tip_weight = Column(Numeric(6, 3), nullable=False, default=1, server_default="1")
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AttendanceShift(Base):
    __tablename__ = "attendance_shifts"
    __table_args__ = (
        CheckConstraint(
            "status IN ('working', 'on_break', 'finished', 'pending_approval')",
            name="ck_attendance_shifts_status",
        ),
        CheckConstraint("source IN ('till', 'dashboard')", name="ck_attendance_shifts_source"),
        Index("ix_attendance_shifts_shop_in", "shop_id", "clock_in_at"),
        Index("ix_attendance_shifts_user_in", "pos_user_id", "clock_in_at"),
        Index("ix_attendance_shifts_tenant_status", "tenant_id", "status"),
    )

    #: Made by the till at clock-in: a replay is the same shift.
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: The point of sale of the till the employee clocked in at, if any.
    area_id = Column(UUID(as_uuid=True), nullable=True)
    pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=False)
    #: The employee's job title when they clocked in (a snapshot: reports and phase 2's
    #: tip weights go by the role they worked in, not today's).
    employee_role_id = Column(UUID(as_uuid=True), nullable=True)
    employee_role_name = Column(String(60), nullable=True)

    status = Column(String(20), nullable=False, default="working", server_default="working")
    #: Where the shift was opened: a till, or a manager on the dashboard (an approved
    #: "missing clock-in" with no shift behind it).
    source = Column(String(16), nullable=False, default="till", server_default="till")

    clock_in_at = Column(DateTime(timezone=True), nullable=False)
    clock_in_device_at = Column(DateTime(timezone=True), nullable=True)
    clock_in_server_at = Column(DateTime(timezone=True), nullable=True)
    clock_in_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)

    clock_out_at = Column(DateTime(timezone=True), nullable=True)
    clock_out_device_at = Column(DateTime(timezone=True), nullable=True)
    clock_out_server_at = Column(DateTime(timezone=True), nullable=True)
    clock_out_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)

    #: self | manager (`CLOSED_BY`), and the manager's name / ids / reason when a manager.
    closed_by = Column(String(16), nullable=True)
    closed_by_name = Column(String(200), nullable=True)
    closed_by_pos_user_id = Column(String(100), nullable=True)
    closed_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    close_reason = Column(Text, nullable=True)

    #: The largest gap seen between a till's clock and the cloud's on this shift's actions
    #: (seconds, signed: positive = the device was behind). Flagged above a threshold.
    clock_skew_seconds = Column(Integer, nullable=True)
    #: What a manager should look at: "clock_skew", "overlap" (another open shift of the
    #: same employee), "open_tables" (clocked out with open tables, on approval),
    #: "approval_unverified" (an approver the cloud does not know as a manager)…
    flags = Column(JSONB, nullable=True)
    #: The till's context: the approval at clock-out, the open tables then…
    details = Column(JSONB, nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AttendanceBreak(Base):
    __tablename__ = "attendance_breaks"
    __table_args__ = (
        Index("ix_attendance_breaks_shift", "shift_id", "start_at"),
    )

    #: Made by the till when the break started.
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    shift_id = Column(UUID(as_uuid=True), ForeignKey("attendance_shifts.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    pos_user_id = Column(UUID(as_uuid=True), nullable=False)
    source = Column(String(16), nullable=False, default="till", server_default="till")

    start_at = Column(DateTime(timezone=True), nullable=False)
    start_device_at = Column(DateTime(timezone=True), nullable=True)
    start_server_at = Column(DateTime(timezone=True), nullable=True)
    start_machine_id = Column(UUID(as_uuid=True), nullable=True)

    end_at = Column(DateTime(timezone=True), nullable=True)
    end_device_at = Column(DateTime(timezone=True), nullable=True)
    end_server_at = Column(DateTime(timezone=True), nullable=True)
    end_machine_id = Column(UUID(as_uuid=True), nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AttendanceAdjustment(Base):
    __tablename__ = "attendance_adjustments"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')", name="ck_attendance_adjustments_status"
        ),
        Index("ix_attendance_adjustments_shop_status", "shop_id", "status"),
        Index("ix_attendance_adjustments_shift", "shift_id"),
        Index("ix_attendance_adjustments_user", "pos_user_id", "requested_at"),
    )

    #: A till's request carries its own id (idempotent replay); the dashboard's is made here.
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: The shift it is about; null for a "missing clock-in" with no shift (approving it
    #: opens one, and links it here).
    shift_id = Column(UUID(as_uuid=True), ForeignKey("attendance_shifts.id", ondelete="SET NULL"), nullable=True)
    break_id = Column(UUID(as_uuid=True), nullable=True)
    #: The employee.
    pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=False)

    kind = Column(String(20), nullable=False)
    #: Which time it changes: clock_in | clock_out | break_start | break_end.
    field = Column(String(20), nullable=True)
    original_time = Column(DateTime(timezone=True), nullable=True)
    requested_time = Column(DateTime(timezone=True), nullable=True)
    #: The other end, for a whole missing shift or break ("נכנסתי ב-16:05 ויצאתי ב-23:40").
    requested_end_time = Column(DateTime(timezone=True), nullable=True)
    approved_time = Column(DateTime(timezone=True), nullable=True)
    approved_end_time = Column(DateTime(timezone=True), nullable=True)
    reason = Column(Text, nullable=True)

    status = Column(String(16), nullable=False, default="pending", server_default="pending")
    source = Column(String(16), nullable=False, default="till", server_default="till")

    requested_by_pos_user_id = Column(String(100), nullable=True)
    requested_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    requested_by_name = Column(String(200), nullable=True)
    requested_machine_id = Column(UUID(as_uuid=True), nullable=True)
    requested_device_at = Column(DateTime(timezone=True), nullable=True)
    requested_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    decided_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_by_pos_user_id = Column(String(100), nullable=True)
    decided_by_name = Column(String(200), nullable=True)
    decided_at = Column(DateTime(timezone=True), nullable=True)
    decision_note = Column(Text, nullable=True)

    #: The audit: the shift's (or break's) times before and after the change was applied.
    old_value = Column(JSONB, nullable=True)
    new_value = Column(JSONB, nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
