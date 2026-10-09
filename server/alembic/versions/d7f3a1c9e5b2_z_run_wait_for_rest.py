"""z_runs.wait_for_rest — a shop's day close ("סגירת יום סניפית") asked from remote control

The shop's cloud Z run started from remote control ("שליטה מרחוק", app/services/remote_till_z.py,
behind REMOTE_TILL_Z_ENABLED) asks each till to close only once it is at rest — no sale, no
payment, no card in flight; the till reads `waitForRest` on its close-shift. Every other run is
unchanged (false).

Idempotent (the column is looked at first). Revision ID: d7f3a1c9e5b2, revises e4b9d2a7c6f1.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "d7f3a1c9e5b2"
down_revision: Union[str, Sequence[str], None] = "e4b9d2a7c6f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns() -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("z_runs")}


def upgrade() -> None:
    if "wait_for_rest" not in _columns():
        op.add_column("z_runs", sa.Column("wait_for_rest", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    if "wait_for_rest" in _columns():
        op.drop_column("z_runs", "wait_for_rest")
