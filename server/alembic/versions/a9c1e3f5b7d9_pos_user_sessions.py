"""pos_user_sessions: "עובד מחובר בקופה אחת בלבד", docs/SPEC_EXCLUSIVE_LOGIN.md

Revision ID: a9c1e3f5b7d9
Revises: f1b3d5e7a9c2
Create Date: 2026-10-05

Who is signed in at which till: one row per sign-in, with the partial unique index that
allows one live session per till user.

Idempotent: the auto-reloading API runs `create_all` at startup, so the table may exist
before this runs — then only the indexes that are missing are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'a9c1e3f5b7d9'
down_revision: Union[str, Sequence[str], None] = 'f1b3d5e7a9c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
TABLE = 'pos_user_sessions'


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=True),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=True),
            sa.Column('pos_user_id', UUID, sa.ForeignKey('pos_users.id', ondelete='CASCADE'), nullable=False),
            sa.Column('machine_id', UUID, sa.ForeignKey('pos_machines.id', ondelete='CASCADE'), nullable=False),
            sa.Column('started_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('released_by', sa.String(16), nullable=True),
            sa.Column('released_by_name', sa.String(200), nullable=True),
            sa.Column('released_by_machine_id', UUID, nullable=True),
        )
        inspector = sa.inspect(bind)

    existing = {i['name'] for i in inspector.get_indexes(TABLE)}
    if 'uq_pos_user_sessions_active_user' not in existing:
        op.create_index(
            'uq_pos_user_sessions_active_user', TABLE, ['pos_user_id'],
            unique=True, postgresql_where=sa.text('released_at IS NULL'),
        )
    if 'ix_pos_user_sessions_machine' not in existing:
        op.create_index('ix_pos_user_sessions_machine', TABLE, ['machine_id', 'released_at'])
    if 'ix_pos_user_sessions_shop' not in existing:
        op.create_index('ix_pos_user_sessions_shop', TABLE, ['shop_id', 'released_at'])
    if 'ix_pos_user_sessions_tenant_id' not in existing:
        op.create_index('ix_pos_user_sessions_tenant_id', TABLE, ['tenant_id'])


def downgrade() -> None:
    op.drop_table(TABLE)
