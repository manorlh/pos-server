"""merge 14.10d release heads

Release 14.10d (release/2026-10-14b-server after #110) has three heads; each branch revises the release's
first merge bb6205ba290c on its own, so it can also be merged alone:

- 6af69aa646d1 — the 14.10c merge (exclusive login v2's wording 7c4e2a9d1b6f + kitchen ticket designs
  d8a3f1c6e2b7, both on bb6205ba290c)
- e7b2d9f4a6c3 — bill on another till: the drawer's "בתשלום מזומן — לשאול" and the job kind `drawer`,
  on c4d8e2f6a1b9 (the job kind `document`)
- d8b3f1a6c2e4 — table waiter assignment: `table_assignments`, `table_notices`,
  `dining_tables.lock_seen_at`, `pos_users.table_color` (add-only)

They touch different tables and rows: the bill-print pair changes `kitchen_print_jobs.kind`'s check and
the `cashDrawer` definition's options; the assignment adds two tables and two nullable columns; the
14.10c line, `exclusiveUserLogin*`'s wording, a `kitchen_ticket_designs` table and nullable columns on
`kitchen_printers`. Nothing of its own.

Revision ID: 4ff6c2ab6d7c
Revises: 6af69aa646d1, e7b2d9f4a6c3, d8b3f1a6c2e4
Create Date: 2026-10-14 20:50:58.880284

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4ff6c2ab6d7c'
down_revision: Union[str, Sequence[str], None] = ('6af69aa646d1', 'e7b2d9f4a6c3', 'd8b3f1a6c2e4')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
