"""merge area gaps + pairing terminal options

Two heads built on b87054615214 (17.10b), each add-only on `pairing_codes`:

- f4b2d8a6c1e3 — "נקודת מכירה" at device setup: `pairing_codes.area_id` (P:/specs/area-gaps.md §1)
- c7d2f9a4e1b8 — "סוג מסופון" chosen with the code: the pairing code's terminal options

Different columns; nothing of its own.

Revision ID: a1d5e8c3b7f2
Revises: f4b2d8a6c1e3, c7d2f9a4e1b8
Create Date: 2026-10-17 12:00:00

"""
from typing import Sequence, Union


revision: str = "a1d5e8c3b7f2"
down_revision: Union[str, Sequence[str], None] = ("f4b2d8a6c1e3", "c7d2f9a4e1b8")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
