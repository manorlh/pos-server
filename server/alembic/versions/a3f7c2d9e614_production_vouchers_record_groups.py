"""production vouchers: the redemption record, goods holds, the override audit, groups

Revision ID: a3f7c2d9e614
Revises: 8b5e2f4c9a17
Create Date: 2026-10-09

The production vouchers contract:

* §5 — `prepaid_voucher_redemptions` records what each redemption was: its accounting mode and
  pricing, its value / covered / top-up / list value (agorot), its units (names, groups,
  quantities, values), the voucher's number, its type / production / batch names, whether it
  was offline (assignment, device id) and who approved a forced discount. All nullable (or
  false): a redemption made before keeps reading as before.
* §3 — `prepaid_voucher_reservations.goods` (JSON): a goods voucher's hold.
* §6 — `prepaid_voucher_override_audits`: one row per forced price reduction.
* §1 — groups on `prepaid_voucher_types` and `prepaid_voucher_batches`: `selection` ("items" for
  every existing row), `groups` (JSON), `total_qty`, `catalog_mode` ("frozen").

Idempotent (each column / table only when missing); offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'a3f7c2d9e614'
down_revision: Union[str, Sequence[str], None] = '8b5e2f4c9a17'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REDEMPTIONS = 'prepaid_voucher_redemptions'
RESERVATIONS = 'prepaid_voucher_reservations'
AUDITS = 'prepaid_voucher_override_audits'
GROUPED = ('prepaid_voucher_types', 'prepaid_voucher_batches')


def _uuid():
    return postgresql.UUID(as_uuid=True)


REDEMPTION_COLUMNS = (
    ('redemption_accounting', lambda: sa.Column('redemption_accounting', sa.String(16), nullable=True)),
    ('pricing', lambda: sa.Column('pricing', sa.String(8), nullable=True)),
    ('value_agorot', lambda: sa.Column('value_agorot', sa.Integer(), nullable=True)),
    ('covered_agorot', lambda: sa.Column('covered_agorot', sa.Integer(), nullable=True)),
    ('top_up_agorot', lambda: sa.Column('top_up_agorot', sa.Integer(), nullable=True)),
    ('list_value_agorot', lambda: sa.Column('list_value_agorot', sa.Integer(), nullable=True)),
    ('units', lambda: sa.Column('units', sa.JSON(), nullable=True)),
    ('serial', lambda: sa.Column('serial', sa.Integer(), nullable=True)),
    ('type_name', lambda: sa.Column('type_name', sa.String(200), nullable=True)),
    ('production_name', lambda: sa.Column('production_name', sa.String(200), nullable=True)),
    ('batch_name', lambda: sa.Column('batch_name', sa.String(200), nullable=True)),
    ('offline', lambda: sa.Column('offline', sa.Boolean(), nullable=False, server_default=sa.false())),
    ('assignment_id', lambda: sa.Column('assignment_id', _uuid(), nullable=True)),
    ('client_redemption_id', lambda: sa.Column('client_redemption_id', sa.String(100), nullable=True)),
    ('approved_by_pos_user_id', lambda: sa.Column('approved_by_pos_user_id', sa.String(100), nullable=True)),
    ('approved_by_pos_user_name', lambda: sa.Column('approved_by_pos_user_name', sa.String(200), nullable=True)),
)
GROUP_COLUMNS = (
    ('selection', lambda: sa.Column('selection', sa.String(8), nullable=False, server_default='items')),
    ('groups', lambda: sa.Column('groups', sa.JSON(), nullable=True)),
    ('total_qty', lambda: sa.Column('total_qty', sa.Integer(), nullable=True)),
    ('catalog_mode', lambda: sa.Column('catalog_mode', sa.String(8), nullable=False, server_default='frozen')),
)


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _columns(table: str) -> set:
    if _offline():
        return set()
    return {c['name'] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _has_table(table: str) -> bool:
    if _offline():
        return False
    return sa.inspect(op.get_bind()).has_table(table)


def upgrade() -> None:
    have = _columns(REDEMPTIONS)
    for name, column in REDEMPTION_COLUMNS:
        if name not in have:
            op.add_column(REDEMPTIONS, column())
    if 'goods' not in _columns(RESERVATIONS):
        op.add_column(RESERVATIONS, sa.Column('goods', sa.JSON(), nullable=True))
    for table in GROUPED:
        have = _columns(table)
        for name, column in GROUP_COLUMNS:
            if name not in have:
                op.add_column(table, column())
    if not _has_table(AUDITS):
        op.create_table(
            AUDITS,
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('redemption_id', _uuid(), nullable=True),
            sa.Column('voucher_id', _uuid(), nullable=True),
            sa.Column('batch_id', _uuid(), nullable=False),
            sa.Column('type_id', _uuid(), nullable=True),
            sa.Column('type_version', sa.Integer(), nullable=True),
            sa.Column('product_id', sa.String(100), nullable=True),
            sa.Column('product_name', sa.String(255), nullable=True),
            sa.Column('quantity', sa.Numeric(12, 3), nullable=True),
            sa.Column('list_price_agorot', sa.Integer(), nullable=False),
            sa.Column('value_agorot', sa.Integer(), nullable=False),
            sa.Column('reduction_agorot', sa.Integer(), nullable=False),
            sa.Column('reduction_bp', sa.Integer(), nullable=False),
            sa.Column('policy', sa.String(16), nullable=False),
            sa.Column('approved_by_pos_user_id', sa.String(100), nullable=True),
            sa.Column('approved_by_pos_user_name', sa.String(200), nullable=True),
            sa.Column('machine_id', _uuid(), nullable=True),
            sa.Column('pos_user_id', sa.String(100), nullable=True),
            sa.Column('pos_user_name', sa.String(200), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index('ix_prepaid_voucher_override_audits_tenant_id', AUDITS, ['tenant_id'])
        op.create_index('ix_prepaid_voucher_override_audits_batch', AUDITS, ['batch_id', 'created_at'])
        op.create_index('ix_prepaid_voucher_override_audits_redemption', AUDITS, ['redemption_id'])


def downgrade() -> None:
    if _offline() or _has_table(AUDITS):
        op.drop_table(AUDITS)
    for table in reversed(GROUPED):
        have = {n for n, _c in GROUP_COLUMNS} if _offline() else _columns(table)
        for name, _column in reversed(GROUP_COLUMNS):
            if name in have:
                op.drop_column(table, name)
    if _offline() or 'goods' in _columns(RESERVATIONS):
        op.drop_column(RESERVATIONS, 'goods')
    have = {n for n, _c in REDEMPTION_COLUMNS} if _offline() else _columns(REDEMPTIONS)
    for name, _column in reversed(REDEMPTION_COLUMNS):
        if name in have:
            op.drop_column(REDEMPTIONS, name)
