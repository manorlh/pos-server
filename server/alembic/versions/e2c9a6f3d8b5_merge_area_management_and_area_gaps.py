"""merge area management and area gaps

Two heads, each mergeable alone:

- d5e8b2c4a7f1 — area management (P:/specs/chain-areas.md) joined with the device terminal type (c7d2f9a4e1b8)
- a1d5e8c3b7f2 — area gaps (`pairing_codes.area_id`, f4b2d8a6c1e3) joined with the device terminal type

They touch different tables. Nothing of its own.

Revision ID: e2c9a6f3d8b5
Revises: d5e8b2c4a7f1, a1d5e8c3b7f2
Create Date: 2026-10-17 23:55:00

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "e2c9a6f3d8b5"
down_revision: Union[str, Sequence[str], None] = ("d5e8b2c4a7f1", "a1d5e8c3b7f2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
