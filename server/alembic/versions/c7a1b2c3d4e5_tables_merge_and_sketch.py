"""tables: merged orders ("איחוד שולחנות") and the zone sketch

* `table_orders.status` may be `merged`; `table_orders.merged_into_id` names the order
  its lines went into.
* `table_zones.sketch` — the vector floor plan drawn under a map zone's tables.

Guarded: a dev database may already have the columns from a previous run.

Revision ID: c7a1b2c3d4e5
Revises: c69e0f1a2b38
Create Date: 2026-10-04 04:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "c7a1b2c3d4e5"
down_revision = "c69e0f1a2b38"
branch_labels = None
depends_on = None


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _checks(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_check_constraints(table)}


def upgrade() -> None:
    if "sketch" not in _columns("table_zones"):
        op.add_column("table_zones", sa.Column("sketch", postgresql.JSONB(), nullable=True))
    if "merged_into_id" not in _columns("table_orders"):
        op.add_column("table_orders", sa.Column("merged_into_id", postgresql.UUID(as_uuid=True), nullable=True))
    if "ck_table_orders_status" in _checks("table_orders"):
        op.drop_constraint("ck_table_orders_status", "table_orders", type_="check")
    op.create_check_constraint(
        "ck_table_orders_status",
        "table_orders",
        "status IN ('open', 'paid', 'cancelled', 'void', 'merged')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_table_orders_status", "table_orders", type_="check")
    op.create_check_constraint(
        "ck_table_orders_status", "table_orders", "status IN ('open', 'paid', 'cancelled', 'void')"
    )
    op.drop_column("table_orders", "merged_into_id")
    op.drop_column("table_zones", "sketch")
