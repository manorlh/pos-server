"""kitchen stations

Kitchen stations ("תחנות": גריל, טיגון, בר…): a named routing target for the whole network,
mapped per shop to that shop's printers, and assigned to categories / products.

Revision ID: 092599eeedbb
Revises: d3e5f7a9b1c2
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '092599eeedbb'
down_revision: Union[str, Sequence[str], None] = 'd3e5f7a9b1c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'kitchen_stations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('tenant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('tenants.id'), nullable=False),
        sa.Column('name', sa.String(60), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('ix_kitchen_stations_tenant_id', 'kitchen_stations', ['tenant_id'])
    op.create_index('uq_kitchen_stations_tenant_name', 'kitchen_stations', ['tenant_id', 'name'], unique=True)

    op.create_table(
        'kitchen_station_printers',
        sa.Column('station_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('kitchen_stations.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('printer_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('kitchen_printers.id', ondelete='CASCADE'), primary_key=True),
    )

    op.create_table(
        'kitchen_station_targets',
        sa.Column('target_type', sa.String(16), primary_key=True),
        sa.Column('target_id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('tenant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('tenants.id'), nullable=False),
        sa.Column('station_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('kitchen_stations.id', ondelete='CASCADE'), nullable=False),
        sa.CheckConstraint("target_type IN ('category', 'product')", name='ck_kitchen_station_targets_type'),
    )
    op.create_index('ix_kitchen_station_targets_tenant_id', 'kitchen_station_targets', ['tenant_id'])
    op.create_index('ix_kitchen_station_targets_station_id', 'kitchen_station_targets', ['station_id'])


def downgrade() -> None:
    op.drop_table('kitchen_station_targets')
    op.drop_table('kitchen_station_printers')
    op.drop_index('uq_kitchen_stations_tenant_name', table_name='kitchen_stations')
    op.drop_index('ix_kitchen_stations_tenant_id', table_name='kitchen_stations')
    op.drop_table('kitchen_stations')
