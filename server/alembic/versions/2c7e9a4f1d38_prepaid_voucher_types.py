"""prepaid vouchers: voucher types — every batch issued from one, the two prices

Revision ID: 2c7e9a4f1d38
Revises: 6b1e9d4f2a87
Create Date: 2026-10-08

The production vouchers spec (P:\\specs\\production-vouchers-spec.md §2–3, §19.1): every voucher
belongs to a voucher type ("סוג שובר") that says what it gives, its value at the till and its
price to the production; a batch copies the type when issued.

* `prepaid_voucher_types`, `prepaid_voucher_type_items` (a type's goods), and
  `prepaid_voucher_type_events` (its audit trail);
* `prepaid_voucher_batches`: `type_id` (NOT NULL once every batch has one), `type_version`,
  `type_code`, `type_name`, and the copied `till_value`, `production_price` (agorot), `pricing`,
  `allow_top_up`, `print_till_value`, `redemption_accounting` (`discount` "קיזוז מהחשבונית
  (כמו הנחה)" / `payment` "אמצעי תשלום (חייב במע״מ)" / `zero` "₪0 עם הצגת שווי"),
  `show_validity` ("הצג תוקף על השובר"),
  `discount_block_policy` (+ `override_*` caps and scope) and
  `offline_allowed` ("מימוש ללא אינטרנט");
* every existing batch gets a `legacy` type of its own (same id as the batch, its goods copied
  item by item): `cover` with no value, `redemption_accounting` `zero` (the owner — editable
  per batch), the discount block honoured, online only.

Idempotent: tables, columns and indexes only when missing; only batches without a type are
given one; the data step is plain INSERT … SELECT, so offline (`--sql`) emits it too.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '2c7e9a4f1d38'
down_revision: Union[str, Sequence[str], None] = 'c6d2e8f4a1b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TYPES = 'prepaid_voucher_types'
TYPE_ITEMS = 'prepaid_voucher_type_items'
TYPE_EVENTS = 'prepaid_voucher_type_events'
BATCHES = 'prepaid_voucher_batches'
BATCH_ITEMS = 'prepaid_voucher_batch_items'


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _uuid():
    return postgresql.UUID(as_uuid=True)


def _inspect():
    return None if _offline() else sa.inspect(op.get_bind())


def _has_table(insp, name) -> bool:
    return False if insp is None else insp.has_table(name)


def _columns(insp, table) -> set:
    return set() if insp is None else {c['name'] for c in insp.get_columns(table)}


def _indexes(insp, table) -> set:
    return set() if insp is None else {i['name'] for i in insp.get_indexes(table)}


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        # Never wait behind a long query on a busy table: fail fast, the deploy retries (review 09.10).
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    insp = _inspect()
    if not _has_table(insp, TYPES):
        op.create_table(
            TYPES,
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('company_id', _uuid(), sa.ForeignKey('companies.id'), nullable=False),
            sa.Column('code', sa.String(32), nullable=True),
            sa.Column('name', sa.String(200), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('origin', sa.String(16), nullable=False, server_default='manual'),
            sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('kind', sa.String(16), nullable=False, server_default='items'),
            sa.Column('till_value', sa.Integer(), nullable=True),
            sa.Column('production_price', sa.Integer(), nullable=True),
            sa.Column('pricing', sa.String(8), nullable=False, server_default='fixed'),
            sa.Column('allow_top_up', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('redemption_accounting', sa.String(16), nullable=False, server_default='discount'),
            sa.Column('show_validity', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('discount_block_policy', sa.String(16), nullable=False, server_default='honour'),
            sa.Column('override_max_amount', sa.Integer(), nullable=True),
            sa.Column('override_max_percent', sa.Integer(), nullable=True),
            sa.Column('override_max_total', sa.Integer(), nullable=True),
            sa.Column('override_scope', sa.JSON(), nullable=True),
            sa.Column('offline_allowed', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('split_allowed', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('include_extras', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('print_till_value', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('discount_type', sa.String(8), nullable=True),
            sa.Column('discount_value', sa.Integer(), nullable=True),
            sa.Column('min_purchase', sa.Integer(), nullable=True),
            sa.Column('max_discount', sa.Integer(), nullable=True),
            sa.Column('max_units', sa.Integer(), nullable=True),
            sa.Column('targets', sa.JSON(), nullable=True),
            sa.Column('stacking', sa.String(24), nullable=False, server_default='single'),
            sa.Column('promotion_policy', sa.String(16), nullable=False, server_default='exclude'),
            sa.Column('uses_per_voucher', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('max_uses_per_sale', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('max_uses_per_day', sa.Integer(), nullable=True),
            sa.Column('created_by', _uuid(), sa.ForeignKey('users.id'), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("pricing IN ('fixed', 'cover')", name='ck_prepaid_voucher_types_pricing'),
            sa.CheckConstraint(
                "discount_block_policy IN ('honour', 'auto', 'manager')",
                name='ck_prepaid_voucher_types_discount_block_policy',
            ),
            sa.CheckConstraint(
                "redemption_accounting IN ('discount', 'payment', 'zero')",
                name='ck_prepaid_voucher_types_redemption_accounting',
            ),
            sa.CheckConstraint(
                "kind IN ('items', 'order_discount', 'item_discount')", name='ck_prepaid_voucher_types_kind'
            ),
        )
    if 'ix_prepaid_voucher_types_tenant_id' not in _indexes(insp, TYPES):
        op.create_index('ix_prepaid_voucher_types_tenant_id', TYPES, ['tenant_id'])
    if 'ix_prepaid_voucher_types_company' not in _indexes(insp, TYPES):
        op.create_index('ix_prepaid_voucher_types_company', TYPES, ['tenant_id', 'company_id'])

    if not _has_table(insp, TYPE_ITEMS):
        op.create_table(
            TYPE_ITEMS,
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('type_id', _uuid(), sa.ForeignKey(f'{TYPES}.id', ondelete='CASCADE'), nullable=False),
            sa.Column('product_id', _uuid(), sa.ForeignKey('products.id'), nullable=False),
            sa.Column('product_name', sa.String(255), nullable=False),
            sa.Column('quantity', sa.Numeric(10, 3), nullable=False),
            sa.Column('weighed', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('unit_label', sa.String(16), nullable=True),
            sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
            sa.UniqueConstraint('type_id', 'product_id', name='uq_prepaid_voucher_type_items_product'),
            sa.CheckConstraint('quantity > 0', name='ck_prepaid_voucher_type_items_quantity'),
        )
    if 'ix_prepaid_voucher_type_items_type_id' not in _indexes(insp, TYPE_ITEMS):
        op.create_index('ix_prepaid_voucher_type_items_type_id', TYPE_ITEMS, ['type_id'])

    if not _has_table(insp, TYPE_EVENTS):
        op.create_table(
            TYPE_EVENTS,
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('type_id', _uuid(), sa.ForeignKey(f'{TYPES}.id', ondelete='CASCADE'), nullable=False),
            sa.Column('action', sa.String(32), nullable=False),
            sa.Column('user_id', _uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('user_name', sa.String(200), nullable=True),
            sa.Column('details', sa.JSON(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    if 'ix_prepaid_voucher_type_events_type' not in _indexes(insp, TYPE_EVENTS):
        op.create_index('ix_prepaid_voucher_type_events_type', TYPE_EVENTS, ['type_id', 'created_at'])
    if 'ix_prepaid_voucher_type_events_tenant_id' not in _indexes(insp, TYPE_EVENTS):
        op.create_index('ix_prepaid_voucher_type_events_tenant_id', TYPE_EVENTS, ['tenant_id'])

    # ── The batch: its type and the copied prices ──
    have = _columns(insp, BATCHES)
    new_columns = [
        sa.Column('type_id', _uuid(), nullable=True),
        sa.Column('type_version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('type_code', sa.String(32), nullable=True),
        sa.Column('type_name', sa.String(200), nullable=True),
        sa.Column('till_value', sa.Integer(), nullable=True),
        sa.Column('production_price', sa.Integer(), nullable=True),
        sa.Column('pricing', sa.String(8), nullable=False, server_default='cover'),
        sa.Column('allow_top_up', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('print_till_value', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('redemption_accounting', sa.String(16), nullable=False, server_default='zero'),
        sa.Column('show_validity', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('discount_block_policy', sa.String(16), nullable=False, server_default='honour'),
        sa.Column('override_max_amount', sa.Integer(), nullable=True),
        sa.Column('override_max_percent', sa.Integer(), nullable=True),
        sa.Column('override_max_total', sa.Integer(), nullable=True),
        sa.Column('override_scope', sa.JSON(), nullable=True),
        sa.Column('offline_allowed', sa.Boolean(), nullable=False, server_default=sa.false()),
    ]
    for column in new_columns:
        if column.name not in have:
            op.add_column(BATCHES, column)
    if 'ix_prepaid_voucher_batches_type_id' not in _indexes(insp, BATCHES):
        op.create_index('ix_prepaid_voucher_batches_type_id', BATCHES, ['type_id'])

    # ── Every batch without a type: a legacy type of its own (same id), its goods copied ──
    op.execute(sa.text(f"""
        INSERT INTO {TYPES} (
            id, tenant_id, company_id, code, name, description, origin, active, version, kind,
            till_value, production_price, pricing, allow_top_up, redemption_accounting, split_allowed,
            include_extras, print_till_value, discount_type, discount_value, min_purchase, max_discount,
            max_units, targets, stacking, promotion_policy, uses_per_voucher, max_uses_per_sale,
            max_uses_per_day, created_by, created_at, updated_at
        )
        SELECT
            b.id, b.tenant_id, b.company_id, NULL, b.name, NULL, 'legacy', TRUE, 1, b.kind,
            NULL, NULL, 'cover', TRUE, 'zero', b.split_allowed,
            b.include_extras, FALSE, b.discount_type, b.discount_value, b.min_purchase, b.max_discount,
            b.max_units, b.targets, b.stacking, b.promotion_policy, b.uses_per_voucher, b.max_uses_per_sale,
            b.max_uses_per_day, b.created_by, b.created_at, CURRENT_TIMESTAMP
        FROM {BATCHES} b
        WHERE b.type_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM {TYPES} t WHERE t.id = b.id)
    """))
    op.execute(sa.text(f"""
        INSERT INTO {TYPE_ITEMS} (id, type_id, product_id, product_name, quantity, weighed, unit_label, sort_order)
        SELECT i.id, i.batch_id, i.product_id, i.product_name, i.quantity, i.weighed, i.unit_label, i.sort_order
        FROM {BATCH_ITEMS} i
        JOIN {BATCHES} b ON b.id = i.batch_id
        WHERE b.type_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM {TYPE_ITEMS} ti WHERE ti.id = i.id)
    """))
    op.execute(sa.text(f"""
        UPDATE {BATCHES} SET type_id = id, type_version = 1, pricing = 'cover', allow_top_up = TRUE,
               redemption_accounting = 'zero'
        WHERE type_id IS NULL
    """))

    # No voucher without a type (§19.1). SQLite (the tests) cannot alter a column in place.
    dialect = op.get_context().dialect.name
    if dialect == 'postgresql':
        nullable = True
        if insp is not None:
            # A fresh inspector: `insp` cached the batches' columns before `type_id` was added above.
            fresh = sa.inspect(op.get_bind()).get_columns(BATCHES)
            nullable = next((c for c in fresh if c['name'] == 'type_id'), {'nullable': True})['nullable']
        if nullable:
            op.alter_column(BATCHES, 'type_id', existing_type=_uuid(), nullable=False)
        fks = set() if insp is None else {fk['name'] for fk in insp.get_foreign_keys(BATCHES)}
        if 'fk_prepaid_voucher_batches_type' not in fks:
            op.create_foreign_key(
                'fk_prepaid_voucher_batches_type', BATCHES, TYPES, ['type_id'], ['id'],
            )


def downgrade() -> None:
    insp = _inspect()
    dialect = op.get_context().dialect.name
    if dialect == 'postgresql':
        fks = set() if insp is None else {fk['name'] for fk in insp.get_foreign_keys(BATCHES)}
        if insp is None or 'fk_prepaid_voucher_batches_type' in fks:
            op.drop_constraint('fk_prepaid_voucher_batches_type', BATCHES, type_='foreignkey')
    if insp is None or 'ix_prepaid_voucher_batches_type_id' in _indexes(insp, BATCHES):
        op.drop_index('ix_prepaid_voucher_batches_type_id', table_name=BATCHES)
    have = _columns(insp, BATCHES)
    for name in ('offline_allowed', 'override_scope', 'override_max_total', 'override_max_percent',
                 'override_max_amount', 'discount_block_policy', 'show_validity', 'redemption_accounting',
                 'print_till_value',
                 'allow_top_up', 'pricing', 'production_price', 'till_value', 'type_name', 'type_code',
                 'type_version', 'type_id'):
        if insp is None or name in have:
            op.drop_column(BATCHES, name)
    for table in (TYPE_EVENTS, TYPE_ITEMS, TYPES):
        if insp is None or _has_table(insp, table):
            op.drop_table(table)
