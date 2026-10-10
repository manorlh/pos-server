"""merge screens and lan heads

Joins the two heads that both revise e7d1b4a9c3f6: c4f8a2d6e9b1 (kds_devices.scope, screen
designs) and c3e9f1a7b5d2 (LAN mode: lan_server_excluded, lan_sync, shops.local_network).
Nothing of its own.

Revision ID: 73297f153172
Revises: c4f8a2d6e9b1, c3e9f1a7b5d2
Create Date: 2026-10-07 19:31:14.559078

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '73297f153172'
down_revision: Union[str, Sequence[str], None] = ('c4f8a2d6e9b1', 'c3e9f1a7b5d2')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
