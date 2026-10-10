"""Remote close forced by default: remote_force on the requests a till is handed

"כפה סגירה" (app/services/remote_close_force.py): a close or a Z asked from remote control is forced
from the moment the manager sends it — the till parameter `remoteCloseForceByDefault` (default on), or
the manager's tick for that one request. The mode rides on the request the till is handed: a Z run's
item, a shift close request, a till Z request (`remoteForce` beside `waitForRest`). False everywhere
else and on every row before this: unchanged.

Idempotent (the columns are looked at first). Revision ID: d9b3f7a1c5e8, revises b8e2d4f6a1c3.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "d9b3f7a1c5e8"
down_revision: Union[str, Sequence[str], None] = "c7d1e5a9f3b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("z_run_items", "shift_close_requests", "till_z_requests")


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    for table in TABLES:
        if "remote_force" not in _columns(table):
            op.add_column(table, sa.Column("remote_force", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    for table in TABLES:
        if "remote_force" in _columns(table):
            op.drop_column(table, "remote_force")
