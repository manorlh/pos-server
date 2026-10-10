"""OTH ("על חשבון הבית") lines and the club discount ("הנחת מועדון") on documents

Revision ID: c3e5a7b9d1f2
Revises: 7b3d9e1f5a2c
Create Date: 2026-10-05

* `transaction_items.oth_reason` / `oth_by` / `oth_approved_by` — a line given "on the
  house" at the till (till parameter `othEnabled`): a 100% line discount marked OTH, with
  the reason chosen, the till user who gave it and who approved it. Null: an ordinary line.
* `transactions.basket_discount` / `basket_discount_percent` / `basket_discount_kind` —
  the basket discount on its own (it is inside `document_discount` with the line
  discounts and the promotions), the rate it was given at, and what it was: `club` for the
  club button (till parameter `clubButtonEnabled`), `manual` for the cashier's own.

Idempotent: the auto-reloading API may have created a column already (`create_all` does
not add columns, but a re-run must not fail) — each column is added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c3e5a7b9d1f2'
down_revision: Union[str, Sequence[str], None] = '7b3d9e1f5a2c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = {
    'transaction_items': (
        ('oth_reason', sa.String(100)),
        ('oth_by', sa.String(100)),
        ('oth_approved_by', sa.String(100)),
    ),
    'transactions': (
        ('basket_discount', sa.Numeric(12, 2)),
        ('basket_discount_percent', sa.Numeric(6, 2)),
        ('basket_discount_kind', sa.String(16)),
    ),
}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, columns in COLUMNS.items():
        have = {c['name'] for c in inspector.get_columns(table)}
        for name, kind in columns:
            if name not in have:
                op.add_column(table, sa.Column(name, kind, nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, columns in COLUMNS.items():
        have = {c['name'] for c in inspector.get_columns(table)}
        for name, _ in columns:
            if name in have:
                op.drop_column(table, name)
