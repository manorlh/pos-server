"""add is_open_price to products

Revision ID: j6k7l8m9n0o1
Revises: i5j6k7l8m9n0
Create Date: 2026-08-26 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "j6k7l8m9n0o1"
down_revision = "i5j6k7l8m9n0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    product_cols = {c["name"] for c in sa.inspect(bind).get_columns("products")}
    if "is_open_price" not in product_cols:
        op.add_column(
            "products",
            sa.Column(
                "is_open_price",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )


def downgrade() -> None:
    op.drop_column("products", "is_open_price")
