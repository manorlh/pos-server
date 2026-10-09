"""prepaid vouchers: offline assignments ("מימוש ללא אינטרנט", the production vouchers contract §7)

Revision ID: c8e1f5a3b702
Revises: a3f7c2d9e614
Create Date: 2026-10-09

`prepaid_voucher_offline_assignments`: a batch assigned to one till (`machine`) or to its shop's
LAN host (`lan_host`), its version, the device's last download and sync (and what it still had
pending), and the release (who, when, forced with a reason). Also a unique index on
`prepaid_voucher_redemptions (tenant_id, client_redemption_id)` — an offline redemption is
synced once, by the device's own id.

Idempotent (the table and indexes only when missing); offline (`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c8e1f5a3b702'
down_revision: Union[str, Sequence[str], None] = 'a3f7c2d9e614'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'prepaid_voucher_offline_assignments'
REDEMPTIONS = 'prepaid_voucher_redemptions'
UNIQUE = 'ux_prepaid_voucher_redemptions_client'


def _uuid():
    return postgresql.UUID(as_uuid=True)


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _has_table(name: str) -> bool:
    return False if _offline() else sa.inspect(op.get_bind()).has_table(name)


def _indexes(table: str) -> set:
    return set() if _offline() else {i['name'] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    if op.get_context().dialect.name == 'postgresql':
        # Never wait behind a long query on a busy table: fail fast, the deploy retries (review 09.10).
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    if not _has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column('id', _uuid(), primary_key=True),
            sa.Column('tenant_id', _uuid(), sa.ForeignKey('tenants.id'), nullable=False),
            sa.Column('batch_id', _uuid(), nullable=False),
            sa.Column('target', sa.String(16), nullable=False),
            sa.Column('machine_id', _uuid(), nullable=False),
            sa.Column('shop_id', _uuid(), nullable=True),
            sa.Column('status', sa.String(16), nullable=False, server_default='active'),
            sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('assigned_by', _uuid(), nullable=True),
            sa.Column('assigned_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('last_download_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('last_sync_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('last_sync_pending', sa.Integer(), nullable=True),
            sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('released_by', _uuid(), nullable=True),
            sa.Column('forced', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('release_reason', sa.Text(), nullable=True),
        )
        op.create_index('ix_prepaid_voucher_offline_assignments_tenant_id', TABLE, ['tenant_id'])
        op.create_index('ix_prepaid_voucher_offline_assignments_batch', TABLE, ['batch_id', 'status'])
        op.create_index('ix_prepaid_voucher_offline_assignments_machine', TABLE, ['machine_id', 'status'])
    if UNIQUE not in _indexes(REDEMPTIONS):
        op.create_index(UNIQUE, REDEMPTIONS, ['tenant_id', 'client_redemption_id'], unique=True)


def downgrade() -> None:
    if _offline() or UNIQUE in _indexes(REDEMPTIONS):
        op.drop_index(UNIQUE, table_name=REDEMPTIONS)
    if _offline() or _has_table(TABLE):
        op.drop_table(TABLE)
