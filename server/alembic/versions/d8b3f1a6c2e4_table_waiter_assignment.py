"""table_assignments + table_notices, dining_tables.lock_seen_at, pos_users.table_color

"שיוך שולחנות ואזורים למלצר" (P:/specs/table-waiter-assignment.md, app/services/table_assignments.py):

- `table_assignments` — a waiter on a zone or a table (one of the two), the business day it was made on,
  who made it, and when it was released (and why). Rows are only ever released, never edited.
- `table_notices` — a short message about a table for one device or one waiter: an entry request to the
  device inside a busy table (§8 `request`), "מוכן להגשה" / "שולחן מתעכב" for the assigned waiter (§5).
- `dining_tables.lock_seen_at` — the lock's last heartbeat: a lock that ran out unreleased says
  "המכשיר לא מדווח מאז…" (§8).
- `pos_users.table_color` — the waiter's colour on the floor; null: chosen automatically.

The parameters (`tableAssignment*`, `tableBusyEntry`, `tableBusyShowHolder`) are built-ins, created at
startup (`ensure_builtin_parameters`); the till permission TABLES.ASSIGN falls to every role from its
template (app/services/till_permissions.py). Nothing else to move.

Add-only and idempotent (the auto-reloaded API may have created the tables from the models before this
runs).

Revision ID: d8b3f1a6c2e4
Revises: bb6205ba290c
Create Date: 2026-10-14 18:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "d8b3f1a6c2e4"
down_revision: Union[str, Sequence[str], None] = "bb6205ba290c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ASSIGNMENTS = "table_assignments"
NOTICES = "table_notices"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _exists(table: str) -> bool:
    insp = _inspector()
    return insp is not None and insp.has_table(table)


def _has_column(table: str, column: str) -> bool:
    insp = _inspector()
    return insp is not None and column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    if not _exists(ASSIGNMENTS):
        op.create_table(
            ASSIGNMENTS,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", uid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("zone_id", uid, sa.ForeignKey("table_zones.id", ondelete="CASCADE"), nullable=True),
            sa.Column("table_id", uid, sa.ForeignKey("dining_tables.id", ondelete="CASCADE"), nullable=True),
            sa.Column("pos_user_id", uid, sa.ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("business_day", sa.Date(), nullable=False),
            sa.Column("assigned_by", sa.String(200), nullable=True),
            sa.Column("assigned_by_pos_user_id", uid, nullable=True),
            sa.Column("assigned_by_user_id", uid, nullable=True),
            sa.Column("source", sa.String(12), nullable=False, server_default="till"),
            sa.Column("machine_id", uid, nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("released_reason", sa.String(16), nullable=True),
            sa.Column("released_by", sa.String(200), nullable=True),
            sa.CheckConstraint(
                "(zone_id IS NULL AND table_id IS NOT NULL) OR (zone_id IS NOT NULL AND table_id IS NULL)",
                name="ck_table_assignments_target",
            ),
        )
        op.create_index("ix_table_assignments_tenant_id", ASSIGNMENTS, ["tenant_id"])
        op.create_index("ix_table_assignments_shop_released", ASSIGNMENTS, ["shop_id", "released_at"])
        op.create_index("ix_table_assignments_shop_day", ASSIGNMENTS, ["shop_id", "business_day"])
        op.create_index(
            "uq_table_assignments_live_table", ASSIGNMENTS, ["table_id", "pos_user_id"], unique=True,
            postgresql_where=sa.text("released_at IS NULL AND table_id IS NOT NULL"),
        )
        op.create_index(
            "uq_table_assignments_live_zone", ASSIGNMENTS, ["zone_id", "pos_user_id"], unique=True,
            postgresql_where=sa.text("released_at IS NULL AND zone_id IS NOT NULL"),
        )
    if not _exists(NOTICES):
        op.create_table(
            NOTICES,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", uid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("table_id", uid, sa.ForeignKey("dining_tables.id", ondelete="CASCADE"), nullable=True),
            sa.Column("order_id", uid, nullable=True),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("to_machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=True),
            sa.Column("to_pos_user_id", sa.String(100), nullable=True),
            sa.Column("from_machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("from_pos_user_id", sa.String(100), nullable=True),
            sa.Column("from_pos_user_name", sa.String(200), nullable=True),
            sa.Column("text", sa.String(300), nullable=False),
            sa.Column("payload", postgresql.JSONB(), nullable=True),
            sa.Column("dedupe_key", sa.String(160), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("answer", sa.String(12), nullable=True),
            sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("answered_by_name", sa.String(200), nullable=True),
            sa.CheckConstraint("kind IN ('entry_request', 'kds_ready', 'overdue')", name="ck_table_notices_kind"),
        )
        op.create_index("ix_table_notices_tenant_id", NOTICES, ["tenant_id"])
        op.create_index("ix_table_notices_to_machine", NOTICES, ["to_machine_id", "expires_at"])
        op.create_index("ix_table_notices_shop_user", NOTICES, ["shop_id", "to_pos_user_id", "expires_at"])
        op.create_index("uq_table_notices_dedupe", NOTICES, ["dedupe_key"], unique=True)
    if not _has_column("dining_tables", "lock_seen_at"):
        op.add_column("dining_tables", sa.Column("lock_seen_at", sa.DateTime(timezone=True), nullable=True))
    if not _has_column("pos_users", "table_color"):
        op.add_column("pos_users", sa.Column("table_color", sa.String(9), nullable=True))


def downgrade() -> None:
    op.drop_column("pos_users", "table_color")
    op.drop_column("dining_tables", "lock_seen_at")
    op.drop_table(NOTICES)
    op.drop_table(ASSIGNMENTS)
