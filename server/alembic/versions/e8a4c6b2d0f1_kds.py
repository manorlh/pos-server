"""KDS and "תצורת עבודה לעמדה" — docs/SPEC_KDS.md

Revision ID: e8a4c6b2d0f1
Revises: d7f1a3c5e9b2
Create Date: 2026-10-06

Ten new tables (app/models/kds.py): KDS screens, per-shop station settings and routing
overrides, the shop's KDS state (change counter, pickup numbers, public token), the
kitchen orders with their workflow snapshot, dispatches (rounds), tasks, changes,
fulfillment groups and the screens' actions.

Additive only: no existing table is touched. The workflow configuration itself lives in
built-in till parameters (created at startup, `kdsEnabled` off), so every existing till
keeps working exactly as before. Idempotent: a table the auto-reloading API already
created is left as it is.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e8a4c6b2d0f1'
down_revision: Union[str, Sequence[str], None] = 'd7f1a3c5e9b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def _ts(name: str, nullable: bool = True, default: bool = False) -> sa.Column:
    if default:
        return sa.Column(name, sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('kds_devices'):
        op.create_table(
            'kds_devices',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='CASCADE'), nullable=True),
            sa.Column('name', sa.String(100), nullable=False),
            sa.Column('role', sa.String(16), nullable=False, server_default='station'),
            sa.Column('station_ids', sa.JSON(), nullable=False),
            sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
            _ts('last_seen_at'),
            _ts('created_at', default=True),
            _ts('updated_at', default=True),
            sa.CheckConstraint("role IN ('station', 'expo', 'pickup', 'manager')", name='ck_kds_devices_role'),
        )
        op.create_index('ix_kds_devices_tenant_id', 'kds_devices', ['tenant_id'])
        op.create_index('ix_kds_devices_shop', 'kds_devices', ['shop_id'])
        op.create_index(
            'uq_kds_devices_machine', 'kds_devices', ['machine_id'], unique=True,
            postgresql_where=sa.text('machine_id IS NOT NULL'),
        )

    if not inspector.has_table('kds_station_settings'):
        op.create_table(
            'kds_station_settings',
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('station_id', UUID, sa.ForeignKey('kitchen_stations.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('target_kind', sa.String(8), nullable=False, server_default='prep'),
            sa.Column('warn_minutes', sa.Integer(), nullable=False, server_default='10'),
            sa.Column('late_minutes', sa.Integer(), nullable=False, server_default='20'),
            _ts('updated_at', default=True),
            sa.CheckConstraint("target_kind IN ('prep', 'view')", name='ck_kds_station_settings_kind'),
        )
        op.create_index('ix_kds_station_settings_tenant_id', 'kds_station_settings', ['tenant_id'])

    if not inspector.has_table('kds_route_overrides'):
        op.create_table(
            'kds_route_overrides',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('area_id', UUID, sa.ForeignKey('shop_areas.id', ondelete='CASCADE'), nullable=True),
            sa.Column('service_type', sa.String(16), nullable=True),
            sa.Column('target_type', sa.String(16), nullable=False),
            sa.Column('target_id', UUID, nullable=False),
            sa.Column('station_id', UUID, sa.ForeignKey('kitchen_stations.id', ondelete='CASCADE'), nullable=True),
            _ts('created_at', default=True),
            sa.CheckConstraint("target_type IN ('category', 'product')", name='ck_kds_route_overrides_type'),
            sa.CheckConstraint(
                "service_type IS NULL OR service_type IN ('eat_in', 'take_away')",
                name='ck_kds_route_overrides_service',
            ),
        )
        op.create_index('ix_kds_route_overrides_tenant_id', 'kds_route_overrides', ['tenant_id'])
        op.create_index('ix_kds_route_overrides_shop', 'kds_route_overrides', ['shop_id'])

    if not inspector.has_table('kds_shop_state'):
        op.create_table(
            'kds_shop_state',
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('version', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('pickup_token', sa.String(64), nullable=True, unique=True),
            sa.Column('pickup_day', sa.Date(), nullable=True),
            sa.Column('pickup_next', sa.Integer(), nullable=False, server_default='1'),
            _ts('updated_at', default=True),
        )
        op.create_index('ix_kds_shop_state_tenant_id', 'kds_shop_state', ['tenant_id'])

    if not inspector.has_table('kds_orders'):
        op.create_table(
            'kds_orders',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('area_id', UUID, nullable=True),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='SET NULL'), nullable=True),
            sa.Column('source', sa.String(16), nullable=False),
            sa.Column('source_ref', sa.String(100), nullable=False),
            sa.Column('display_ref', sa.String(60), nullable=True),
            sa.Column('table_ref', sa.String(60), nullable=True),
            sa.Column('zone_name', sa.String(100), nullable=True),
            sa.Column('service_type', sa.String(16), nullable=True),
            sa.Column('guests', sa.Integer(), nullable=True),
            sa.Column('waiter_name', sa.String(200), nullable=True),
            sa.Column('pickup_name', sa.String(100), nullable=True),
            sa.Column('contact_phone', sa.String(30), nullable=True),
            sa.Column('order_note', sa.String(300), nullable=True),
            sa.Column('pickup_number', sa.Integer(), nullable=True),
            sa.Column('transaction_number', sa.String(50), nullable=True),
            sa.Column('workflow_mode', sa.String(16), nullable=False),
            sa.Column('config_version', sa.String(16), nullable=True),
            sa.Column('config_snapshot', sa.JSON(), nullable=True),
            sa.Column('paid', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('status', sa.String(16), nullable=False, server_default='open'),
            sa.Column('priority', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('priority_reason', sa.String(200), nullable=True),
            sa.Column('round_count', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
            _ts('created_at', default=True),
            _ts('first_released_at'),
            _ts('ready_at'),
            _ts('handed_over_at'),
            _ts('cancelled_at'),
            _ts('updated_at', default=True),
            sa.CheckConstraint("source IN ('table', 'quick', 'kiosk', 'external')", name='ck_kds_orders_source'),
            sa.CheckConstraint(
                "status IN ('open', 'ready', 'handed_over', 'cancelled', 'closed')", name='ck_kds_orders_status'
            ),
            sa.CheckConstraint(
                "workflow_mode IN ('DIRECT_SALE', 'ORDER_PROCESS')", name='ck_kds_orders_workflow_mode'
            ),
        )
        op.create_index('ix_kds_orders_tenant_id', 'kds_orders', ['tenant_id'])
        op.create_index('uq_kds_orders_source', 'kds_orders', ['tenant_id', 'source', 'source_ref'], unique=True)
        op.create_index('ix_kds_orders_shop_status', 'kds_orders', ['shop_id', 'status'])

    if not inspector.has_table('kds_dispatches'):
        op.create_table(
            'kds_dispatches',
            sa.Column('id', sa.String(64), primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('order_id', UUID, sa.ForeignKey('kds_orders.id', ondelete='CASCADE'), nullable=False),
            sa.Column('round_no', sa.Integer(), nullable=False),
            sa.Column('trigger', sa.String(16), nullable=False),
            sa.Column('is_addition', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('fallback_printed', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('no_tasks', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='SET NULL'), nullable=True),
            sa.Column('actor_name', sa.String(200), nullable=True),
            _ts('occurred_at'),
            sa.Column('item_count', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('payload', sa.JSON(), nullable=True),
            sa.Column('result', sa.JSON(), nullable=True),
            _ts('created_at', default=True),
        )
        op.create_index('ix_kds_dispatches_tenant_id', 'kds_dispatches', ['tenant_id'])
        op.create_index('uq_kds_dispatches_round', 'kds_dispatches', ['order_id', 'round_no'], unique=True)
        op.create_index('ix_kds_dispatches_shop', 'kds_dispatches', ['shop_id', 'created_at'])

    if not inspector.has_table('kds_tasks'):
        op.create_table(
            'kds_tasks',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('order_id', UUID, sa.ForeignKey('kds_orders.id', ondelete='CASCADE'), nullable=False),
            sa.Column('dispatch_id', sa.String(64), sa.ForeignKey('kds_dispatches.id', ondelete='CASCADE'), nullable=False),
            sa.Column('round_no', sa.Integer(), nullable=False),
            sa.Column('group_id', UUID, nullable=True),
            sa.Column('station_id', UUID, nullable=True),
            sa.Column('station_key', sa.String(40), nullable=False),
            sa.Column('station_name', sa.String(60), nullable=True),
            sa.Column('target_kind', sa.String(8), nullable=False, server_default='prep'),
            sa.Column('required', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('line_key', sa.String(120), nullable=False),
            sa.Column('product_id', sa.String(64), nullable=True),
            sa.Column('category_id', sa.String(64), nullable=True),
            sa.Column('name', sa.String(200), nullable=False),
            sa.Column('mods', sa.JSON(), nullable=True),
            sa.Column('removals', sa.JSON(), nullable=True),
            sa.Column('notes', sa.String(500), nullable=True),
            sa.Column('allergies', sa.JSON(), nullable=True),
            sa.Column('important', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('seat', sa.String(60), nullable=True),
            sa.Column('course', sa.String(60), nullable=True),
            sa.Column('meal_name', sa.String(100), nullable=True),
            sa.Column('ordered_qty', sa.Numeric(12, 3), nullable=False),
            sa.Column('cancelled_qty', sa.Numeric(12, 3), nullable=False),
            sa.Column('prepared_qty', sa.Numeric(12, 3), nullable=False),
            sa.Column('release_state', sa.String(8), nullable=False, server_default='released'),
            sa.Column('prep_state', sa.String(12), nullable=False, server_default='queued'),
            sa.Column('fallback_printed', sa.Boolean(), nullable=False, server_default=sa.false()),
            _ts('fallback_resolved_at'),
            sa.Column('over_prepared', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('linked_task_id', UUID, nullable=True),
            sa.Column('remake_reason', sa.String(200), nullable=True),
            sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
            _ts('created_at', default=True),
            _ts('released_at'),
            _ts('started_at'),
            _ts('ready_at'),
            _ts('updated_at', default=True),
            sa.CheckConstraint("release_state IN ('hold', 'released')", name='ck_kds_tasks_release'),
            sa.CheckConstraint("prep_state IN ('queued', 'preparing', 'ready')", name='ck_kds_tasks_prep'),
            sa.CheckConstraint("target_kind IN ('prep', 'view')", name='ck_kds_tasks_kind'),
        )
        op.create_index('ix_kds_tasks_tenant_id', 'kds_tasks', ['tenant_id'])
        op.create_index('uq_kds_tasks_line', 'kds_tasks', ['dispatch_id', 'line_key', 'station_key'], unique=True)
        op.create_index('ix_kds_tasks_order', 'kds_tasks', ['order_id'])
        op.create_index('ix_kds_tasks_shop_state', 'kds_tasks', ['shop_id', 'prep_state'])

    if not inspector.has_table('kds_changes'):
        op.create_table(
            'kds_changes',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('order_id', UUID, sa.ForeignKey('kds_orders.id', ondelete='CASCADE'), nullable=False),
            sa.Column('task_id', UUID, nullable=True),
            sa.Column('dispatch_id', sa.String(64), nullable=True),
            sa.Column('station_id', UUID, nullable=True),
            sa.Column('kind', sa.String(12), nullable=False),
            sa.Column('qty', sa.Numeric(12, 3), nullable=True),
            sa.Column('text', sa.String(500), nullable=True),
            sa.Column('before', sa.JSON(), nullable=True),
            sa.Column('after', sa.JSON(), nullable=True),
            sa.Column('requires_ack', sa.Boolean(), nullable=False, server_default=sa.true()),
            _ts('acked_at'),
            sa.Column('acked_by', sa.String(200), nullable=True),
            _ts('created_at', default=True),
        )
        op.create_index('ix_kds_changes_tenant_id', 'kds_changes', ['tenant_id'])
        op.create_index('ix_kds_changes_order', 'kds_changes', ['order_id'])

    if not inspector.has_table('kds_groups'):
        op.create_table(
            'kds_groups',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('order_id', UUID, sa.ForeignKey('kds_orders.id', ondelete='CASCADE'), nullable=False),
            sa.Column('key', sa.String(40), nullable=False),
            sa.Column('state', sa.String(20), nullable=False, server_default='waiting'),
            _ts('ready_at'),
            sa.Column('ready_by', sa.String(200), nullable=True),
            sa.Column('override_reason', sa.String(200), nullable=True),
            _ts('handed_over_at'),
            sa.Column('handed_over_by', sa.String(200), nullable=True),
            sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
            _ts('created_at', default=True),
            _ts('updated_at', default=True),
            sa.CheckConstraint(
                "state IN ('waiting', 'ready_for_pickup', 'handed_over', 'cancelled')", name='ck_kds_groups_state'
            ),
        )
        op.create_index('ix_kds_groups_tenant_id', 'kds_groups', ['tenant_id'])
        op.create_index('uq_kds_groups_key', 'kds_groups', ['order_id', 'key'], unique=True)

    if not inspector.has_table('kds_actions'):
        op.create_table(
            'kds_actions',
            sa.Column('id', sa.String(64), primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('machine_id', UUID, nullable=True),
            sa.Column('device_id', UUID, nullable=True),
            sa.Column('type', sa.String(24), nullable=False),
            sa.Column('target_id', sa.String(64), nullable=True),
            sa.Column('actor_name', sa.String(200), nullable=True),
            sa.Column('reason', sa.String(200), nullable=True),
            _ts('occurred_at'),
            sa.Column('outcome', sa.String(12), nullable=False),
            sa.Column('result', sa.JSON(), nullable=True),
            _ts('created_at', default=True),
        )
        op.create_index('ix_kds_actions_tenant_id', 'kds_actions', ['tenant_id'])
        op.create_index('ix_kds_actions_shop', 'kds_actions', ['shop_id', 'created_at'])


def downgrade() -> None:
    # Never run on a shared database (other agents' data): fix forward instead.
    for table in (
        'kds_actions', 'kds_groups', 'kds_changes', 'kds_tasks', 'kds_dispatches', 'kds_orders',
        'kds_shop_state', 'kds_route_overrides', 'kds_station_settings', 'kds_devices',
    ):
        op.drop_table(table)
