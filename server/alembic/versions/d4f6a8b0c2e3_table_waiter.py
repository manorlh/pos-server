"""table waiter

The waiter a table is theirs ("מלצר"): its opener unless handed to another; the waiters'
reports go by it.

Revision ID: d4f6a8b0c2e3
Revises: c3e5f7a9b1d4
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd4f6a8b0c2e3'
down_revision: Union[str, Sequence[str], None] = 'c3e5f7a9b1d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('table_orders', sa.Column('waiter_pos_user_id', sa.String(100), nullable=True))
    op.add_column('table_orders', sa.Column('waiter_pos_user_name', sa.String(200), nullable=True))


def downgrade() -> None:
    op.drop_column('table_orders', 'waiter_pos_user_name')
    op.drop_column('table_orders', 'waiter_pos_user_id')
