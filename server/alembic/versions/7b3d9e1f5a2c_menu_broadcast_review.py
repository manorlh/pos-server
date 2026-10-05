"""catalog_publications + shop_work_types: menu change review before broadcast

Revision ID: 7b3d9e1f5a2c
Revises: 4e8a1c6f9b27
Create Date: 2026-10-05

* `catalog_publications` — "סקירת שינויים לפני שידור לקופות"
  (docs/SPEC_MENU_BROADCAST_REVIEW.md): a shop's broadcast menu versions. A shop in
  review mode serves its tills the latest one instead of the live catalog.
* `shop_work_types` — the shop's "סוגי עבודה" besides tables (Take Away, quick order,
  deliveries); informational.

Idempotent: the auto-reloading API runs `create_all` at startup, so a table may exist
before this runs — then only the indexes that are missing are added. No change to any
existing table.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '7b3d9e1f5a2c'
down_revision: Union[str, Sequence[str], None] = '4e8a1c6f9b27'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
PUBLICATIONS = 'catalog_publications'
WORK_TYPES = 'shop_work_types'


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(PUBLICATIONS):
        op.create_table(
            PUBLICATIONS,
            sa.Column('id', UUID, primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=False),
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), nullable=False),
            sa.Column('version', sa.Integer(), nullable=False),
            sa.Column('kind', sa.String(16), nullable=False, server_default='broadcast'),
            sa.Column('snapshot', sa.JSON(), nullable=True),
            sa.Column('summary', sa.JSON(), nullable=True),
            sa.Column('fingerprint', sa.String(64), nullable=True),
            sa.Column('published_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column(
                'published_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True,
            ),
            sa.Column('published_by_name', sa.String(255), nullable=True),
            sa.Column('note', sa.String(500), nullable=True),
            sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint('shop_id', 'version', name='uq_catalog_publications_shop_version'),
        )
        inspector = sa.inspect(bind)

    existing = {i['name'] for i in inspector.get_indexes(PUBLICATIONS)}
    if 'ix_catalog_publications_tenant_id' not in existing:
        op.create_index('ix_catalog_publications_tenant_id', PUBLICATIONS, ['tenant_id'])
    if 'ix_catalog_publications_shop_published' not in existing:
        op.create_index('ix_catalog_publications_shop_published', PUBLICATIONS, ['shop_id', 'published_at'])

    if not inspector.has_table(WORK_TYPES):
        op.create_table(
            WORK_TYPES,
            sa.Column('shop_id', UUID, sa.ForeignKey('shops.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('tenant_id', UUID, sa.ForeignKey('tenants.id', ondelete='CASCADE'), nullable=False),
            sa.Column('take_away', sa.Boolean(), nullable=True),
            sa.Column('quick_order', sa.Boolean(), nullable=True),
            sa.Column('delivery', sa.Boolean(), nullable=True),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column(
                'updated_by_user_id', UUID, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True,
            ),
        )
        inspector = sa.inspect(bind)

    existing = {i['name'] for i in inspector.get_indexes(WORK_TYPES)}
    if 'ix_shop_work_types_tenant_id' not in existing:
        op.create_index('ix_shop_work_types_tenant_id', WORK_TYPES, ['tenant_id'])


def downgrade() -> None:
    op.drop_table(WORK_TYPES)
    op.drop_table(PUBLICATIONS)
