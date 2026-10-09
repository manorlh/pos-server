"""prepaid vouchers: kinds (goods / discount on the sale / discount on items), stacking, promotions, uses, reservations

"שוברי הפקה" (docs/SPEC_VOUCHER_PRODUCTION.md §7):

* `prepaid_voucher_batches.kind` — `items` (every batch so far: goods, a tender),
  `order_discount`, `item_discount`; the discount terms (`discount_type`, `discount_value`,
  `min_purchase`, `max_discount`, `max_units`, `targets`); `stacking`, `promotion_policy`,
  `uses_per_voucher`, `max_uses_per_sale`, `max_uses_per_day`.
  Backfill: every existing batch is `items` and keeps today's behaviour — `stacking`
  `unlimited` (several voucher legs in one sale, as the tills do today). New batches get
  `single` from the column's default afterwards.
* `prepaid_vouchers.uses_left` — a discount voucher's uses not yet taken (null for goods).
* `prepaid_voucher_redemptions` — `sale_ref`, and for a discount voucher's use: `uses`,
  `discount_amount` (agorot), `reservation_id`, `flags`.
* `prepaid_voucher_reservations` — a discount voucher held for one open sale at one till.
* `transaction_items.voucher_discount`, `transaction_voucher_discounts` — the discount
  vouchers on a sale document (a discount on the document, never a tender).

Idempotent: the auto-reloading API runs `create_all` at startup, so a new table may exist
before this runs, and a dev database may already have a column from a previous run.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = 'c7e2f4a9d1b6'
down_revision: Union[str, Sequence[str], None] = 'b4a16fe43e9d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
BATCHES = 'prepaid_voucher_batches'
VOUCHERS = 'prepaid_vouchers'
REDEMPTIONS = 'prepaid_voucher_redemptions'
RESERVATIONS = 'prepaid_voucher_reservations'
ITEMS = 'transaction_items'
TX_VOUCHERS = 'transaction_voucher_discounts'


def _columns(inspector, table: str) -> set:
    return {c['name'] for c in inspector.get_columns(table)}


def _indexes(inspector, table: str) -> set:
    return {i['name'] for i in inspector.get_indexes(table)}


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError('this migration inspects the database; run it online')
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    have = _columns(inspector, BATCHES)
    if 'kind' not in have:
        op.add_column(BATCHES, sa.Column('kind', sa.String(16), nullable=False, server_default='items'))
    for name, col in (
        ('discount_type', sa.String(8)),
        ('discount_value', sa.Integer()),
        ('min_purchase', sa.Integer()),
        ('max_discount', sa.Integer()),
        ('max_units', sa.Integer()),
        ('targets', sa.JSON()),
        ('max_uses_per_day', sa.Integer()),
    ):
        if name not in have:
            op.add_column(BATCHES, sa.Column(name, col, nullable=True))
    if 'stacking' not in have:
        # Every batch made before this keeps today's behaviour; then new ones are single.
        op.add_column(BATCHES, sa.Column('stacking', sa.String(24), nullable=False, server_default='unlimited'))
        op.alter_column(BATCHES, 'stacking', server_default='single')
    if 'promotion_policy' not in have:
        op.add_column(BATCHES, sa.Column('promotion_policy', sa.String(16), nullable=False, server_default='exclude'))
    if 'uses_per_voucher' not in have:
        op.add_column(BATCHES, sa.Column('uses_per_voucher', sa.Integer(), nullable=False, server_default='1'))
    if 'max_uses_per_sale' not in have:
        op.add_column(BATCHES, sa.Column('max_uses_per_sale', sa.Integer(), nullable=False, server_default='1'))
    checks = {c['name'] for c in inspector.get_check_constraints(BATCHES)}
    if 'ck_prepaid_voucher_batches_kind' not in checks:
        op.create_check_constraint(
            'ck_prepaid_voucher_batches_kind', BATCHES, "kind IN ('items', 'order_discount', 'item_discount')"
        )

    if 'uses_left' not in _columns(inspector, VOUCHERS):
        op.add_column(VOUCHERS, sa.Column('uses_left', sa.Integer(), nullable=True))

    have = _columns(inspector, REDEMPTIONS)
    for name, col in (
        ('sale_ref', sa.String(100)),
        ('uses', sa.Integer()),
        ('discount_amount', sa.Integer()),
        ('reservation_id', UUID),
        ('flags', sa.JSON()),
    ):
        if name not in have:
            op.add_column(REDEMPTIONS, sa.Column(name, col, nullable=True))

    if not inspector.has_table(RESERVATIONS):
        op.create_table(
            RESERVATIONS,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('voucher_id', UUID, sa.ForeignKey('prepaid_vouchers.id', ondelete='CASCADE'), nullable=False),
            sa.Column('batch_id', UUID, nullable=False),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id'), nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id'), nullable=True),
            sa.Column('client_request_id', sa.String(100), nullable=False),
            sa.Column('sale_ref', sa.String(100), nullable=False),
            sa.Column('uses', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('amount', sa.Integer(), nullable=True),
            sa.Column('status', sa.String(16), nullable=False, server_default='held'),
            sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('pos_user_id', sa.String(100), nullable=True),
            sa.Column('pos_user_name', sa.String(200), nullable=True),
            sa.Column('transaction_id', sa.String(100), nullable=True),
            sa.Column('redemption_id', UUID, nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint('machine_id', 'client_request_id', name='uq_prepaid_voucher_reservations_request'),
        )
        inspector = sa.inspect(bind)
    existing = _indexes(inspector, RESERVATIONS)
    if 'ix_prepaid_voucher_reservations_tenant_id' not in existing:
        op.create_index('ix_prepaid_voucher_reservations_tenant_id', RESERVATIONS, ['tenant_id'])
    if 'ix_prepaid_voucher_reservations_voucher' not in existing:
        op.create_index('ix_prepaid_voucher_reservations_voucher', RESERVATIONS, ['voucher_id', 'status'])
    if 'ix_prepaid_voucher_reservations_sale' not in existing:
        op.create_index('ix_prepaid_voucher_reservations_sale', RESERVATIONS, ['machine_id', 'sale_ref'])

    if 'voucher_discount' not in _columns(inspector, ITEMS):
        op.add_column(ITEMS, sa.Column('voucher_discount', sa.Numeric(12, 2), nullable=True))

    if not inspector.has_table(TX_VOUCHERS):
        op.create_table(
            TX_VOUCHERS,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('transaction_id', UUID, sa.ForeignKey('transactions.id', ondelete='CASCADE'), nullable=False),
            sa.Column('reservation_id', UUID, nullable=True),
            sa.Column('voucher_id', UUID, nullable=True),
            sa.Column('batch_id', UUID, nullable=True),
            sa.Column('serial', sa.Integer(), nullable=True),
            sa.Column('batch_name', sa.String(200), nullable=True),
            sa.Column('kind', sa.String(16), nullable=True),
            sa.Column('uses', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('discount_amount', sa.Numeric(12, 2), nullable=False, server_default='0'),
            sa.Column('lines', sa.JSON(), nullable=True),
        )
        inspector = sa.inspect(bind)
    existing = _indexes(inspector, TX_VOUCHERS)
    if 'ix_transaction_voucher_discounts_transaction' not in existing:
        op.create_index('ix_transaction_voucher_discounts_transaction', TX_VOUCHERS, ['transaction_id'])
    if 'ix_transaction_voucher_discounts_batch' not in existing:
        op.create_index('ix_transaction_voucher_discounts_batch', TX_VOUCHERS, ['batch_id'])


def downgrade() -> None:
    op.drop_index('ix_transaction_voucher_discounts_batch', table_name=TX_VOUCHERS)
    op.drop_index('ix_transaction_voucher_discounts_transaction', table_name=TX_VOUCHERS)
    op.drop_table(TX_VOUCHERS)
    op.drop_column(ITEMS, 'voucher_discount')
    op.drop_index('ix_prepaid_voucher_reservations_sale', table_name=RESERVATIONS)
    op.drop_index('ix_prepaid_voucher_reservations_voucher', table_name=RESERVATIONS)
    op.drop_index('ix_prepaid_voucher_reservations_tenant_id', table_name=RESERVATIONS)
    op.drop_table(RESERVATIONS)
    for col in ('flags', 'reservation_id', 'discount_amount', 'uses', 'sale_ref'):
        op.drop_column(REDEMPTIONS, col)
    op.drop_column(VOUCHERS, 'uses_left')
    op.drop_constraint('ck_prepaid_voucher_batches_kind', BATCHES, type_='check')
    for col in (
        'max_uses_per_day', 'max_uses_per_sale', 'uses_per_voucher', 'promotion_policy', 'stacking',
        'targets', 'max_units', 'max_discount', 'min_purchase', 'discount_value', 'discount_type', 'kind',
    ):
        op.drop_column(BATCHES, col)
