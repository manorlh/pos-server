"""prepaid vouchers: production in groups, the code under the barcode, barcode type, customer / order, audit

"שוברי הפקה" (docs/SPEC_VOUCHER_PRODUCTION.md):

* `prepaid_voucher_batches.group_size` — the group size the run was made in (10, 20 or any
  size); null: not grouped. `show_code` — print the voucher's code under its barcode.
  `barcode_type` — `qr` (as before) or `code128` (a line barcode, for 1D scanners).
  `customer_name` / `order_ref` — who ordered the run and their order number.
* `prepaid_vouchers.group_no` — the voucher's group (1..n within its batch), fixed when it is
  issued so an envelope keeps its number; null: not grouped.
* `prepaid_voucher_events` — the batch's audit trail: made, more issued, grouped, a group /
  a voucher / the batch cancelled — by whom, when and why.

Idempotent: the auto-reloading API runs `create_all` at startup, so the events table may
exist before this runs, and a dev database may already have a column from a previous run.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = '5c9e2a7d1f43'
down_revision: Union[str, Sequence[str], None] = 'f8a2c6e4b1d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
BATCHES = 'prepaid_voucher_batches'
VOUCHERS = 'prepaid_vouchers'
EVENTS = 'prepaid_voucher_events'


def _columns(inspector, table: str) -> set:
    return {c['name'] for c in inspector.get_columns(table)}


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError('this migration inspects the database; run it online')
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    have = _columns(inspector, BATCHES)
    if 'group_size' not in have:
        op.add_column(BATCHES, sa.Column('group_size', sa.Integer(), nullable=True))
    if 'show_code' not in have:
        op.add_column(BATCHES, sa.Column('show_code', sa.Boolean(), nullable=False, server_default=sa.false()))
    if 'barcode_type' not in have:
        op.add_column(BATCHES, sa.Column('barcode_type', sa.String(16), nullable=False, server_default='qr'))
    if 'customer_name' not in have:
        op.add_column(BATCHES, sa.Column('customer_name', sa.String(200), nullable=True))
    if 'order_ref' not in have:
        op.add_column(BATCHES, sa.Column('order_ref', sa.String(100), nullable=True))

    if 'group_no' not in _columns(inspector, VOUCHERS):
        op.add_column(VOUCHERS, sa.Column('group_no', sa.Integer(), nullable=True))
    if 'ix_prepaid_vouchers_batch_group' not in {i['name'] for i in inspector.get_indexes(VOUCHERS)}:
        op.create_index('ix_prepaid_vouchers_batch_group', VOUCHERS, ['batch_id', 'group_no'])

    if not inspector.has_table(EVENTS):
        op.create_table(
            EVENTS,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('batch_id', UUID, sa.ForeignKey('prepaid_voucher_batches.id', ondelete='CASCADE'), nullable=False),
            sa.Column('action', sa.String(32), nullable=False),
            sa.Column('group_no', sa.Integer(), nullable=True),
            sa.Column('voucher_id', UUID, nullable=True),
            sa.Column('count', sa.Integer(), nullable=True),
            sa.Column('reason', sa.Text(), nullable=True),
            sa.Column('user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('user_name', sa.String(200), nullable=True),
            sa.Column('details', sa.JSON(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        inspector = sa.inspect(bind)

    existing = {i['name'] for i in inspector.get_indexes(EVENTS)}
    if 'ix_prepaid_voucher_events_tenant_id' not in existing:
        op.create_index('ix_prepaid_voucher_events_tenant_id', EVENTS, ['tenant_id'])
    if 'ix_prepaid_voucher_events_batch' not in existing:
        op.create_index('ix_prepaid_voucher_events_batch', EVENTS, ['batch_id', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_prepaid_voucher_events_batch', table_name=EVENTS)
    op.drop_index('ix_prepaid_voucher_events_tenant_id', table_name=EVENTS)
    op.drop_table(EVENTS)
    op.drop_index('ix_prepaid_vouchers_batch_group', table_name=VOUCHERS)
    op.drop_column(VOUCHERS, 'group_no')
    for col in ('order_ref', 'customer_name', 'barcode_type', 'show_code', 'group_size'):
        op.drop_column(BATCHES, col)
