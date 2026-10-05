"""table orders: "שחזור שולחן" — a closed order restored to an open table

`restored_at` / `restored_by_pos_user_name` mark a paid or cancelled order whose lines a
till put back on a table: it is restored once, and leaves the till's "נסגרו היום" list.
Idempotent (the auto-reloading API may have created the columns first).

Revision ID: c5e7a9b1d3f5
Revises: b4d6f8a0c2e4
Create Date: 2026-10-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c5e7a9b1d3f5'
down_revision: Union[str, Sequence[str], None] = 'b4d6f8a0c2e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns() -> set:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("table_orders")}


def upgrade() -> None:
    have = _columns()
    if "restored_at" not in have:
        op.add_column("table_orders", sa.Column("restored_at", sa.DateTime(timezone=True), nullable=True))
    if "restored_by_pos_user_name" not in have:
        op.add_column("table_orders", sa.Column("restored_by_pos_user_name", sa.String(200), nullable=True))


def downgrade() -> None:
    have = _columns()
    if "restored_by_pos_user_name" in have:
        op.drop_column("table_orders", "restored_by_pos_user_name")
    if "restored_at" in have:
        op.drop_column("table_orders", "restored_at")
