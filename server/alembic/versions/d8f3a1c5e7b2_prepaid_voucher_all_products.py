"""prepaid vouchers: every product type — a weight on a goods voucher, "כולל תוספות"

"שוברי הפקה" (docs/SPEC_VOUCHER_PRODUCTION.md §7.14, the owner 07.10.2026: "תוודא ששוברי
הפקה תומכים בכל סוגי המוצרים בקטלוג"):

* `prepaid_voucher_batch_items.quantity` — Integer → Numeric(10, 3): a product sold by weight
  goes on a goods voucher by weight ("0.5 ק״ג"). Every existing row is a whole number and
  stays one. `weighed` / `unit_label` — whether it was sold by weight when the batch was
  made, and its unit as printed.
* `prepaid_voucher_batches.include_extras` — "כולל תוספות": a goods voucher covers a dish's
  paid options and a meal's upcharges too. Every existing batch: false (its base price, as
  the tills already did).

`prepaid_vouchers.remaining` and the redemptions' JSON simply carry a decimal where a weight is.

Idempotent: a dev database may already have a column from a previous run, or the type.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = 'd8f3a1c5e7b2'
down_revision: Union[str, Sequence[str], None] = 'c7e2f4a9d1b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BATCHES = 'prepaid_voucher_batches'
ITEMS = 'prepaid_voucher_batch_items'


def _columns(inspector, table: str) -> dict:
    return {c['name']: c for c in inspector.get_columns(table)}


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError('this migration inspects the database; run it online')
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    batches = _columns(inspector, BATCHES)
    if 'include_extras' not in batches:
        op.add_column(BATCHES, sa.Column('include_extras', sa.Boolean(), nullable=False, server_default=sa.false()))

    items = _columns(inspector, ITEMS)
    quantity = items.get('quantity')
    if quantity is not None and not isinstance(quantity['type'], sa.Numeric):
        op.alter_column(
            ITEMS, 'quantity',
            existing_type=sa.Integer(),
            type_=sa.Numeric(10, 3),
            existing_nullable=False,
            postgresql_using='quantity::numeric(10,3)',
        )
    if 'weighed' not in items:
        op.add_column(ITEMS, sa.Column('weighed', sa.Boolean(), nullable=False, server_default=sa.false()))
    if 'unit_label' not in items:
        op.add_column(ITEMS, sa.Column('unit_label', sa.String(16), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    items = _columns(inspector, ITEMS)
    if 'unit_label' in items:
        op.drop_column(ITEMS, 'unit_label')
    if 'weighed' in items:
        op.drop_column(ITEMS, 'weighed')
    quantity = items.get('quantity')
    if quantity is not None and isinstance(quantity['type'], sa.Numeric):
        # A weight does not survive the way back: rounded up to a whole unit (never below 1).
        op.alter_column(
            ITEMS, 'quantity',
            existing_type=sa.Numeric(10, 3),
            type_=sa.Integer(),
            existing_nullable=False,
            postgresql_using='GREATEST(1, CEIL(quantity))::integer',
        )
    if 'include_extras' in _columns(inspector, BATCHES):
        op.drop_column(BATCHES, 'include_extras')
