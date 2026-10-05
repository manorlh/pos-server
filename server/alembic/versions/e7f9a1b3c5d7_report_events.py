"""report events ("אירועים"): tills grouped at report level, docs/SPEC_EVENTS.md

Revision ID: e7f9a1b3c5d7
Revises: d6f8a0b2c4e6
Create Date: 2026-10-05

Idempotent: the auto-reloading API runs `create_all` at startup, so the tables may exist
before this runs — then only what is missing (indexes) is added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e7f9a1b3c5d7'
down_revision: Union[str, Sequence[str], None] = 'd6f8a0b2c4e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def _indexes(inspector, table):
    return {i['name'] for i in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('report_events'):
        op.create_table(
            'report_events',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('company_id', UUID, sa.ForeignKey('companies.id'), nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id'), nullable=False),
            sa.Column('name', sa.String(120), nullable=False),
            sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('ends_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('timezone', sa.String(64), nullable=False, server_default='Asia/Jerusalem'),
            sa.Column('status', sa.String(16), nullable=False, server_default='draft'),
            sa.Column('producer_name', sa.String(120), nullable=True),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('thresholds', postgresql.JSONB(), nullable=True),
            sa.Column('created_by_user_id', UUID, sa.ForeignKey('users.id'), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('confirmed_by_user_id', UUID, sa.ForeignKey('users.id'), nullable=True),
            sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('confirm_note', sa.Text(), nullable=True),
            sa.Column('snapshot', postgresql.JSONB(), nullable=True),
        )
    existing = _indexes(inspector, 'report_events') if inspector.has_table('report_events') else set()
    if 'ix_report_events_tenant_id' not in existing:
        op.create_index('ix_report_events_tenant_id', 'report_events', ['tenant_id'])
    if 'ix_report_events_shop_starts' not in existing:
        op.create_index('ix_report_events_shop_starts', 'report_events', ['shop_id', 'starts_at'])

    inspector = sa.inspect(bind)
    if not inspector.has_table('report_event_machines'):
        op.create_table(
            'report_event_machines',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('event_id', UUID, sa.ForeignKey('report_events.id', ondelete='CASCADE'), nullable=False),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id'), nullable=False),
            sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint('event_id', 'machine_id', name='uq_report_event_machines_event_machine'),
        )
    existing = _indexes(sa.inspect(bind), 'report_event_machines')
    if 'ix_report_event_machines_machine' not in existing:
        op.create_index('ix_report_event_machines_machine', 'report_event_machines', ['machine_id'])


def downgrade() -> None:
    op.drop_index('ix_report_event_machines_machine', table_name='report_event_machines')
    op.drop_table('report_event_machines')
    op.drop_index('ix_report_events_shop_starts', table_name='report_events')
    op.drop_index('ix_report_events_tenant_id', table_name='report_events')
    op.drop_table('report_events')
