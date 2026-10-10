"""pos_machines.capabilities and .reported_open_shift_claimed_at — from the till's own heartbeat

Remote control ("סגירת משמרת / Z מרחוק", "סגירת יום סניפית", app/services/remote_till_z.py) asks a
till only when its heartbeat says `capabilities: ["remote_close_v2"]` — the build with every
remote-close safeguard — instead of trusting a version count (counts differ per branch). Null for
a till that never said (an older build): never asked.

`reported_open_shift_claimed_at`: when the till itself last reported its open shift (or none) —
written only by its heartbeat, never by a cloud-side action. "No shift open" is trusted only when
reported after the last shift the cloud saw for the till (app/services/z_shift_guard.py).

Idempotent (the column is looked at first). Revision ID: f2a6c8e4b1d9, revises d7f3a1c9e5b2.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "f2a6c8e4b1d9"
down_revision: Union[str, Sequence[str], None] = "d7f3a1c9e5b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns() -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("pos_machines")}


def upgrade() -> None:
    have = _columns()
    if "capabilities" not in have:
        op.add_column("pos_machines", sa.Column("capabilities", postgresql.JSONB(), nullable=True))
    if "reported_open_shift_claimed_at" not in have:
        op.add_column("pos_machines", sa.Column("reported_open_shift_claimed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    have = _columns()
    if "reported_open_shift_claimed_at" in have:
        op.drop_column("pos_machines", "reported_open_shift_claimed_at")
    if "capabilities" in have:
        op.drop_column("pos_machines", "capabilities")
