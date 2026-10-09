"""Kiosk commands: "menu" ("עריכת תפריט הקיוסק")

Revision ID: f8a2c6e4b1d3
Revises: d6f1b3a9c7e5
Create Date: 2026-10-06

docs/SPEC_KIOSK.md §22: the kiosk admin's menu save is audited in `kiosk_commands` with the
new action `menu`. The check constraint is replaced; idempotent.
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'f8a2c6e4b1d3'
down_revision: Union[str, Sequence[str], None] = 'd6f1b3a9c7e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ACTIONS = "('pause', 'resume', 'close_shift', 'till_z', 'schedule', 'bon_print', 'bon_handled', 'menu')"
PREVIOUS = "('pause', 'resume', 'close_shift', 'till_z', 'schedule', 'bon_print', 'bon_handled')"


def upgrade() -> None:
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_action")
    op.execute(f"ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_action CHECK (action IN {ACTIONS})")


def downgrade() -> None:
    # Never run in production (additive only); kept so the chain stays walkable.
    op.execute("DELETE FROM kiosk_commands WHERE action = 'menu'")
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_action")
    op.execute(f"ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_action CHECK (action IN {PREVIOUS})")
