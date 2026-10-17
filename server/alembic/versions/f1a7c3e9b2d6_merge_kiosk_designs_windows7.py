"""merge kiosk saved designs + windows 7 release platform

Two heads on main's line (17.10):

- c6e2a9f4d8b1 — "עיצובים שמורים לקיוסק": kiosk_designs, kiosk_design_audit, kiosk_settings.design_id/design_off
  (on d9e4b1f7a3c6, the foreign records guard)
- b7e3a9d1c5f2 — the windows7 app release platform (on a1d5e8c3b7f2)

Different tables; nothing of its own.

Revision ID: f1a7c3e9b2d6
Revises: c6e2a9f4d8b1, b7e3a9d1c5f2
Create Date: 2026-10-17 16:00:00

"""
from typing import Sequence, Union


revision: str = "f1a7c3e9b2d6"
down_revision: Union[str, Sequence[str], None] = ("c6e2a9f4d8b1", "b7e3a9d1c5f2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
