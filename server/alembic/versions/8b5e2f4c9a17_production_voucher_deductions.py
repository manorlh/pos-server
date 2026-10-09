"""production vouchers: a document's deduction ("קיזוז שוברי הפקה") names its redemption, type and units

Revision ID: 8b5e2f4c9a17
Revises: 5d8a3c1e7b92
Create Date: 2026-10-09

A production voucher booked as a document deduction (`redemption_accounting` discount, the
production vouchers contract §4.1) arrives in the document's `voucherDiscounts[]` with
`kind: "production_voucher"`. On `transaction_voucher_discounts`:

* `kind` widens from 16 to 32 characters — `production_voucher` is 18 and was cut;
* `redemption_id` (uuid), `type_name` (200) and `units` (JSON: the covered units' names, group
  names and quantities, as the receipt lists them) are added, all nullable.

No data changes: every existing row is a discount voucher's. Idempotent (each step only when
needed); offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '8b5e2f4c9a17'
down_revision: Union[str, Sequence[str], None] = '5d8a3c1e7b92'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'transaction_voucher_discounts'
COLUMNS = (
    ('redemption_id', lambda: postgresql.UUID(as_uuid=True)),
    ('type_name', lambda: sa.String(200)),
    ('units', lambda: sa.JSON()),
)


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _columns() -> dict:
    if _offline():
        return {}
    return {c['name']: c for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        # Never wait behind a long query on a busy table: fail fast, the deploy retries (review 09.10).
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    cols = _columns()
    kind = cols.get('kind')
    length = getattr(kind['type'], 'length', None) if kind else None
    if _offline() or (length is not None and length < 32):
        if _offline() or op.get_bind().dialect.name != 'sqlite':  # SQLite does not size VARCHAR
            op.alter_column(TABLE, 'kind', existing_type=sa.String(16), type_=sa.String(32), existing_nullable=True)
    for name, type_ in COLUMNS:
        if name not in cols:
            op.add_column(TABLE, sa.Column(name, type_(), nullable=True))


def downgrade() -> None:
    cols = set(_columns()) if not _offline() else {n for n, _t in COLUMNS}
    for name, _type in reversed(COLUMNS):
        if name in cols:
            op.drop_column(TABLE, name)
    # `kind` stays 32 wide: narrowing it would cut (or refuse) the `production_voucher` rows stored.
