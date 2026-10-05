"""customer licenses

A permanent or temporary customer ("לקוח קבוע / זמני", a one-off event) on an organization,
a company and a shop; a temporary one stops selling after its license date.

Revision ID: a1c3e5f7b9d2
Revises: 092599eeedbb
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a1c3e5f7b9d2'
down_revision: Union[str, Sequence[str], None] = '092599eeedbb'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("tenants", "companies", "shops")


def upgrade() -> None:
    for table in TABLES:
        op.add_column(table, sa.Column('license_type', sa.String(16), nullable=False, server_default='permanent'))
        op.add_column(table, sa.Column('license_expires_on', sa.Date(), nullable=True))


def downgrade() -> None:
    for table in TABLES:
        op.drop_column(table, 'license_expires_on')
        op.drop_column(table, 'license_type')
