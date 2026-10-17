"""merge area management with main (Windows 7 releases + unpair / cloud pairing)

Area management's e2c9a6f3d8b5 and main's e8c1f4a7b2d9 (which joins b7e3a9d1c5f2 Windows 7 releases and
d9e4b1f7a3c6 unpair / cloud pairing, both on a1d5e8c3b7f2 area gaps). They touch different tables. Nothing of
its own.

Revision ID: f1a7c3e9b2d6
Revises: e2c9a6f3d8b5, e8c1f4a7b2d9
Create Date: 2026-10-18 01:30:00

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "f1a7c3e9b2d6"
down_revision: Union[str, Sequence[str], None] = ("e2c9a6f3d8b5", "e8c1f4a7b2d9")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
