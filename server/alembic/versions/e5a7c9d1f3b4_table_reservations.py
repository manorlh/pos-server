"""table reservations

"הזמנת שולחן": bookings for a time, a party and (optionally) a table.

Revision ID: e5a7c9d1f3b4
Revises: d4f6a8b0c2e3
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e5a7c9d1f3b4'
down_revision: Union[str, Sequence[str], None] = 'd4f6a8b0c2e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table('table_reservations'):
        # A server started on the new code may have made it already (create_all).
        existing = {i['name'] for i in inspector.get_indexes('table_reservations')}
        if 'ix_table_reservations_tenant_id' not in existing:
            op.create_index('ix_table_reservations_tenant_id', 'table_reservations', ['tenant_id'])
        if 'ix_table_reservations_shop_time' not in existing:
            op.create_index('ix_table_reservations_shop_time', 'table_reservations', ['shop_id', 'reserved_at'])
        return
    op.create_table(
        'table_reservations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('tenant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('tenants.id'), nullable=False),
        sa.Column('shop_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
        sa.Column('table_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('dining_tables.id', ondelete='SET NULL'), nullable=True),
        sa.Column('reserved_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('duration_minutes', sa.Integer(), nullable=False, server_default='90'),
        sa.Column('guests', sa.Integer(), nullable=True),
        sa.Column('customer_name', sa.String(120), nullable=False),
        sa.Column('phone', sa.String(40), nullable=True),
        sa.Column('notes', sa.String(300), nullable=True),
        sa.Column('status', sa.String(16), nullable=False, server_default='booked'),
        sa.Column('created_by_name', sa.String(200), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('ix_table_reservations_tenant_id', 'table_reservations', ['tenant_id'])
    op.create_index('ix_table_reservations_shop_time', 'table_reservations', ['shop_id', 'reserved_at'])


def downgrade() -> None:
    op.drop_index('ix_table_reservations_shop_time', table_name='table_reservations')
    op.drop_index('ix_table_reservations_tenant_id', table_name='table_reservations')
    op.drop_table('table_reservations')
