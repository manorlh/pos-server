"""merge exception alerts head

Revision ID: ad1d167dd5b9
Revises: d0a055f82a1a, f3a9c2e7b5d1
Create Date: 2026-10-08 00:49:16.137531

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ad1d167dd5b9'
down_revision: Union[str, Sequence[str], None] = ('d0a055f82a1a', 'f3a9c2e7b5d1')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
