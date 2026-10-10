"""Payment devices ("מכשירי תשלום"): a shop's card terminals for tills without one of their own

Revision ID: 7d2e4b9f1a63
Revises: a6d2f8c4e0b7
Create Date: 2026-10-08

A till or tablet with no built-in clearing (a P18) can charge on several devices of its shop,
each with a nickname — a Z-Credit pinpad, a SynqPay terminal, a Nayax handheld running
Agamento on the LAN (app/models/payment_device.py, app/services/payment_devices.py). The
devices' secrets go to the existing `payment_integration_secrets` (level "payment_device",
whose `level` column has no check constraint), so only this table is new. The feature switch
(`multiPaymentDevices`) and the default device (`defaultPaymentDeviceId`) are settings keys on
the usual layers: JSON, no schema change.

Idempotent: the auto-reloading API may have created the table already (create_all at
startup) — then only the missing indexes / constraint are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '7d2e4b9f1a63'
down_revision: Union[str, Sequence[str], None] = 'a6d2f8c4e0b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'payment_devices'
KIND_CHECK = 'ck_payment_devices_kind'
KIND_SQL = "kind IN ('zcredit_pinpad', 'synqpay', 'agamento_lan')"
NICKNAME_INDEX = 'uq_payment_devices_shop_nickname'
INDEXES = (
    ('ix_payment_devices_tenant_id', ['tenant_id']),
    ('ix_payment_devices_shop_id', ['shop_id']),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column('tenant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('tenants.id'), nullable=True),
            sa.Column(
                'shop_id', postgresql.UUID(as_uuid=True),
                sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column('nickname', sa.String(40), nullable=False),
            sa.Column('kind', sa.String(16), nullable=False),
            sa.Column('config', postgresql.JSONB(), nullable=False, server_default='{}'),
            sa.Column('machine_ids', postgresql.JSONB(), nullable=False, server_default='[]'),
            sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.text('true')),
            sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
            sa.CheckConstraint(KIND_SQL, name=KIND_CHECK),
        )
        inspector = sa.inspect(bind)
    else:
        checks = {c.get('name') for c in inspector.get_check_constraints(TABLE)}
        if KIND_CHECK not in checks:
            op.create_check_constraint(KIND_CHECK, TABLE, KIND_SQL)
    have = {ix['name'] for ix in inspector.get_indexes(TABLE)}
    for name, columns in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, columns)
    if NICKNAME_INDEX not in have and not _pg_index_exists(bind, NICKNAME_INDEX):
        op.create_index(NICKNAME_INDEX, TABLE, ['shop_id', sa.text('lower(nickname)')], unique=True)


def _pg_index_exists(bind, name: str) -> bool:
    """An expression index the inspector may not list: ask Postgres directly."""
    if bind.dialect.name != 'postgresql':
        return False
    return bind.execute(sa.text('SELECT 1 FROM pg_indexes WHERE indexname = :n'), {'n': name}).first() is not None


def downgrade() -> None:
    op.drop_table(TABLE)
