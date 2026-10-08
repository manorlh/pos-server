"""prepaid vouchers: "הצגת הפריטים על השובר" — a batch may print its vouchers without the goods

Revision ID: 6b1e9d4f2a87
Revises: 8c4a2f6e1b93
Create Date: 2026-10-08

The owner: "דינמי — תאפשר לא להציג אילו פריטים". `prepaid_voucher_batches.show_items`: print
the goods (a discount voucher: what it gives) on the voucher. Off: title, free text, validity,
barcode, code and serial only. Every existing batch: true — printed as before.

Idempotent: the column is added only when missing (a dev database may have it from a
previous run).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '6b1e9d4f2a87'
down_revision: Union[str, Sequence[str], None] = '8c4a2f6e1b93'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'prepaid_voucher_batches'
COLUMN = 'show_items'


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _has_column(bind) -> bool:
    return COLUMN in {c['name'] for c in sa.inspect(bind).get_columns(TABLE)}


def upgrade() -> None:
    # Offline (`--sql`) there is no database to look at: the plain statement.
    if _offline() or not _has_column(op.get_bind()):
        op.add_column(TABLE, sa.Column(COLUMN, sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    if _offline() or _has_column(op.get_bind()):
        op.drop_column(TABLE, COLUMN)
