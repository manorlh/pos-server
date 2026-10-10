"""merge voucher all products head

Revision ID: 41b02fa61731
Revises: e4b7d1a9c3f6, d8f3a1c5e7b2
Create Date: 2026-10-08 03:14:16.465632

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '41b02fa61731'
down_revision: Union[str, Sequence[str], None] = ('e4b7d1a9c3f6', 'd8f3a1c5e7b2')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
