"""receipt printers

A shop's printers are kitchen printers ("מדפסות בונים") or receipt printers ("מדפסות
חשבוניות"): `purpose`. A receipt printer may have a cash drawer on its port
(`cash_drawer`), and may hang on one till's USB (`connection_type` 'usb').

Revision ID: a7c9e1f3b5d6
Revises: f6b8d0e2a4c5
Create Date: 2026-10-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a7c9e1f3b5d6'
down_revision: Union[str, Sequence[str], None] = 'f6b8d0e2a4c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    columns = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('kitchen_printers')}
    if 'purpose' not in columns:
        op.add_column(
            'kitchen_printers',
            sa.Column('purpose', sa.String(8), nullable=False, server_default='kitchen'),
        )
    if 'cash_drawer' not in columns:
        op.add_column(
            'kitchen_printers',
            sa.Column('cash_drawer', sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    op.execute("ALTER TABLE kitchen_printers DROP CONSTRAINT IF EXISTS ck_kitchen_printers_connection_type")
    op.create_check_constraint(
        'ck_kitchen_printers_connection_type',
        'kitchen_printers',
        "connection_type IN ('network', 'bluetooth', 'cloud', 'till', 'usb')",
    )
    op.execute("ALTER TABLE kitchen_printers DROP CONSTRAINT IF EXISTS ck_kitchen_printers_purpose")
    op.create_check_constraint(
        'ck_kitchen_printers_purpose', 'kitchen_printers', "purpose IN ('kitchen', 'receipt')",
    )


def downgrade() -> None:
    op.execute("DELETE FROM kitchen_printers WHERE connection_type = 'usb'")
    op.drop_constraint('ck_kitchen_printers_purpose', 'kitchen_printers', type_='check')
    op.drop_constraint('ck_kitchen_printers_connection_type', 'kitchen_printers', type_='check')
    op.create_check_constraint(
        'ck_kitchen_printers_connection_type',
        'kitchen_printers',
        "connection_type IN ('network', 'bluetooth', 'cloud', 'till')",
    )
    op.drop_column('kitchen_printers', 'cash_drawer')
    op.drop_column('kitchen_printers', 'purpose')
