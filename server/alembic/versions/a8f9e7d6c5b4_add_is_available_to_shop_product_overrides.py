"""add is_available to shop_product_overrides (per-shop sale availability)

Revision ID: a8f9e7d6c5b4
Revises: f3e4a5b6c7d8
Create Date: 2026-05-02

"""

from alembic import op
import sqlalchemy as sa


revision = "a8f9e7d6c5b4"
down_revision = "f3e4a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "shop_product_overrides",
        sa.Column("is_available", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.alter_column("shop_product_overrides", "is_available", server_default=None)


def downgrade() -> None:
    op.drop_column("shop_product_overrides", "is_available")
