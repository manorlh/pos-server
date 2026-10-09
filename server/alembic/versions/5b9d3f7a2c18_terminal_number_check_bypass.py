""""עקיפת בדיקת מספר מסוף": the till's report, and the till parameters' change log

* `pos_machines.terminal_number_check_bypass_reported` — what the till says it applies on its
  heartbeat (`terminalNumberCheckBypass`; null: never said). app/services/terminal_check_bypass.py.
* `till_parameter_changes` — every change made on the parameters page: who, when, which level,
  the action and the values before and after (app/services/till_parameter_audit.py).

The parameter itself is a built-in (`ensure_builtin_parameters` creates it at startup).
Idempotent: the auto-reloading dev API's `create_all` may make the new table before this runs,
so every table, column and index is looked at first. Never downgraded in place.

Revision ID: 5b9d3f7a2c18
Revises: 4c8e1a7d3f62
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "5b9d3f7a2c18"
down_revision: Union[str, Sequence[str], None] = "4c8e1a7d3f62"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CHANGES = "till_parameter_changes"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _has_table(insp, name: str) -> bool:
    return insp is not None and insp.has_table(name)


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def upgrade() -> None:
    insp = _inspector()

    if "terminal_number_check_bypass_reported" not in _columns(insp, "pos_machines"):
        op.add_column(
            "pos_machines",
            sa.Column("terminal_number_check_bypass_reported", sa.Boolean(), nullable=True),
        )

    if not _has_table(insp, CHANGES):
        op.create_table(
            CHANGES,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("parameter_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("parameter_key", sa.String(64), nullable=False),
            sa.Column("scope_type", sa.String(16), nullable=False),
            sa.Column("scope_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("action", sa.String(16), nullable=False),
            sa.Column("old_value", postgresql.JSONB(), nullable=True),
            sa.Column("new_value", postgresql.JSONB(), nullable=True),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("user_email", sa.String(255), nullable=True),
            sa.Column("user_role", sa.String(32), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        insp = _inspector()
    existing = _indexes(insp, CHANGES)
    if "ix_till_parameter_changes_key_at" not in existing:
        op.create_index("ix_till_parameter_changes_key_at", CHANGES, ["parameter_key", "created_at"])
    if "ix_till_parameter_changes_scope" not in existing:
        op.create_index("ix_till_parameter_changes_scope", CHANGES, ["scope_type", "scope_id"])


def downgrade() -> None:
    # Never run in place (other agents' columns live beside these); kept for completeness.
    op.drop_index("ix_till_parameter_changes_scope", table_name=CHANGES)
    op.drop_index("ix_till_parameter_changes_key_at", table_name=CHANGES)
    op.drop_table(CHANGES)
    op.drop_column("pos_machines", "terminal_number_check_bypass_reported")
