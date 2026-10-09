"""Device groups ("קבוצות מכשירים") and the menus' `group` assignment level

Revision ID: e8b3f5a1c7d2
Revises: 6b1e9d4f2a87
Create Date: 2026-10-09

* `machine_groups` — a named group of tills across the shops of one company ("קיוסקים", "בר",
  "עמדות אירוע"); `machine_group_members` — its tills (a till may be in several groups).
* `catalog_menu_assignments` / `catalog_menu_fallbacks`: the level check widened to `group`
  (machine > group > area > shop > company — app/services/catalog_menu_rules.py).

Idempotent: a table that exists is left (only missing indexes added), and each check constraint
is dropped and made again.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e8b3f5a1c7d2'
down_revision: Union[str, Sequence[str], None] = '6b1e9d4f2a87'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LEVELS_WITH_GROUP = "level IN ('company', 'shop', 'area', 'group', 'machine')"
LEVELS_BEFORE = "level IN ('company', 'shop', 'area', 'machine')"
CHECKS = (
    ('catalog_menu_assignments', 'ck_catalog_menu_assignments_level'),
    ('catalog_menu_fallbacks', 'ck_catalog_menu_fallbacks_level'),
)


def _indexes(inspector, table):
    return {ix['name'] for ix in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('machine_groups'):
        op.create_table(
            'machine_groups',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column('tenant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column(
                'company_id', postgresql.UUID(as_uuid=True),
                sa.ForeignKey('companies.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column('name', sa.String(80), nullable=False),
            sa.Column('sort_order', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column(
                'created_by', postgresql.UUID(as_uuid=True),
                sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True,
            ),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
            sa.UniqueConstraint('company_id', 'name', name='uq_machine_groups_company_name'),
        )
    if 'ix_machine_groups_tenant' not in _indexes(sa.inspect(bind), 'machine_groups'):
        op.create_index('ix_machine_groups_tenant', 'machine_groups', ['tenant_id'])

    if not sa.inspect(bind).has_table('machine_group_members'):
        op.create_table(
            'machine_group_members',
            sa.Column(
                'group_id', postgresql.UUID(as_uuid=True),
                sa.ForeignKey('machine_groups.id', ondelete='CASCADE'), primary_key=True,
            ),
            sa.Column(
                'machine_id', postgresql.UUID(as_uuid=True),
                sa.ForeignKey('pos_machines.id', ondelete='CASCADE'), primary_key=True,
            ),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        )
    if 'ix_machine_group_members_machine' not in _indexes(sa.inspect(bind), 'machine_group_members'):
        op.create_index('ix_machine_group_members_machine', 'machine_group_members', ['machine_id'])

    for table, name in CHECKS:
        if sa.inspect(bind).has_table(table):
            op.execute(f'ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}')
            op.create_check_constraint(name, table, LEVELS_WITH_GROUP)


def downgrade() -> None:
    bind = op.get_bind()
    for table, name in CHECKS:
        if sa.inspect(bind).has_table(table):
            # A group's assignments and fallbacks have nowhere to go.
            op.execute(f"DELETE FROM {table} WHERE level = 'group'")
            op.execute(f'ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}')
            op.create_check_constraint(name, table, LEVELS_BEFORE)
    if sa.inspect(bind).has_table('machine_group_members'):
        op.drop_table('machine_group_members')
    if sa.inspect(bind).has_table('machine_groups'):
        op.drop_table('machine_groups')
