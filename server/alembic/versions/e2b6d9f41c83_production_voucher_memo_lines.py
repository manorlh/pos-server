"""production vouchers on documents: a line's deduction share, ₪0 memo lines, memo documents

Revision ID: e2b6d9f41c83
Revises: c8e1f5a3b702
Create Date: 2026-10-09

The production vouchers contract §4.1 / §4.3, as the till sends them:

* `transaction_items.prepaid_deduction` (numeric) — a `discount`-mode deduction's share of the line,
  inside the document's discount;
* `transaction_items.voucher_memo_value` (agorot) and `voucher_redemption_id` — a `zero`-mode ₪0
  line's memo value and its redemption; such a line is no unit sold;
* `transactions.voucher_memo` (false for every existing row) — a document made only of memo lines,
  out of the Z's and the daily aggregates' document counts.

Idempotent (each column only when missing); offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e2b6d9f41c83'
down_revision: Union[str, Sequence[str], None] = 'c8e1f5a3b702'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ITEMS = 'transaction_items'
DOCUMENTS = 'transactions'
ITEM_COLUMNS = (
    ('prepaid_deduction', lambda: sa.Column('prepaid_deduction', sa.Numeric(12, 2), nullable=True)),
    ('voucher_memo_value', lambda: sa.Column('voucher_memo_value', sa.Integer(), nullable=True)),
    ('voucher_redemption_id', lambda: sa.Column('voucher_redemption_id', sa.String(100), nullable=True)),
)


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _columns(table: str) -> set:
    return set() if _offline() else {c['name'] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        # Never wait behind a long query on a busy table: fail fast, the deploy retries (review 09.10).
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    # `transactions` before `transaction_items` — the order every writer locks them in (review 09.10).
    if 'voucher_memo' not in _columns(DOCUMENTS):
        op.add_column(DOCUMENTS, sa.Column('voucher_memo', sa.Boolean(), nullable=False, server_default=sa.false()))
    have = _columns(ITEMS)
    for name, column in ITEM_COLUMNS:
        if name not in have:
            op.add_column(ITEMS, column())


def downgrade() -> None:
    if _offline() or 'voucher_memo' in _columns(DOCUMENTS):
        op.drop_column(DOCUMENTS, 'voucher_memo')
    have = {n for n, _c in ITEM_COLUMNS} if _offline() else _columns(ITEMS)
    for name, _column in reversed(ITEM_COLUMNS):
        if name in have:
            op.drop_column(ITEMS, name)
