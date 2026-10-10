"""Kiosk commands: "enter_till", "return_kiosk", "reprint_bon", "reprint_receipt"

Revision ID: a6c2e8f4b0d7
Revises: b8e2d4f6a1c3
Create Date: 2026-10-09

P:/specs/kiosk-landscape-till-mode.md §5 (P:/specs/web-till-spec-v2.md §6.6): the dashboard's
"מצב עבודה: קיוסק / קופה" switch is the kiosk commands `enter_till` / `return_kiosk`, both ways; a
controlling till's "הדפס שוב את הבון האחרון" / "הדפס עסקה אחרונה" are `reprint_bon` /
`reprint_receipt`. Add-only: the check constraint gains the four values; idempotent.
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'a6c2e8f4b0d7'
down_revision: Union[str, Sequence[str], None] = 'b8e2d4f6a1c3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ACTIONS = (
    "('pause', 'resume', 'close_shift', 'till_z', 'schedule', 'bon_print', 'bon_handled', 'menu', "
    "'enter_till', 'return_kiosk', 'reprint_bon', 'reprint_receipt')"
)
PREVIOUS = "('pause', 'resume', 'close_shift', 'till_z', 'schedule', 'bon_print', 'bon_handled', 'menu')"


def upgrade() -> None:
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_action")
    op.execute(f"ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_action CHECK (action IN {ACTIONS})")


def downgrade() -> None:
    # Never run in production (additive only); kept so the chain stays walkable.
    op.execute("DELETE FROM kiosk_commands WHERE action IN ('enter_till', 'return_kiosk', 'reprint_bon', 'reprint_receipt')")
    op.execute("ALTER TABLE kiosk_commands DROP CONSTRAINT IF EXISTS ck_kiosk_commands_action")
    op.execute(f"ALTER TABLE kiosk_commands ADD CONSTRAINT ck_kiosk_commands_action CHECK (action IN {PREVIOUS})")
