"""the till's card terminal (Agamento), from its heartbeat

* `pos_machines.terminal_*` — the last `terminal` block the till sent: the terminal
  number Agamento reports, its clearing server, whether it is in offline mode, when the
  cloud received it, and the till's last write into Agamento. All null for a till that
  never reported, which is every till today.

Parent is the area settings layer (f0a1b2c3d4e6).

Revision ID: f0a1b2c3d4e7
Revises: f0a1b2c3d4e6
Create Date: 2026-10-03 23:55:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f0a1b2c3d4e7"
down_revision = "f0a1b2c3d4e6"
branch_labels = None
depends_on = None


_MACHINE_COLUMNS = (
    ("terminal_number", sa.String(20)),
    ("terminal_clearing_server", sa.String(16)),
    ("terminal_offline_mode", sa.Boolean()),
    ("terminal_reported_at", sa.DateTime(timezone=True)),
    ("terminal_last_write", postgresql.JSONB()),
)


def _existing_columns() -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("pos_machines")}


def upgrade() -> None:
    # Guarded like f0a1b2c3d4e6: a database the app started against first may already
    # have them from `create_all`.
    columns = _existing_columns()
    for name, type_ in _MACHINE_COLUMNS:
        if name not in columns:
            op.add_column("pos_machines", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _type in reversed(_MACHINE_COLUMNS):
        op.drop_column("pos_machines", name)
