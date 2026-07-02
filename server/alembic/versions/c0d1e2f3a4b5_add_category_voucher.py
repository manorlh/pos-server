"""add voucher_id to categories

Revision ID: c0d1e2f3a4b5
Revises: b9c0d1e2f3a4
Create Date: 2026-06-27 10:40:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "c0d1e2f3a4b5"
down_revision = "b9c0d1e2f3a4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "categories",
        sa.Column("voucher_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        "ix_categories_voucher_id", "categories", ["voucher_id"], unique=False
    )
    op.create_foreign_key(
        "fk_categories_voucher_id_vouchers",
        "categories",
        "vouchers",
        ["voucher_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_categories_voucher_id_vouchers", "categories", type_="foreignkey"
    )
    op.drop_index("ix_categories_voucher_id", table_name="categories")
    op.drop_column("categories", "voucher_id")
