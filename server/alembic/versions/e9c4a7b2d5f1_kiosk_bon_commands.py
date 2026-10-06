"""Kiosk commands: "הדפס עכשיו" / "סמן כטופל" for an unprinted bon

Revision ID: e9c4a7b2d5f1
Revises: d6e2a9c4b7f1
Create Date: 2026-10-06

docs/SPEC_KIOSK.md §16.8: a controlling till (or the dashboard) may ask a kiosk to print an
unprinted bon now (`bon_print`) or mark it handled (`bon_handled`); both are audited in
`kiosk_commands`. The action check constraint is replaced; idempotent.
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'e9c4a7b2d5f1'
down_revision: Union[str, Sequence[str], None] = 'd6e2a9c4b7f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ACTIONS = "('pause', 'resume', 'close_shift', 'till_z', 'schedule', 'bon_print', 'bon_handled')"


def upgrade() -> None:
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_action")
    op.execute(f"ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_action CHECK (action IN {ACTIONS})")


def downgrade() -> None:
    op.execute("DELETE FROM kiosk_commands WHERE action IN ('bon_print', 'bon_handled')")
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_action")
    op.execute(
        "ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_action "
        "CHECK (action IN ('pause', 'resume', 'close_shift', 'till_z', 'schedule'))"
    )
