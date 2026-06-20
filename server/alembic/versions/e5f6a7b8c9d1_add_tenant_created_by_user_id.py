"""add tenant created_by_user_id

Revision ID: e5f6a7b8c9d1
Revises: d4e5f6a7b8c0
Create Date: 2026-06-20 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "e5f6a7b8c9d1"
down_revision = "d4e5f6a7b8c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("created_by_user_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_tenants_created_by_user_id",
        "tenants",
        "users",
        ["created_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_tenants_created_by_user_id", "tenants", ["created_by_user_id"])


def downgrade() -> None:
    op.drop_index("ix_tenants_created_by_user_id", table_name="tenants")
    op.drop_constraint("fk_tenants_created_by_user_id", "tenants", type_="foreignkey")
    op.drop_column("tenants", "created_by_user_id")
