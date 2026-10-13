"""
"בקשת אישור ממנהל מהנייד" (P:/specs/manager-approval-mobile.md) — the tables.

* `approval_requests` — one request a till sent to the cloud: what is asked (type, amount,
  percent, reason, note, the lines / table / document in `payload`), who asked (the till user
  signed in at the till), to whom it went (`sent_to`, dashboard user ids — the approvers'
  devices got a push), and what came of it (status, who decided, what was approved, the
  approver's message). An approval yields a one-use grant: an `elevated_sessions` row bound to
  this request, its machine and its approved amount (`grant_session_id`, spent at
  `grant_used_at`). Idempotent per till by `client_request_id`.
* `approval_policy_values` — one level's own settings ("בקשות אישור" in the settings):
  company → shop → area (נקודת מכירה) → machine, every field inherited from the level above
  when a level does not set it (app/services/remote_approvals/policy.py).
* `dashboard_user_employees` — "עובד מקושר": a dashboard user is the person behind one or more
  till employees (`pos_users`, one per shop they work at). The link decides the till role, the
  limits and the attendance ("במשמרת") the approvals read. An employee belongs to one person.

Everything here is the cloud's; a till only ever sees its own requests.
"""
import uuid

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

APPROVAL_STATUSES = ("pending", "approved", "rejected", "expired", "cancelled")
POLICY_LEVELS = ("company", "shop", "area", "machine")


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"
    __table_args__ = (
        UniqueConstraint("machine_id", "client_request_id", name="uq_approval_requests_machine_client"),
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')",
            name="ck_approval_requests_status",
        ),
        Index("ix_approval_requests_tenant_status_created", "tenant_id", "status", "created_at"),
        Index("ix_approval_requests_machine_status", "machine_id", "status"),
        Index("ix_approval_requests_shop_created", "shop_id", "created_at"),
        Index("ix_approval_requests_status_expires", "status", "expires_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: The till's own id for the request: a retry of the same POST finds this row.
    client_request_id = Column(String(64), nullable=False)
    #: One of the §3 types (app/services/remote_approvals/catalog.py).
    type = Column(String(32), nullable=False)

    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)

    #: The till user signed in at the till who asked (a snapshot of the name beside it).
    requester_pos_user_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    requester_name = Column(String(200), nullable=True)
    #: The approvers the employee chose (dashboard user ids), or null — "כל המורשים".
    chosen_approver_ids = Column(JSONB, nullable=True)
    #: Who the request went to: `[{"userId", "name", "at", "via"}]` (via: request | add | escalation).
    sent_to = Column(JSONB, nullable=False, default=list, server_default="[]")

    amount = Column(Numeric(12, 2), nullable=True)
    percent = Column(Numeric(7, 2), nullable=True)
    reason_code = Column(String(100), nullable=True)
    reason_text = Column(String(200), nullable=True)
    #: The employee's own message to the manager (≤ 200).
    note = Column(String(200), nullable=True)
    #: What the approver sees: `{lines, table, document, …}` as the till sent it.
    payload = Column(JSONB, nullable=True)

    status = Column(String(16), nullable=False, default="pending", server_default="pending")
    decided_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_by_name = Column(String(200), nullable=True)
    #: The approver's employee at this shop (a linked till user), for the document.
    decided_by_pos_user_id = Column(UUID(as_uuid=True), nullable=True)
    #: From which device the decision came (its user agent's label).
    decided_from = Column(String(200), nullable=True)
    decided_at = Column(DateTime(timezone=True), nullable=True)
    approved_amount = Column(Numeric(12, 2), nullable=True)
    approved_percent = Column(Numeric(7, 2), nullable=True)
    #: The approver's message back to the till.
    message = Column(String(500), nullable=True)

    expires_at = Column(DateTime(timezone=True), nullable=False)
    escalated_at = Column(DateTime(timezone=True), nullable=True)

    #: The one-use grant an approval yields (`elevated_sessions`), and when it was spent.
    grant_session_id = Column(UUID(as_uuid=True), nullable=True)
    grant_expires_at = Column(DateTime(timezone=True), nullable=True)
    grant_used_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ApprovalPolicyValue(Base):
    """One level's own approval settings. Only what the level sets is stored; the rest inherits."""

    __tablename__ = "approval_policy_values"
    __table_args__ = (
        UniqueConstraint("scope_type", "scope_id", name="uq_approval_policy_values_scope"),
        CheckConstraint(
            "scope_type IN ('company', 'shop', 'area', 'machine')",
            name="ck_approval_policy_values_scope",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    scope_type = Column(String(16), nullable=False)
    scope_id = Column(UUID(as_uuid=True), nullable=False)
    #: `{"enabled": bool?, "types": {type: {field: value}}}` — absent / null = inherit.
    values = Column(JSONB, nullable=False, default=dict, server_default="{}")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class DashboardUserEmployee(Base):
    """"עובד מקושר": this dashboard user is the person behind this till employee."""

    __tablename__ = "dashboard_user_employees"
    __table_args__ = (
        UniqueConstraint("pos_user_id", name="uq_dashboard_user_employees_pos_user"),
        Index("ix_dashboard_user_employees_user", "user_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=False)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
