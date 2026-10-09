"""products: "הודעות לעובד" and "פריטים נלווים"; transaction_items.alerts_ack

Revision ID: b5e7d9f1a3c6
Revises: a7c9e1b3d5f6
Create Date: 2026-10-06

app/services/product_alerts.py. Per product: the alerts the till shows the employee on
adding it (`alerts`), the allergen alert built from its allergens (`allergen_alert`,
`allergen_alert_require_ack`) and the products added with it (`companions`). On the sold
line: who confirmed the alerts, and when (`alerts_ack`). Every existing product gets no
alerts, no allergen alert and no companions — today's behaviour.

Additive and idempotent: each column is added only when it is missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b5e7d9f1a3c6'
down_revision: Union[str, Sequence[str], None] = 'a7c9e1b3d5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns():
    return {
        'products': [
            sa.Column('alerts', sa.JSON(), nullable=True),
            sa.Column('allergen_alert', sa.Boolean(), nullable=False, server_default='false'),
            sa.Column('allergen_alert_require_ack', sa.Boolean(), nullable=False, server_default='true'),
            sa.Column('companions', sa.JSON(), nullable=True),
        ],
        'transaction_items': [
            sa.Column('alerts_ack', sa.JSON(), nullable=True),
        ],
    }


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, columns in _columns().items():
        existing = {c['name'] for c in inspector.get_columns(table)}
        for column in columns:
            if column.name not in existing:
                op.add_column(table, column)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, columns in _columns().items():
        existing = {c['name'] for c in inspector.get_columns(table)}
        for column in reversed(columns):
            if column.name in existing:
                op.drop_column(table, column.name)
