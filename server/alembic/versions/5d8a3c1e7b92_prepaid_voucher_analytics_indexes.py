"""prepaid vouchers: indexes for the filters and reports ("לוח בקרה", "מימושים לפי קופה")

Revision ID: 5d8a3c1e7b92
Revises: 9e4b2d7c1a05
Create Date: 2026-10-08

The voucher views filter and aggregate by issue date, by voucher state per batch, and by
redemption time per batch / per till / per voucher. Indexes only — no column and no data
changes:

* `prepaid_voucher_batches (tenant_id, created_at)`;
* `prepaid_vouchers (batch_id, status)`;
* `prepaid_voucher_redemptions (batch_id, redeemed_at)`, `(machine_id, redeemed_at)`, `(voucher_id)`.

Idempotent: each index is created only when missing; offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '5d8a3c1e7b92'
down_revision: Union[str, Sequence[str], None] = '9e4b2d7c1a05'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEXES = (
    ('ix_prepaid_voucher_batches_tenant_created', 'prepaid_voucher_batches', ['tenant_id', 'created_at']),
    ('ix_prepaid_vouchers_batch_status', 'prepaid_vouchers', ['batch_id', 'status']),
    ('ix_prepaid_voucher_redemptions_batch_time', 'prepaid_voucher_redemptions', ['batch_id', 'redeemed_at']),
    ('ix_prepaid_voucher_redemptions_machine_time', 'prepaid_voucher_redemptions', ['machine_id', 'redeemed_at']),
    # (No index of its own on redemptions' voucher_id: the column's own index, ix_…_voucher_id, serves — review 09.10.)
)


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _existing(table: str) -> set:
    if _offline():
        return set()
    return {i['name'] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        # Never wait behind a long query on a busy table: fail fast, the deploy retries (review 09.10).
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    for name, table, columns in INDEXES:
        if name not in _existing(table):
            op.create_index(name, table, columns)


def downgrade() -> None:
    for name, table, _columns in reversed(INDEXES):
        if _offline() or name in _existing(table):
            op.drop_index(name, table_name=table)
