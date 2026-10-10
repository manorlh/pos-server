"""catalog menus ("תפריטים"): named sales menus by schedule, their assignments and fallbacks

Revision ID: d6e2a9c4b7f1
Revises: 3f8b6d2a9c41
Create Date: 2026-10-06

docs/SPEC_MENUS.md:

* `catalog_menus` — a named menu ("בוקר", "צהריים", "הפי האוור", "קיוסק") of a company (or
  the whole organization): channel, schedule (weekdays, hour ranges, dates, "always"),
  active flag.
* `catalog_menu_categories` / `catalog_menu_products` — what it shows, in its order, and
  its own prices.
* `catalog_menu_assignments` — menus per company / shop / point of sale / till, with a
  priority among menus of one level.
* `catalog_menu_fallbacks` — what a till sells when no menu is active, per level.
* `catalog_menu_sync_state` — when an organization's menus last changed (delta pulls).
* `transaction_items.menu_id`, `menu_name`, `price_source` — the menu active when a line
  was added, and where its price came from. Nullable, no backfill: older lines had none.

Idempotent: the auto-reloading API runs `create_all` at startup, so a table may exist
before this runs — then only the missing indexes are added; a column only if missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'd6e2a9c4b7f1'
down_revision: Union[str, Sequence[str], None] = '3f8b6d2a9c41'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def _indexes(inspector, table, wanted) -> None:
    existing = {i['name'] for i in inspector.get_indexes(table)}
    for name, columns in wanted:
        if name not in existing:
            op.create_index(name, table, columns)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('catalog_menus'):
        op.create_table(
            'catalog_menus',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('company_id', UUID, sa.ForeignKey('companies.id', ondelete='CASCADE'), nullable=True),
            sa.Column('name', sa.String(80), nullable=False),
            sa.Column('channel', sa.String(8), nullable=False, server_default='both'),
            sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('always', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('weekdays', sa.JSON(), nullable=True),
            sa.Column('time_ranges', sa.JSON(), nullable=True),
            sa.Column('valid_from', sa.Date(), nullable=True),
            sa.Column('valid_to', sa.Date(), nullable=True),
            sa.Column('color', sa.String(16), nullable=True),
            sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("channel IN ('pos', 'kiosk', 'both')", name='ck_catalog_menus_channel'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'catalog_menus', [('ix_catalog_menus_tenant', ['tenant_id'])])

    if not inspector.has_table('catalog_menu_categories'):
        op.create_table(
            'catalog_menu_categories',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('menu_id', UUID, sa.ForeignKey('catalog_menus.id', ondelete='CASCADE'), nullable=False),
            sa.Column('category_id', UUID, sa.ForeignKey('categories.id', ondelete='CASCADE'), nullable=False),
            sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('all_products', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.UniqueConstraint('menu_id', 'category_id', name='uq_catalog_menu_categories'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'catalog_menu_categories', [('ix_catalog_menu_categories_menu', ['menu_id'])])

    if not inspector.has_table('catalog_menu_products'):
        op.create_table(
            'catalog_menu_products',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('menu_id', UUID, sa.ForeignKey('catalog_menus.id', ondelete='CASCADE'), nullable=False),
            sa.Column('product_id', UUID, sa.ForeignKey('products.id', ondelete='CASCADE'), nullable=False),
            sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('price', sa.Numeric(12, 2), nullable=True),
            sa.UniqueConstraint('menu_id', 'product_id', name='uq_catalog_menu_products'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'catalog_menu_products', [('ix_catalog_menu_products_menu', ['menu_id'])])

    if not inspector.has_table('catalog_menu_assignments'):
        op.create_table(
            'catalog_menu_assignments',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('menu_id', UUID, sa.ForeignKey('catalog_menus.id', ondelete='CASCADE'), nullable=False),
            sa.Column('level', sa.String(16), nullable=False),
            sa.Column('target_id', UUID, nullable=False),
            sa.Column('priority', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint(
                "level IN ('company', 'shop', 'area', 'machine')", name='ck_catalog_menu_assignments_level',
            ),
            sa.UniqueConstraint('menu_id', 'level', 'target_id', name='uq_catalog_menu_assignments'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'catalog_menu_assignments', [
        ('ix_catalog_menu_assignments_target', ['tenant_id', 'level', 'target_id']),
    ])

    if not inspector.has_table('catalog_menu_fallbacks'):
        op.create_table(
            'catalog_menu_fallbacks',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('level', sa.String(16), nullable=False),
            sa.Column('target_id', UUID, nullable=False),
            sa.Column('mode', sa.String(16), nullable=False),
            sa.Column('updated_by', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint(
                "level IN ('company', 'shop', 'area', 'machine')", name='ck_catalog_menu_fallbacks_level',
            ),
            sa.CheckConstraint("mode IN ('catalog', 'none')", name='ck_catalog_menu_fallbacks_mode'),
            sa.UniqueConstraint('level', 'target_id', name='uq_catalog_menu_fallbacks'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'catalog_menu_fallbacks', [('ix_catalog_menu_fallbacks_tenant', ['tenant_id'])])

    if not inspector.has_table('catalog_menu_sync_state'):
        op.create_table(
            'catalog_menu_sync_state',
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('changed_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        inspector = sa.inspect(bind)

    columns = {c['name'] for c in inspector.get_columns('transaction_items')}
    if 'menu_id' not in columns:
        op.add_column('transaction_items', sa.Column('menu_id', UUID, nullable=True))
    if 'menu_name' not in columns:
        op.add_column('transaction_items', sa.Column('menu_name', sa.String(80), nullable=True))
    if 'price_source' not in columns:
        op.add_column('transaction_items', sa.Column('price_source', sa.String(16), nullable=True))


def downgrade() -> None:
    for column in ('price_source', 'menu_name', 'menu_id'):
        op.drop_column('transaction_items', column)
    for table in (
        'catalog_menu_sync_state', 'catalog_menu_fallbacks', 'catalog_menu_assignments',
        'catalog_menu_products', 'catalog_menu_categories', 'catalog_menus',
    ):
        op.drop_table(table)
