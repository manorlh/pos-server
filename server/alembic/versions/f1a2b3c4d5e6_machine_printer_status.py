"""the till's printer state, from its heartbeat (docs/SHIFTS_API.md §1.6a)

* `pos_machines.printer_*` — the last `printer` block the till sent: status, vendor code,
  message, when the till observed it and when it last printed fine, and when the cloud
  received it. All null for a till that never reported, which is every till today.

Parent is card transmission (e0f1a2b3c4d5).

Revision ID: f1a2b3c4d5e6
Revises: e0f1a2b3c4d5
Create Date: 2026-10-01 12:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "f1a2b3c4d5e6"
down_revision = "e0f1a2b3c4d5"
branch_labels = None
depends_on = None


_MACHINE_COLUMNS = (
    ("printer_status", sa.String(16)),
    ("printer_error_code", sa.Integer()),
    ("printer_message", sa.String(200)),
    ("printer_status_at", sa.DateTime(timezone=True)),
    ("printer_last_ok_at", sa.DateTime(timezone=True)),
    ("printer_reported_at", sa.DateTime(timezone=True)),
)


def upgrade() -> None:
    for name, type_ in _MACHINE_COLUMNS:
        op.add_column("pos_machines", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _type in reversed(_MACHINE_COLUMNS):
        op.drop_column("pos_machines", name)
