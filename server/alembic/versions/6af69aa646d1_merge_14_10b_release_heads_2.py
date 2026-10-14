"""merge 14.10b release heads 2

Release 14.10b (release/2026-10-14b-server) again has two heads, each on its first merge revision
bb6205ba290c, so each branch can also be merged alone:

- 7c4e2a9d1b6f — exclusive login v2: the wording of the built-in release permission and parameters
  (data only)
- d8a3f1c6e2b7 — kitchen ticket designs: `kitchen_ticket_designs` and the kitchen printers' ticket
  design columns (add-only)

The two touch different tables and rows. Nothing of its own.

Revision ID: 6af69aa646d1
Revises: 7c4e2a9d1b6f, d8a3f1c6e2b7
Create Date: 2026-10-14 19:57:42.757308

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6af69aa646d1'
down_revision: Union[str, Sequence[str], None] = ('7c4e2a9d1b6f', 'd8a3f1c6e2b7')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
