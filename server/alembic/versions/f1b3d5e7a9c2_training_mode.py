"""training mode ("מצב הדרכה") and the demo menu, docs/SPEC_TRAINING_MODE.md

Revision ID: f1b3d5e7a9c2
Revises: e7f9a1b3c5d7
Create Date: 2026-10-05

`shops` gains the flag and its started / ended stamps; three new tables: the quarantine
(`training_documents`), its audit log (`training_audit_log`) and what each demo-menu load
created (`demo_menu_items`).

Idempotent: the auto-reloading API runs `create_all` at startup, so the tables may exist
before this runs — then only what is missing (indexes) is added. The columns on `shops`
are added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'f1b3d5e7a9c2'
down_revision: Union[str, Sequence[str], None] = 'e7f9a1b3c5d7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def _indexes(inspector, table):
    return {i['name'] for i in inspector.get_indexes(table)}


def _constraints(inspector, table):
    return {c['name'] for c in inspector.get_unique_constraints(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    columns = {c['name'] for c in inspector.get_columns('shops')}
    if 'training_mode' not in columns:
        op.add_column('shops', sa.Column('training_mode', sa.Boolean(), nullable=False, server_default='false'))
    for name in ('training_started_at', 'training_ended_at'):
        if name not in columns:
            op.add_column('shops', sa.Column(name, sa.DateTime(timezone=True), nullable=True))
    for name in ('training_started_by', 'training_ended_by'):
        if name not in columns:
            op.add_column('shops', sa.Column(name, UUID, nullable=True))

    if not inspector.has_table('training_documents'):
        op.create_table(
            'training_documents',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='CASCADE'), nullable=False),
            sa.Column('kind', sa.String(16), nullable=False),
            sa.Column('local_id', sa.String(100), nullable=False),
            sa.Column('number', sa.String(100), nullable=True),
            sa.Column('payload', postgresql.JSONB(), nullable=False, server_default='{}'),
            sa.Column('received_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint('machine_id', 'kind', 'local_id', name='uq_training_documents_machine_kind_local'),
        )
    existing = _indexes(inspector, 'training_documents') if inspector.has_table('training_documents') else set()
    if 'ix_training_documents_tenant_id' not in existing:
        op.create_index('ix_training_documents_tenant_id', 'training_documents', ['tenant_id'])
    if 'ix_training_documents_shop_kind' not in existing:
        op.create_index('ix_training_documents_shop_kind', 'training_documents', ['shop_id', 'kind'])

    if not inspector.has_table('training_audit_log'):
        op.create_table(
            'training_audit_log',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('action', sa.String(16), nullable=False),
            sa.Column('user_id', UUID, nullable=True),
            sa.Column('machine_id', UUID, nullable=True),
            sa.Column('details', postgresql.JSONB(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    existing = _indexes(inspector, 'training_audit_log') if inspector.has_table('training_audit_log') else set()
    if 'ix_training_audit_log_shop_created' not in existing:
        op.create_index('ix_training_audit_log_shop_created', 'training_audit_log', ['shop_id', 'created_at'])

    if not inspector.has_table('demo_menu_items'):
        op.create_table(
            'demo_menu_items',
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=False),
            sa.Column('company_id', UUID, sa.ForeignKey('companies.id', ondelete='CASCADE'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=True),
            sa.Column('load_id', UUID, nullable=False),
            sa.Column('template', sa.String(32), nullable=False),
            sa.Column('entity_type', sa.String(32), nullable=False),
            sa.Column('entity_id', UUID, nullable=False),
            sa.Column('created_by', UUID, nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    existing = _indexes(inspector, 'demo_menu_items') if inspector.has_table('demo_menu_items') else set()
    if 'ix_demo_menu_items_company_shop' not in existing:
        op.create_index('ix_demo_menu_items_company_shop', 'demo_menu_items', ['company_id', 'shop_id'])
    if 'ix_demo_menu_items_load' not in existing:
        op.create_index('ix_demo_menu_items_load', 'demo_menu_items', ['load_id'])


def downgrade() -> None:
    op.drop_table('demo_menu_items')
    op.drop_table('training_audit_log')
    op.drop_table('training_documents')
    for name in ('training_ended_by', 'training_started_by', 'training_ended_at', 'training_started_at', 'training_mode'):
        op.drop_column('shops', name)
