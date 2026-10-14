"""merge 14.10b release heads

The release of 14.10.2026 b (release/2026-10-14b-server) has three heads: its PRs build on
ba584f6fb704 (the single head of release 14.10, PR #94) on their own, so each can also be merged alone:

- e3b9d7a41c62 — the dashboard section `tables_layout` for whoever edited the map (#105, data only),
  on b637e9784d58 — courses FIRE v2 (#96): menu_courses.auto_fire_minutes, products / categories
  send_silently
- 5d1f8b3e7a92 — the "הכל" tab hidden by default (#97): the `sellAllTab` built-in default moves to
  hidden (data only)
- e4b7c2d9a6f1 — customer_display_media + customer_display_media_presence (#104, add-only)

None of them touches another's tables or rows. Nothing of its own.

Revision ID: bb6205ba290c
Revises: e3b9d7a41c62, 5d1f8b3e7a92, e4b7c2d9a6f1
Create Date: 2026-10-14 11:44:48.606983

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'bb6205ba290c'
down_revision: Union[str, Sequence[str], None] = ('e3b9d7a41c62', '5d1f8b3e7a92', 'e4b7c2d9a6f1')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
