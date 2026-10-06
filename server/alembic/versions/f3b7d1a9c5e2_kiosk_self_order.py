"""kiosk: the customer self-order kiosk (R2M) — app/models/kiosk.py

Revision ID: f3b7d1a9c5e2
Revises: e8a4c6b2d0f1
Create Date: 2026-10-06

Six new tables: `kiosk_settings` (the kiosk config as partial override layers, company →
shop → machine), `kiosk_devices` (which tills are kiosks, their pause state, controllers
and last reported status), `kiosk_orders` (paid kiosk orders with their immutable
snapshot), `kiosk_pickup_counters` / `kiosk_pickup_allocations` (the shop-wide daily pickup
sequence) and `kiosk_commands` (the audit of pause / resume / close shift / till Z).

Additive only: nothing existing changes. Idempotent: the auto-reloading API runs
`create_all` at startup, so a table may exist before this runs — then only its missing
indexes are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'f3b7d1a9c5e2'
down_revision: Union[str, Sequence[str], None] = 'e8a4c6b2d0f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def _ts(name, nullable=True, now=False):
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable,
                     server_default=sa.func.now() if now else None)


def _indexes(inspector, table, wanted):
    existing = {i['name'] for i in inspector.get_indexes(table)}
    for name, columns, unique, where in wanted:
        if name not in existing:
            if where is not None:
                op.create_index(name, table, columns, unique=unique, postgresql_where=sa.text(where))
            else:
                op.create_index(name, table, columns, unique=unique)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('kiosk_settings'):
        op.create_table(
            'kiosk_settings',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=True),
            sa.Column('level', sa.String(16), nullable=False),
            sa.Column('company_id', UUID, sa.ForeignKey('companies.id', ondelete='CASCADE'), nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=True),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='CASCADE'), nullable=True),
            sa.Column('overrides', JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
            _ts('updated_at', False, True),
            sa.Column('updated_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.UniqueConstraint('level', 'company_id', 'shop_id', 'machine_id', name='uq_kiosk_settings_scope'),
            sa.CheckConstraint("level IN ('company', 'shop', 'machine')", name='ck_kiosk_settings_level'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'kiosk_settings', [
        ('ix_kiosk_settings_tenant_id', ['tenant_id'], False, None),
        ('uq_kiosk_settings_company', ['company_id'], True, "level = 'company'"),
        ('uq_kiosk_settings_shop', ['shop_id'], True, "level = 'shop'"),
        ('uq_kiosk_settings_machine', ['machine_id'], True, "level = 'machine'"),
    ])

    if not inspector.has_table('kiosk_devices'):
        op.create_table(
            'kiosk_devices',
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='SET NULL'), nullable=True),
            sa.Column('company_id', UUID, sa.ForeignKey('companies.id', ondelete='SET NULL'), nullable=True),
            sa.Column('name', sa.String(100), nullable=False),
            sa.Column('enabled', sa.Boolean, nullable=False, server_default=sa.true()),
            sa.Column('paused', sa.Boolean, nullable=False, server_default=sa.false()),
            sa.Column('pause_message', sa.String(300), nullable=True),
            _ts('paused_at'),
            sa.Column('paused_by', sa.String(200), nullable=True),
            sa.Column('controller_machine_ids', JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
            _ts('created_at', False, True),
            sa.Column('created_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            _ts('last_kiosk_sync_at'),
            sa.Column('status', JSONB, nullable=True),
            sa.Column('applied_config_version', sa.String(32), nullable=True),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'kiosk_devices', [
        ('ix_kiosk_devices_tenant_id', ['tenant_id'], False, None),
        ('ix_kiosk_devices_shop_id', ['shop_id'], False, None),
    ])

    if not inspector.has_table('kiosk_orders'):
        op.create_table(
            'kiosk_orders',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=True),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='SET NULL'), nullable=True),
            sa.Column('local_id', sa.String(64), nullable=False),
            sa.Column('transaction_id', sa.String(64), nullable=True),
            sa.Column('transaction_number', sa.String(64), nullable=True),
            sa.Column('pickup_number', sa.Integer, nullable=False),
            sa.Column('pickup_label', sa.String(32), nullable=False),
            sa.Column('business_date', sa.Date, nullable=False),
            sa.Column('service_type', sa.String(16), nullable=False),
            sa.Column('table_ref', sa.String(64), nullable=True),
            sa.Column('fulfillment_mode', sa.String(8), nullable=False),
            sa.Column('config_version', sa.String(32), nullable=True),
            sa.Column('customer_name', sa.String(100), nullable=True),
            sa.Column('customer_phone', sa.String(32), nullable=True),
            sa.Column('item_count', sa.Integer, nullable=False),
            sa.Column('total_agorot', sa.BigInteger, nullable=False),
            sa.Column('tip_agorot', sa.BigInteger, nullable=False),
            _ts('paid_at', False),
            sa.Column('bon_status', sa.String(16), nullable=False),
            sa.Column('bon_detail', sa.String(500), nullable=True),
            sa.Column('receipt_status', sa.String(16), nullable=False),
            sa.Column('status', sa.String(24), nullable=False),
            _ts('created_at', False, True),
            _ts('updated_at', False, True),
            sa.UniqueConstraint('machine_id', 'local_id', name='uq_kiosk_orders_machine_local'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'kiosk_orders', [
        ('ix_kiosk_orders_tenant_id', ['tenant_id'], False, None),
        ('ix_kiosk_orders_machine_date', ['machine_id', 'business_date'], False, None),
        ('ix_kiosk_orders_shop_date', ['shop_id', 'business_date'], False, None),
    ])

    if not inspector.has_table('kiosk_pickup_counters'):
        op.create_table(
            'kiosk_pickup_counters',
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('business_date', sa.Date, primary_key=True),
            sa.Column('last_number', sa.Integer, nullable=False, server_default='0'),
        )
        inspector = sa.inspect(bind)

    if not inspector.has_table('kiosk_pickup_allocations'):
        op.create_table(
            'kiosk_pickup_allocations',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('business_date', sa.Date, nullable=False),
            sa.Column('order_key', sa.String(64), nullable=False),
            sa.Column('number', sa.Integer, nullable=False),
            sa.Column('label', sa.String(32), nullable=False),
            sa.Column('machine_id', UUID, nullable=True),
            _ts('created_at', False, True),
            sa.UniqueConstraint('shop_id', 'business_date', 'order_key', name='uq_kiosk_pickup_allocations_key'),
        )
        inspector = sa.inspect(bind)

    if not inspector.has_table('kiosk_commands'):
        op.create_table(
            'kiosk_commands',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=True),
            sa.Column('kiosk_machine_id', UUID, sa.ForeignKey('pos_machines.id'), nullable=False),
            sa.Column('action', sa.String(16), nullable=False),
            sa.Column('message', sa.String(300), nullable=True),
            sa.Column('force', sa.Boolean, nullable=False, server_default=sa.false()),
            sa.Column('source', sa.String(16), nullable=False),
            sa.Column('requested_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
            sa.Column('requested_by_machine_id', UUID, nullable=True),
            sa.Column('requested_by_name', sa.String(200), nullable=True),
            sa.Column('status', sa.String(16), nullable=False),
            sa.Column('request_id', UUID, nullable=True),
            sa.Column('detail', sa.Text, nullable=True),
            _ts('created_at', False, True),
            sa.CheckConstraint("action IN ('pause', 'resume', 'close_shift', 'till_z')", name='ck_kiosk_commands_action'),
            sa.CheckConstraint("source IN ('dashboard', 'till')", name='ck_kiosk_commands_source'),
            sa.CheckConstraint("status IN ('applied', 'requested', 'refused')", name='ck_kiosk_commands_status'),
        )
        inspector = sa.inspect(bind)
    _indexes(inspector, 'kiosk_commands', [
        ('ix_kiosk_commands_tenant_id', ['tenant_id'], False, None),
        ('ix_kiosk_commands_kiosk_created', ['kiosk_machine_id', 'created_at'], False, None),
    ])


def downgrade() -> None:
    for table in (
        'kiosk_commands', 'kiosk_pickup_allocations', 'kiosk_pickup_counters',
        'kiosk_orders', 'kiosk_devices', 'kiosk_settings',
    ):
        op.drop_table(table)
