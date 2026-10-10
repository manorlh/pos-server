"""merge kiosk service once head

Revision ID: a1f0b62029f1
Revises: 1dbac9d07adb, 9d4b2e7a1c63
Create Date: 2026-10-08 01:41:04.244082

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1f0b62029f1'
down_revision: Union[str, Sequence[str], None] = ('1dbac9d07adb', '9d4b2e7a1c63')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
