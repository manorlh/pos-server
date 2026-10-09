"""Held sales at a remote close: keep_held_sales, held_sales, cancel_held_sales

A till asked to close from remote control defers while it holds held sales ("מכירות מושהות",
deferral `held_sales`). A manager may let it close anyway, keeping them — only where the shop's
`allowCloseWithHeldSales` is on, or a super admin with a reason (app/services/held_sales_close.py).
The flag rides on the request the till is handed: a Z run's item, a shift close request, a till Z
request. False everywhere else: unchanged.

`held_sales` (JSONB): the list the till reported when it deferred (`held_sales`): per sale its id,
time, cashier, item count, total and item names — what the manager sees before confirming.
`cancel_held_sales` (JSONB): "בטל מכירות מושהות וסגור", confirmed — the sale ids, the reason, who,
when. The till discards exactly those (never one added since) and closes.

Idempotent (the columns are looked at first). Revision ID: b8e2d4f6a1c3, revises f2a6c8e4b1d9.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "b8e2d4f6a1c3"
down_revision: Union[str, Sequence[str], None] = "f2a6c8e4b1d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("z_run_items", "shift_close_requests", "till_z_requests")


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    from sqlalchemy.dialects import postgresql

    for table in TABLES:
        have = _columns(table)
        if "keep_held_sales" not in have:
            op.add_column(table, sa.Column("keep_held_sales", sa.Boolean(), nullable=False, server_default=sa.text("false")))
        if "held_sales" not in have:
            op.add_column(table, sa.Column("held_sales", postgresql.JSONB(), nullable=True))
        if "cancel_held_sales" not in have:
            op.add_column(table, sa.Column("cancel_held_sales", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    for table in TABLES:
        have = _columns(table)
        for column in ("cancel_held_sales", "held_sales", "keep_held_sales"):
            if column in have:
                op.drop_column(table, column)
