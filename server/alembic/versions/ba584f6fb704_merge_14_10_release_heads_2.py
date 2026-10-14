"""merge 14.10 release heads 2

The release of 14.10.2026 (release/2026-10-14-server) again has two heads once
feat/table-restore-payments (#93) brought its migration, which revises 78c88a7afc4f on its own
so the PR can also be merged alone:

- 396f22daf19c — the push-detectors' phone-alert types for users who chose every type, on
  9f55dd368692 (the release's first merge: alert-policy 8d4f2a6c1e93 + remote approvals a7c3e9f1d2b4)
- a7d3e1c9b5f2 — dining_tables.label_only, a restored table shown as "ש-12" (#93)

Nothing of its own.

Revision ID: ba584f6fb704
Revises: 396f22daf19c, a7d3e1c9b5f2
Create Date: 2026-10-14 03:41:39.532976

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ba584f6fb704'
down_revision: Union[str, Sequence[str], None] = ('396f22daf19c', 'a7d3e1c9b5f2')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
