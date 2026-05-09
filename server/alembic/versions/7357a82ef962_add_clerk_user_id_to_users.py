"""add_clerk_user_id_to_users

Revision ID: 7357a82ef962
Revises: 21c770e570fd
Create Date: 2026-03-29 23:13:25.403316

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '7357a82ef962'
down_revision: Union[str, Sequence[str], None] = '21c770e570fd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('clerk_user_id', sa.String(length=255), nullable=True))
    op.create_index('ix_users_clerk_user_id', 'users', ['clerk_user_id'], unique=True)
    op.alter_column('users', 'hashed_password', existing_type=sa.VARCHAR(length=255), nullable=True)


def downgrade() -> None:
    op.alter_column('users', 'hashed_password', existing_type=sa.VARCHAR(length=255), nullable=False)
    op.drop_index('ix_users_clerk_user_id', table_name='users')
    op.drop_column('users', 'clerk_user_id')
