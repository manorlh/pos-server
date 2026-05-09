"""add_shop_product_overrides

Revision ID: a1b2c3d4e5f6
Revises: 7357a82ef962
Create Date: 2026-04-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "7357a82ef962"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "shop_product_overrides",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("shop_id", sa.UUID(), nullable=False),
        sa.Column("global_product_id", sa.UUID(), nullable=False),
        sa.Column("price", sa.Numeric(10, 2), nullable=True),
        sa.Column("is_listed", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["global_product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["shop_id"], ["shops.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("shop_id", "global_product_id", name="uq_shop_product_override"),
    )
    op.create_index(
        op.f("ix_shop_product_overrides_global_product_id"),
        "shop_product_overrides",
        ["global_product_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_shop_product_overrides_shop_id"),
        "shop_product_overrides",
        ["shop_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_shop_product_overrides_shop_id"), table_name="shop_product_overrides")
    op.drop_index(op.f("ix_shop_product_overrides_global_product_id"), table_name="shop_product_overrides")
    op.drop_table("shop_product_overrides")
