""""פתיחת פריטים אוטומטית אחרי Z" and "חסימה קבועה"

Revision ID: c7a1e5d3b9f4
Revises: a8e2c4f6b1d9
Create Date: 2026-10-06

docs/SPEC_AVAILABILITY.md:

* `block_permanent` (bool, default false) and `blocked_at` on every lock a Z may reopen —
  the shop's, a point of sale's and a till's product locks, and the category switch-offs.
  A lock already in place gets `blocked_at = updated_at` (the best the row knows) and stays
  temporary, as every lock not marked "חסימה קבועה" is;
* `availability_day_closes` — one row per (Z, level, target) whose day that Z closed with
  the setting on: the run's idempotency key, and where "the day" starts next time;
* `availability_reopens` — what each run opened, and what it kept closed for stock.

Idempotent: columns, tables and indexes are added only when missing (the auto-reloading
API creates new tables itself before this runs).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c7a1e5d3b9f4'
down_revision: Union[str, Sequence[str], None] = 'a8e2c4f6b1d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: (table, the column that is false while locked)
LOCK_TABLES = (
    ('shop_product_overrides', 'is_available'),
    ('area_product_overrides', 'is_available'),
    ('machine_product_overrides', 'is_available'),
    ('category_availability_overrides', 'is_active'),
)


def _columns(inspector, table):
    return {c['name'] for c in inspector.get_columns(table)}


def _indexes(inspector, table):
    return {i['name'] for i in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table, flag in LOCK_TABLES:
        have = _columns(inspector, table)
        if 'block_permanent' not in have:
            op.add_column(
                table,
                sa.Column('block_permanent', sa.Boolean(), nullable=False, server_default=sa.false()),
            )
        if 'blocked_at' not in have:
            op.add_column(table, sa.Column('blocked_at', sa.DateTime(timezone=True), nullable=True))
            op.execute(
                f"UPDATE {table} SET blocked_at = updated_at WHERE {flag} IS FALSE AND blocked_at IS NULL"
            )

    inspector = sa.inspect(bind)
    if not inspector.has_table('availability_day_closes'):
        op.create_table(
            'availability_day_closes',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column('tenant_id', postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column('shop_id', postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column(
                'z_report_id',
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey('z_reports.id', ondelete='CASCADE'),
                nullable=False,
            ),
            sa.Column('level', sa.String(16), nullable=False),
            sa.Column('target_id', postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column('closed_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('mode', sa.String(8), nullable=False),
            sa.Column('ignore_stock', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('reopened_count', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('kept_count', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint('z_report_id', 'level', 'target_id', name='uq_availability_day_close'),
        )
    have = _indexes(sa.inspect(bind), 'availability_day_closes')
    for name, cols in (
        ('ix_availability_day_closes_tenant_id', ['tenant_id']),
        ('ix_availability_day_closes_shop_id', ['shop_id']),
        ('ix_availability_day_closes_z_report_id', ['z_report_id']),
        ('ix_availability_day_closes_target', ['level', 'target_id', 'closed_at']),
    ):
        if name not in have:
            op.create_index(name, 'availability_day_closes', cols)

    if not sa.inspect(bind).has_table('availability_reopens'):
        op.create_table(
            'availability_reopens',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                'day_close_id',
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey('availability_day_closes.id', ondelete='CASCADE'),
                nullable=False,
            ),
            sa.Column('kind', sa.String(16), nullable=False),
            sa.Column('item_id', postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column('item_name', sa.String(255), nullable=True),
            sa.Column('outcome', sa.String(16), nullable=False),
            sa.Column('blocked_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint('day_close_id', 'kind', 'item_id', name='uq_availability_reopen_item'),
        )
    have = _indexes(sa.inspect(bind), 'availability_reopens')
    for name, cols in (
        ('ix_availability_reopens_day_close_id', ['day_close_id']),
        ('ix_availability_reopens_item_id', ['item_id']),
    ):
        if name not in have:
            op.create_index(name, 'availability_reopens', cols)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table('availability_reopens'):
        op.drop_table('availability_reopens')
    if inspector.has_table('availability_day_closes'):
        op.drop_table('availability_day_closes')
    for table, _flag in reversed(LOCK_TABLES):
        have = _columns(sa.inspect(bind), table)
        for column in ('blocked_at', 'block_permanent'):
            if column in have:
                op.drop_column(table, column)
