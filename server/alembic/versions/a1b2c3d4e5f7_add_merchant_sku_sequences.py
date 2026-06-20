"""add merchant_sku_sequences and products.sku_auto_assigned

Revision ID: a1b2c3d4e5f7
Revises: f4a5b6c7d8e9
Create Date: 2026-05-30 14:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "a1b2c3d4e5f7"
down_revision = "f4a5b6c7d8e9"
branch_labels = None
depends_on = None

DEFAULT_START = 100001


def upgrade() -> None:
    op.create_table(
        "merchant_sku_sequences",
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), primary_key=True),
        sa.Column("next_value", sa.BigInteger(), nullable=False, server_default=str(DEFAULT_START)),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.add_column(
        "products",
        sa.Column("sku_auto_assigned", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )

    # Seed next_value per merchant from max purely-numeric sku + 1, else DEFAULT_START.
    op.execute(
        sa.text(
            """
            INSERT INTO merchant_sku_sequences (merchant_id, next_value, updated_at)
            SELECT
                m.id,
                COALESCE(
                    (
                        SELECT MAX(CAST(p.sku AS BIGINT)) + 1
                        FROM products p
                        WHERE p.merchant_id = m.id
                          AND p.sku ~ '^[0-9]+$'
                    ),
                    :default_start
                ),
                now()
            FROM merchants m
            """
        ).bindparams(default_start=DEFAULT_START)
    )


def downgrade() -> None:
    op.drop_column("products", "sku_auto_assigned")
    op.drop_table("merchant_sku_sequences")
