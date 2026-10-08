"""prepaid vouchers: what the paper shows — the goods ("הצגת הפריטים על השובר") and the credit line

Revision ID: 6b1e9d4f2a87
Revises: 8c4a2f6e1b93
Create Date: 2026-10-08

Two per-batch print switches on `prepaid_voucher_batches`, both true for every existing batch
(printed as before / with the new credit line):

* `show_items` — the owner: "דינמי — תאפשר לא להציג אילו פריטים". Print the goods (a discount
  voucher: what it gives). Off: title, free text, validity, barcode, code and serial only.
* `show_credit` — "נוצר על ידי Runner Systems" in small print at the bottom of the voucher.

Idempotent: each column is added only when missing (a dev database may have it from a
previous run); offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '6b1e9d4f2a87'
down_revision: Union[str, Sequence[str], None] = '8c4a2f6e1b93'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'prepaid_voucher_batches'
COLUMNS = ('show_items', 'show_credit')


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _existing() -> set:
    if _offline():
        return set()
    return {c['name'] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    existing = _existing()
    for name in COLUMNS:
        if name not in existing:
            op.add_column(TABLE, sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    existing = set(COLUMNS) if _offline() else _existing()
    for name in reversed(COLUMNS):
        if name in existing:
            op.drop_column(TABLE, name)
