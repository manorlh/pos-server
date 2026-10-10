"""merge usb printers and device work config heads

Revision ID: d0a055f82a1a
Revises: e9a3c7f1b5d2, e5b9d3f7a1c4
Create Date: 2026-10-08 00:02:31.593775

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd0a055f82a1a'
down_revision: Union[str, Sequence[str], None] = ('e9a3c7f1b5d2', 'e5b9d3f7a1c4')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
