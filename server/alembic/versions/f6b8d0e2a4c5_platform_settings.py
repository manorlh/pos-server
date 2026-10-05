"""platform settings

Platform-wide settings, the super admin's: "access" (which entries and device actions each
role is denied).

Revision ID: f6b8d0e2a4c5
Revises: e5a7c9d1f3b4
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'f6b8d0e2a4c5'
down_revision: Union[str, Sequence[str], None] = 'e5a7c9d1f3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A server started on the new code may have made it already (create_all).
    if sa.inspect(op.get_bind()).has_table('platform_settings'):
        return
    op.create_table(
        'platform_settings',
        sa.Column('key', sa.String(64), primary_key=True),
        sa.Column('value', postgresql.JSONB(), nullable=False, server_default='{}'),
        sa.Column('updated_by_user_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table('platform_settings')
