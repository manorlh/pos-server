"""prepaid vouchers: "מספר שוברים מקסימלי בעסקה" — the most vouchers one sale takes

Revision ID: 9e4b2d7c1a05
Revises: 2c7e9a4f1d38
Create Date: 2026-10-08

The owner's stacking setting for every kind: "שובר אחד בעסקה" (`stacking = single`) or "כמה
שוברים בעסקה" (`unlimited`; advanced: `distinct_batches`, "רק מסוגים שונים"), and with "many" an
optional maximum. One nullable column on `prepaid_voucher_types` and on
`prepaid_voucher_batches`: `max_vouchers_per_sale` — null (every existing row) is no maximum, so
nothing changes for a batch already issued. A new type's default ("many", no maximum) is the
form's and the API's; the columns' defaults are untouched.

Idempotent: each column is added only when missing; offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '9e4b2d7c1a05'
down_revision: Union[str, Sequence[str], None] = '2c7e9a4f1d38'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ('prepaid_voucher_types', 'prepaid_voucher_batches')
COLUMN = 'max_vouchers_per_sale'


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _has(table: str) -> bool:
    if _offline():
        return False
    return COLUMN in {c['name'] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        # Never wait behind a long query on a busy table: fail fast, the deploy retries (review 09.10).
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    for table in TABLES:
        if not _has(table):
            op.add_column(table, sa.Column(COLUMN, sa.Integer(), nullable=True))


def downgrade() -> None:
    for table in reversed(TABLES):
        if _offline() or _has(table):
            op.drop_column(table, COLUMN)
