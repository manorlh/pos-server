"""report_export_defaults + report_export_default_audit

"ברירת מחדל לייצוא" (P:/specs/reports-upgrade.md §2ב): which columns a company's Excel / PDF
export of each report takes by default — one row per (company, report), set by the company's
manager, a distributor or a super admin — and the audit of every change.

Idempotent: each table is looked at first (the API's create_all may have made it before this
runs — then only its missing indexes are added). Never needs a downgrade in practice; the
downgrade drops only what this revision adds.

Revision ID: f3b8d1e6a2c9, revises c7e4a2f9d1b6 (13.10.2026).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "f3b8d1e6a2c9"
down_revision: Union[str, Sequence[str], None] = "c7e4a2f9d1b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEFAULTS = "report_export_defaults"
AUDIT = "report_export_default_audit"
INDEXES = (
    (DEFAULTS, "ix_report_export_defaults_company_id", ["company_id"]),
    (AUDIT, "ix_report_export_default_audit_company", ["company_id", "created_at"]),
)


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_table(table: str) -> bool:
    if _offline():
        return False
    return sa.inspect(op.get_bind()).has_table(table)


def _indexes(table: str) -> set:
    if _offline():
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _uuid():
    return postgresql.UUID(as_uuid=True)


def _json():
    return postgresql.JSONB().with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    if not _has_table(DEFAULTS):
        op.create_table(
            DEFAULTS,
            sa.Column("id", _uuid(), primary_key=True),
            sa.Column("company_id", _uuid(), sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
            sa.Column("report_key", sa.String(length=64), nullable=False),
            sa.Column("columns", _json(), nullable=False),
            sa.Column("updated_by", _uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("company_id", "report_key", name="uq_report_export_defaults_company_report"),
        )
    if not _has_table(AUDIT):
        op.create_table(
            AUDIT,
            sa.Column("id", _uuid(), primary_key=True),
            sa.Column("company_id", _uuid(), sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
            sa.Column("report_key", sa.String(length=64), nullable=False),
            sa.Column("action", sa.String(length=16), nullable=False),
            sa.Column("before", _json(), nullable=True),
            sa.Column("after", _json(), nullable=True),
            sa.Column("actor_user_id", _uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("actor_name", sa.String(length=200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    for table, name, cols in INDEXES:
        if name not in _indexes(table):
            op.create_index(name, table, cols)


def downgrade() -> None:
    op.drop_table(AUDIT)
    op.drop_table(DEFAULTS)
