"""merge till design head

Revision ID: b4a16fe43e9d
Revises: 73297f153172, d4e8b2f6a1c9
Create Date: 2026-10-07 20:05:14.332763

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b4a16fe43e9d'
down_revision: Union[str, Sequence[str], None] = ('73297f153172', 'd4e8b2f6a1c9')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
