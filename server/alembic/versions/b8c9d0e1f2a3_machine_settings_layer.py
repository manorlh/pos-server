"""POS settings for a single till: the last layer under tenant → company → shop

* `pos_machines.settings` — the till's own overrides, the same keys as the other
  layers. `{}` for every existing till.
* `pos_machines.settings_updated_at` — when they last changed. NULL for every existing
  till, so no till's settings watermark moves on upgrade.

Parent is the till's printer state (f1a2b3c4d5e6).

Revision ID: b8c9d0e1f2a3
Revises: f1a2b3c4d5e6
Create Date: 2026-10-03 17:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "b8c9d0e1f2a3"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pos_machines",
        sa.Column("settings", postgresql.JSONB(), nullable=False, server_default="{}"),
    )
    op.add_column(
        "pos_machines",
        sa.Column("settings_updated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pos_machines", "settings_updated_at")
    op.drop_column("pos_machines", "settings")
