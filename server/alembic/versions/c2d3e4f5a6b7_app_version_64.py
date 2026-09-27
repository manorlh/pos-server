"""pos_machines.app_version holds 64 characters

The till's version string (e.g. "0.1.105-debug+sha.abcdef1") outgrew 32, and the heartbeat
rejected the whole beat on it. The heartbeat now truncates instead of rejecting; the
column is widened so a real version string is not cut.

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-09-28 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "c2d3e4f5a6b7"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "pos_machines", "app_version",
        existing_type=sa.String(32), type_=sa.String(64), existing_nullable=True,
    )


def downgrade() -> None:
    op.execute("UPDATE pos_machines SET app_version = left(app_version, 32)")
    op.alter_column(
        "pos_machines", "app_version",
        existing_type=sa.String(64), type_=sa.String(32), existing_nullable=True,
    )
