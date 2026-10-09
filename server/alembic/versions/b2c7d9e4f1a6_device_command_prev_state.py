"""device_commands.prev_state — the lock as it was before a lock / unlock, for a cancel to restore

A dashboard lock or unlock changes the device's lock state at once; cancelling it before the device
took it puts back exactly what was there (locked or not, its message, when and by whom).

Idempotent (the column is looked at first). Revision ID: b2c7d9e4f1a6, revises af7b5d2e4c96.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "b2c7d9e4f1a6"
down_revision: Union[str, Sequence[str], None] = "af7b5d2e4c96"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "device_commands"


def _columns() -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if "prev_state" not in _columns():
        op.add_column(TABLE, sa.Column("prev_state", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    if "prev_state" in _columns():
        op.drop_column(TABLE, "prev_state")
