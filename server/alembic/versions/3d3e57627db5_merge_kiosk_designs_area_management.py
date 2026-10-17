"""merge kiosk saved designs + main's area management merge

Two heads on main's line (17.10):

- c6e2a9f4d8b1 — "עיצובים שמורים לקיוסק": kiosk_designs, kiosk_design_audit, kiosk_settings.design_id/design_off
  (on d9e4b1f7a3c6)
- f1a7c3e9b2d6 — main's merge of area management (kiosk_settings.area_id …) with windows7 / unpair

Different columns; nothing of its own.

Revision ID: 3d3e57627db5
Revises: c6e2a9f4d8b1, f1a7c3e9b2d6
Create Date: 2026-10-17 18:00:00

"""
from typing import Sequence, Union


revision: str = "3d3e57627db5"
down_revision: Union[str, Sequence[str], None] = ("c6e2a9f4d8b1", "f1a7c3e9b2d6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
