"""merge 14.10 release heads

The release of 14.10.2026 (release/2026-10-14-server) joins the two heads its PRs left on
78c88a7afc4f (the merge of the 13.10 release), each revising it on its own so each PR can also be
merged alone:

- 8d4f2a6c1e93 — phone-alert types of push-more, on 3c9e5a7b1d24 the manager-problems types
  (data only; feat/alert-policy, #89)
- a7c3e9f1d2b4 — remote manager approvals (feat/remote-approvals, #90)

Nothing of its own.

Revision ID: 9f55dd368692
Revises: 8d4f2a6c1e93, a7c3e9f1d2b4
Create Date: 2026-10-14 00:06:55.181246

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9f55dd368692'
down_revision: Union[str, Sequence[str], None] = ('8d4f2a6c1e93', 'a7c3e9f1d2b4')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
