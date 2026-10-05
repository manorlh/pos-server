"""exceptions ("חריגות"): detected exceptions, their rules per level, and till events

* `audit_exceptions` — one detected exception (type, where, who, amount, review state);
  `dedupe_key` unique so detection is idempotent.
* `exception_rule_values` — per level (tenant/company/shop/area/till) and type: on/off
  and thresholds; null inherits.
* `till_events` — what the till records that no document carries (voided line,
  cancelled basket, basket timing, drawer opened).

Guarded like a1c2e3f4b5d6: the app's `create_all` may already have made the tables.

Revision ID: ae1b2c3d4e5f
Revises: e5f6a7b8c9d0
Create Date: 2026-10-03 23:50:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "ae1b2c3d4e5f"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def _existing_tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _existing_indexes(table: str, tables: set) -> set:
    if context.is_offline_mode() or table not in tables:
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    tables = _existing_tables()
    if "audit_exceptions" not in tables:
        op.create_table(
            "audit_exceptions",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("company_id", UUID, nullable=True),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id"), nullable=True),
            sa.Column("area_id", UUID, nullable=True),
            sa.Column("machine_id", UUID, sa.ForeignKey("pos_machines.id"), nullable=True),
            sa.Column("shift_id", UUID, nullable=True),
            sa.Column("transaction_id", UUID, nullable=True),
            sa.Column("till_event_id", UUID, nullable=True),
            sa.Column("exception_type", sa.String(32), nullable=False),
            sa.Column("severity", sa.String(16), nullable=False),
            sa.Column("dedupe_key", sa.String(200), nullable=False),
            sa.Column("pos_user_id", sa.String(100), nullable=True),
            sa.Column("pos_user_name", sa.String(200), nullable=True),
            sa.Column("amount", sa.Numeric(12, 2), nullable=True),
            sa.Column("value", sa.Numeric(12, 2), nullable=True),
            sa.Column("threshold", sa.Numeric(12, 2), nullable=True),
            sa.Column("details", postgresql.JSONB(), nullable=True),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("status", sa.String(16), nullable=False, server_default="new"),
            sa.Column("reviewed_by_user_id", UUID, sa.ForeignKey("users.id"), nullable=True),
            sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("review_note", sa.Text(), nullable=True),
            sa.UniqueConstraint("dedupe_key", name="uq_audit_exceptions_dedupe_key"),
            sa.CheckConstraint(
                "status IN ('new', 'reviewed', 'dismissed')", name="ck_audit_exceptions_status"
            ),
        )
    if "exception_rule_values" not in tables:
        op.create_table(
            "exception_rule_values",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("scope_type", sa.String(16), nullable=False),
            sa.Column("scope_id", UUID, nullable=False),
            sa.Column("exception_type", sa.String(32), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=True),
            sa.Column("params", postgresql.JSONB(), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_by", UUID, sa.ForeignKey("users.id"), nullable=True),
            sa.UniqueConstraint(
                "scope_type", "scope_id", "exception_type", name="uq_exception_rule_values_scope_type"
            ),
            sa.CheckConstraint(
                "scope_type IN ('tenant', 'company', 'shop', 'area', 'machine')",
                name="ck_exception_rule_values_scope",
            ),
        )
    if "till_events" not in tables:
        op.create_table(
            "till_events",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("machine_id", UUID, sa.ForeignKey("pos_machines.id"), nullable=False),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id"), nullable=True),
            sa.Column("area_id", UUID, nullable=True),
            sa.Column("shift_id", UUID, nullable=True),
            sa.Column("event_type", sa.String(32), nullable=False),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("pos_user_id", sa.String(100), nullable=True),
            sa.Column("amount", sa.Numeric(12, 2), nullable=True),
            sa.Column("transaction_id", UUID, nullable=True),
            sa.Column("details", postgresql.JSONB(), nullable=True),
            sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )

    tables = _existing_tables()
    wanted = (
        ("audit_exceptions", "ix_audit_exceptions_tenant_occurred", ["tenant_id", "occurred_at"]),
        ("audit_exceptions", "ix_audit_exceptions_shop_occurred", ["shop_id", "occurred_at"]),
        ("audit_exceptions", "ix_audit_exceptions_machine", ["machine_id"]),
        ("audit_exceptions", "ix_audit_exceptions_transaction", ["transaction_id"]),
        ("audit_exceptions", "ix_audit_exceptions_exception_type", ["exception_type"]),
        ("audit_exceptions", "ix_audit_exceptions_pos_user_id", ["pos_user_id"]),
        ("audit_exceptions", "ix_audit_exceptions_status", ["status"]),
        ("exception_rule_values", "ix_exception_rule_values_tenant_id", ["tenant_id"]),
        ("till_events", "ix_till_events_tenant_id", ["tenant_id"]),
        ("till_events", "ix_till_events_machine_occurred", ["machine_id", "occurred_at"]),
    )
    for table, name, columns in wanted:
        if name not in _existing_indexes(table, tables):
            op.create_index(name, table, columns)


def downgrade() -> None:
    op.drop_table("till_events")
    op.drop_table("exception_rule_values")
    op.drop_table("audit_exceptions")
