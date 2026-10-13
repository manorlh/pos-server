"""merge release 2026-10-13 heads

The release of 13.10.2026 (release/2026-10-13-server) joins every head its PRs left on
c7e4a2f9d1b6, each revising it on its own so each PR can also be merged alone:

- d1a5c3e7f902 — prepaid voucher manual redemption (#58, in #59)
- d3f8a6c2b9e1 — demo company items (#66)
- e4a7c2d9b1f3 — dedicated local server, on 3bfb94dbebb2 table_orders.cloud_updated_at (#73 / #74)
- e5a1c9d3b7f2 — shop active log (#63, in #70)
- f3b8d1e6a2c9 — report export defaults (#79)

Nothing of its own.

Revision ID: 78c88a7afc4f
Revises: d1a5c3e7f902, d3f8a6c2b9e1, e4a7c2d9b1f3, e5a1c9d3b7f2, f3b8d1e6a2c9
Create Date: 2026-10-13 17:38:14.843644

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '78c88a7afc4f'
down_revision: Union[str, Sequence[str], None] = ('d1a5c3e7f902', 'd3f8a6c2b9e1', 'e4a7c2d9b1f3', 'e5a1c9d3b7f2', 'f3b8d1e6a2c9')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
