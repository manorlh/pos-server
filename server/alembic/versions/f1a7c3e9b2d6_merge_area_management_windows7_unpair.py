"""merge area management, Windows 7 releases and unpair / cloud pairing

Main carries two heads on a1d5e8c3b7f2 (area gaps): b7e3a9d1c5f2 (app releases for Windows 7) and d9e4b1f7a3c6
(unpair and cloud pairing). Area management's e2c9a6f3d8b5 sits on a1d5e8c3b7f2 too. This joins the three into
one head. They touch different tables. Nothing of its own.

Revision ID: f1a7c3e9b2d6
Revises: e2c9a6f3d8b5, b7e3a9d1c5f2, d9e4b1f7a3c6
Create Date: 2026-10-18 01:30:00

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "f1a7c3e9b2d6"
down_revision: Union[str, Sequence[str], None] = ("e2c9a6f3d8b5", "b7e3a9d1c5f2", "d9e4b1f7a3c6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
