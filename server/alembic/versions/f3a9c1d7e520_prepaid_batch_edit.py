"""prepaid vouchers: "ערוך סדרה" — the production price by serial once it was changed

Revision ID: f3a9c1d7e520
Revises: e2b6d9f41c83
Create Date: 2026-10-09

`prepaid_voucher_batches.production_price_history` (JSON, null): `[{fromSerial, priceAgorot, at,
by}]` — a changed production price applies to the vouchers issued from then on; the first entry
is the price the batch was issued at. Null for every existing batch (never changed).

Idempotent (the column only when missing); offline (`--sql`) the plain statement.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'f3a9c1d7e520'
down_revision: Union[str, Sequence[str], None] = 'e2b6d9f41c83'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BATCHES = 'prepaid_voucher_batches'
COLUMN = 'production_price_history'


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _columns(table: str) -> set:
    return set() if _offline() else {c['name'] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        # Never wait behind a long query on a busy table: fail fast, the deploy retries (review 09.10).
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    if COLUMN not in _columns(BATCHES):
        op.add_column(BATCHES, sa.Column(COLUMN, sa.JSON(), nullable=True))


def downgrade() -> None:
    if _offline() or COLUMN in _columns(BATCHES):
        op.drop_column(BATCHES, COLUMN)
