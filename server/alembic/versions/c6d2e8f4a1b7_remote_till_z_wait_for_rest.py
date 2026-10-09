"""till_z_requests / shift_close_requests.wait_for_rest — a Z or a shift close asked from remote control

"שליטה מרחוק" may ask a till for its Z (or a shift close) after a manager confirmed its current
totals (app/services/remote_till_z.py, behind REMOTE_TILL_Z_ENABLED). Such a request waits until
the till is at rest — no sale, no payment, no card in flight — and never closes mid-sale: the till
reads `waitForRest` on the request. Every other request is unchanged (false).

Idempotent (each column is looked at first). Revision ID: c6d2e8f4a1b7, revises b2c7d9e4f1a6.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "c6d2e8f4a1b7"
down_revision: Union[str, Sequence[str], None] = "b2c7d9e4f1a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("till_z_requests", "shift_close_requests")


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    for table in TABLES:
        if "wait_for_rest" not in _columns(table):
            op.add_column(table, sa.Column("wait_for_rest", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    for table in TABLES:
        if "wait_for_rest" in _columns(table):
            op.drop_column(table, "wait_for_rest")
