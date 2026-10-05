"""machine license

"לקוח קבוע / זמני" on a single till as well — a till lent to an event out of a permanent
shop stops selling after its own date (app/services/licenses.py).

Revision ID: b2d4f6a8c0e1
Revises: a1c3e5f7b9d2
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b2d4f6a8c0e1'
down_revision: Union[str, Sequence[str], None] = 'a1c3e5f7b9d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('pos_machines', sa.Column('license_type', sa.String(16), nullable=False, server_default='permanent'))
    op.add_column('pos_machines', sa.Column('license_expires_on', sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column('pos_machines', 'license_expires_on')
    op.drop_column('pos_machines', 'license_type')
