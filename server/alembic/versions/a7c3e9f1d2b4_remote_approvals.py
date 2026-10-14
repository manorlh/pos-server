"""remote manager approvals: requests, per-level policy, linked employees, grant binding

"בקשת אישור ממנהל מהנייד" (P:/specs/manager-approval-mobile.md):

* `approval_requests` — a till's request for a manager's approval from the phone, its
  recipients, its decision and the one-use grant it yields. Unique per till by the till's own
  `client_request_id` (a retried POST is the same request).
* `approval_policy_values` — one level's own settings (company → shop → area → machine), only
  what the level sets; the rest inherits. Nothing stored = the feature is off (the default).
* `dashboard_user_employees` — "עובד מקושר": a dashboard user ↔ the till employees they are.
* `elevated_sessions.approval_request_id / max_amount / max_percent` — a grant made by a remote
  approval, and the amount / percent a grant (remote or PIN with an amount) was given for.

All new and nullable; nothing is backfilled. Idempotent like the other create-table migrations:
a dev API that already made the tables (`create_all` at startup) only gets what is missing.

Revision ID: a7c3e9f1d2b4
Revises: 78c88a7afc4f
Create Date: 2026-10-13 20:00:00.000000
"""
from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "a7c3e9f1d2b4"
down_revision = "78c88a7afc4f"
branch_labels = None
depends_on = None


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _has_table(insp, name: str) -> bool:
    return insp is not None and insp.has_table(name)


def _indexes(insp, table: str) -> set:
    return set() if insp is None or not insp.has_table(table) else {i["name"] for i in insp.get_indexes(table)}


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _index(insp, name: str, table: str, cols) -> None:
    if name not in _indexes(insp, table):
        op.create_index(name, table, cols)


def upgrade() -> None:
    insp = _inspector()
    if not _has_table(insp, "approval_requests"):
        _create_requests()
    insp = _inspector()
    _index(insp, "ix_approval_requests_tenant_status_created", "approval_requests", ["tenant_id", "status", "created_at"])
    _index(insp, "ix_approval_requests_machine_status", "approval_requests", ["machine_id", "status"])
    _index(insp, "ix_approval_requests_shop_created", "approval_requests", ["shop_id", "created_at"])
    _index(insp, "ix_approval_requests_status_expires", "approval_requests", ["status", "expires_at"])
    _index(insp, "ix_approval_requests_requester_pos_user_id", "approval_requests", ["requester_pos_user_id"])

    if not _has_table(insp, "approval_policy_values"):
        _create_policy()
    insp = _inspector()
    _index(insp, "ix_approval_policy_values_tenant_id", "approval_policy_values", ["tenant_id"])

    if not _has_table(insp, "dashboard_user_employees"):
        _create_links()
    insp = _inspector()
    _index(insp, "ix_dashboard_user_employees_user", "dashboard_user_employees", ["user_id"])
    _index(insp, "ix_dashboard_user_employees_tenant_id", "dashboard_user_employees", ["tenant_id"])

    have = _columns(insp, "elevated_sessions")
    if "approval_request_id" not in have:
        op.add_column("elevated_sessions", sa.Column("approval_request_id", UUID(as_uuid=True), nullable=True))
    if "max_amount" not in have:
        op.add_column("elevated_sessions", sa.Column("max_amount", sa.Numeric(12, 2), nullable=True))
    if "max_percent" not in have:
        op.add_column("elevated_sessions", sa.Column("max_percent", sa.Numeric(7, 2), nullable=True))
    _index(_inspector(), "ix_elevated_sessions_approval_request_id", "elevated_sessions", ["approval_request_id"])


def _create_requests() -> None:
    op.create_table(
        "approval_requests",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("client_request_id", sa.String(64), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("company_id", UUID(as_uuid=True), nullable=True),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=False),
        sa.Column("area_id", UUID(as_uuid=True), nullable=True),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column(
            "requester_pos_user_id", UUID(as_uuid=True),
            sa.ForeignKey("pos_users.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("requester_name", sa.String(200), nullable=True),
        sa.Column("chosen_approver_ids", JSONB, nullable=True),
        sa.Column("sent_to", JSONB, nullable=False, server_default="[]"),
        sa.Column("amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("percent", sa.Numeric(7, 2), nullable=True),
        sa.Column("reason_code", sa.String(100), nullable=True),
        sa.Column("reason_text", sa.String(200), nullable=True),
        sa.Column("note", sa.String(200), nullable=True),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column(
            "decided_by_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("decided_by_name", sa.String(200), nullable=True),
        sa.Column("decided_by_pos_user_id", UUID(as_uuid=True), nullable=True),
        sa.Column("decided_from", sa.String(200), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("approved_percent", sa.Numeric(7, 2), nullable=True),
        sa.Column("message", sa.String(500), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("escalated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("grant_session_id", UUID(as_uuid=True), nullable=True),
        sa.Column("grant_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("grant_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("machine_id", "client_request_id", name="uq_approval_requests_machine_client"),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')",
            name="ck_approval_requests_status",
        ),
    )


def _create_policy() -> None:
    op.create_table(
        "approval_policy_values",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("scope_type", sa.String(16), nullable=False),
        sa.Column("scope_id", UUID(as_uuid=True), nullable=False),
        sa.Column("values", JSONB, nullable=False, server_default="{}"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column(
            "updated_by", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.UniqueConstraint("scope_type", "scope_id", name="uq_approval_policy_values_scope"),
        sa.CheckConstraint(
            "scope_type IN ('company', 'shop', 'area', 'machine')", name="ck_approval_policy_values_scope",
        ),
    )


def _create_links() -> None:
    op.create_table(
        "dashboard_user_employees",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True,
        ),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "pos_user_id", UUID(as_uuid=True), sa.ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("created_by", UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("pos_user_id", name="uq_dashboard_user_employees_pos_user"),
    )


def downgrade() -> None:
    op.drop_index("ix_elevated_sessions_approval_request_id", table_name="elevated_sessions")
    op.drop_column("elevated_sessions", "max_percent")
    op.drop_column("elevated_sessions", "max_amount")
    op.drop_column("elevated_sessions", "approval_request_id")
    op.drop_index("ix_dashboard_user_employees_tenant_id", table_name="dashboard_user_employees")
    op.drop_index("ix_dashboard_user_employees_user", table_name="dashboard_user_employees")
    op.drop_table("dashboard_user_employees")
    op.drop_index("ix_approval_policy_values_tenant_id", table_name="approval_policy_values")
    op.drop_table("approval_policy_values")
    for name in (
        "ix_approval_requests_requester_pos_user_id",
        "ix_approval_requests_status_expires",
        "ix_approval_requests_shop_created",
        "ix_approval_requests_machine_status",
        "ix_approval_requests_tenant_status_created",
    ):
        op.drop_index(name, table_name="approval_requests")
    op.drop_table("approval_requests")
