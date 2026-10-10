"""Card-integration secrets (the Z-Credit terminal password), per settings layer

Revision ID: 5c7e9a1b3d24
Revises: d8f2a4c6e0b1
Create Date: 2026-10-05

docs/SPEC_ZCREDIT.md: `paymentIntegration` and Z-Credit's own fields are settings on the
usual layers (JSON, no schema change). The terminal password is not: it is write-only in
the dashboard and must never sit in a layer's `settings` JSON, so it gets this table,
encrypted at rest (app/services/payment_secrets.py), one row per layer and key.

Idempotent: the auto-reloading API may have created the table already (create_all at
startup) — then only the missing indexes are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '5c7e9a1b3d24'
down_revision: Union[str, Sequence[str], None] = 'd8f2a4c6e0b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'payment_integration_secrets'
INDEXES = (
    ('ix_payment_integration_secrets_tenant_id', ['tenant_id']),
    ('ix_payment_integration_secrets_entity_id', ['entity_id']),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column('tenant_id', postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column('level', sa.String(16), nullable=False),
            sa.Column('entity_id', postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column('key', sa.String(64), nullable=False),
            sa.Column('ciphertext', sa.Text(), nullable=False),
            sa.Column('updated_by', postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column(
                'updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')
            ),
            sa.UniqueConstraint('level', 'entity_id', 'key', name='uq_payment_integration_secrets_layer_key'),
        )
        inspector = sa.inspect(bind)
    have = {ix['name'] for ix in inspector.get_indexes(TABLE)}
    for name, columns in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, columns)


def downgrade() -> None:
    op.drop_table(TABLE)
