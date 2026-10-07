"""merge cloud zcredit refund head

Revision ID: 1dbac9d07adb
Revises: ad1d167dd5b9, c4e8a2f6b1d3
Create Date: 2026-10-08 01:08:34.645735

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1dbac9d07adb'
down_revision: Union[str, Sequence[str], None] = ('ad1d167dd5b9', 'c4e8a2f6b1d3')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
