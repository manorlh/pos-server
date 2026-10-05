"""table cleaning: dining_tables.cleaning_since ("לניקוי")

Revision ID: d6f8a0b2c4e6
Revises: c5e7a9b1d3f5
Create Date: 2026-10-05

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd6f8a0b2c4e6'
down_revision: Union[str, Sequence[str], None] = 'c5e7a9b1d3f5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('dining_tables', sa.Column('cleaning_since', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('dining_tables', 'cleaning_since')
