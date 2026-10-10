"""merge till roles / permissions and the cash drawer onto main

Revision ID: a6d2f8c4e0b7
Revises: 41b02fa61731, f7c3a9d1b5e8
Create Date: 2026-10-08 04:30:00.000000

"תפקידים והרשאות" (e5b1c3d7f9a2 → f7c3a9d1b5e8, branched from c7e2f4a9d1b6) joined to main's
head. Nothing to run: the two lines touch different tables.
"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "a6d2f8c4e0b7"
down_revision: Union[str, Sequence[str], None] = ("41b02fa61731", "f7c3a9d1b5e8")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
