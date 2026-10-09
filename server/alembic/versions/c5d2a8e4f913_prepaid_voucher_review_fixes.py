"""prepaid vouchers: the review's indexes — offline ids per device, one live assignment per batch

Revision ID: c5d2a8e4f913
Revises: a7d4e9c2b158
Create Date: 2026-10-09

* `prepaid_voucher_redemptions`: the device's own redemption id is unique per **device**
  (`tenant_id, machine_id, client_redemption_id`), not per tenant — two devices may well use the
  same id; the old `ux_prepaid_voucher_redemptions_client` is replaced.
* `prepaid_voucher_offline_assignments`: at most one live assignment per batch — a partial unique
  index on `batch_id` where `status IN ('active', 'releasing')` (the release is two-step now).
* Data: a discount-kind batch (and its type) printed before types was filed `redemption_accounting`
  `zero`; a discount is always booked as a discount — `discount`.

Idempotent (each index only when missing / still there); offline (`--sql`) the plain statements.
`lock_timeout` keeps a busy table from holding the deploy (Postgres).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c5d2a8e4f913'
down_revision: Union[str, Sequence[str], None] = 'a7d4e9c2b158'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REDEMPTIONS = 'prepaid_voucher_redemptions'
ASSIGNMENTS = 'prepaid_voucher_offline_assignments'
OLD_CLIENT = 'ux_prepaid_voucher_redemptions_client'
NEW_CLIENT = 'ux_prepaid_voucher_redemptions_device_client'
LIVE = 'ux_prepaid_voucher_offline_assignments_live'
LIVE_WHERE = "status IN ('active', 'releasing')"


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _indexes(table: str) -> set:
    return set() if _offline() else {i['name'] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    have = _indexes(REDEMPTIONS)
    if NEW_CLIENT not in have:
        op.create_index(NEW_CLIENT, REDEMPTIONS, ['tenant_id', 'machine_id', 'client_redemption_id'], unique=True)
    if _offline() or OLD_CLIENT in have:
        op.drop_index(OLD_CLIENT, table_name=REDEMPTIONS)
    if LIVE not in _indexes(ASSIGNMENTS):
        op.create_index(LIVE, ASSIGNMENTS, ['batch_id'], unique=True,
                        postgresql_where=sa.text(LIVE_WHERE), sqlite_where=sa.text(LIVE_WHERE))
    for table in ('prepaid_voucher_batches', 'prepaid_voucher_types'):
        op.execute(sa.text(
            f"UPDATE {table} SET redemption_accounting = 'discount' "
            "WHERE kind <> 'items' AND redemption_accounting <> 'discount'"
        ))


def downgrade() -> None:
    if _offline() or LIVE in _indexes(ASSIGNMENTS):
        op.drop_index(LIVE, table_name=ASSIGNMENTS)
    have = _indexes(REDEMPTIONS)
    if _offline() or OLD_CLIENT not in have:
        op.create_index(OLD_CLIENT, REDEMPTIONS, ['tenant_id', 'client_redemption_id'], unique=True)
    if _offline() or NEW_CLIENT in have:
        op.drop_index(NEW_CLIENT, table_name=REDEMPTIONS)
