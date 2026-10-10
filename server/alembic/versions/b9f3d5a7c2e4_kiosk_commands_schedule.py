"""Kiosk commands: "schedule" ("פתיחה אוטומטית") and the lock's own end

Revision ID: b9f3d5a7c2e4
Revises: c7a1e5d3b9f4
Create Date: 2026-10-06

docs/SPEC_KIOSK.md §15: the audit of kiosk commands takes the new action `schedule` (a
controlling till or the dashboard sets the kiosk's automatic opening) and the new source
`schedule` (a lock that lifted by itself at its time). The two check constraints are
replaced; idempotent.
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'b9f3d5a7c2e4'
down_revision: Union[str, Sequence[str], None] = 'c7a1e5d3b9f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ACTIONS = "('pause', 'resume', 'close_shift', 'till_z', 'schedule')"
SOURCES = "('dashboard', 'till', 'schedule')"


def upgrade() -> None:
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_action")
    op.execute(f"ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_action CHECK (action IN {ACTIONS})")
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_source")
    op.execute(f"ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_source CHECK (source IN {SOURCES})")


def downgrade() -> None:
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_action")
    op.execute("ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_action CHECK (action IN ('pause', 'resume', 'close_shift', 'till_z'))")
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_source")
    op.execute("ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_source CHECK (source IN ('dashboard', 'till'))")
