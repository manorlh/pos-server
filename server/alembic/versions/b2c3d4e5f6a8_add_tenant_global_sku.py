"""add tenant global_sku and tenant_sku_sequences

Revision ID: b2c3d4e5f6a8
Revises: a1b2c3d4e5f7
Create Date: 2026-05-30 16:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "b2c3d4e5f6a8"
down_revision = "a1b2c3d4e5f7"
branch_labels = None
depends_on = None

DEFAULT_START = 100001


def upgrade() -> None:
    op.create_table(
        "tenant_sku_sequences",
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), primary_key=True),
        sa.Column("next_value", sa.BigInteger(), nullable=False, server_default=str(DEFAULT_START)),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.add_column("products", sa.Column("global_sku", sa.String(100), nullable=True))
    op.create_index("ix_products_global_sku", "products", ["global_sku"])

    # Backfill global_sku on existing global catalog rows (ordered by created_at per tenant).
    op.execute(
        sa.text(
            """
            WITH numbered AS (
                SELECT
                    id,
                    tenant_id,
                    ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
                FROM products
                WHERE catalog_level = 'global'
                  AND tenant_id IS NOT NULL
            )
            UPDATE products p
            SET global_sku = (100000 + n.rn)::text
            FROM numbered n
            WHERE p.id = n.id
            """
        )
    )

    # Propagate global_sku to local copies from their global parent.
    op.execute(
        sa.text(
            """
            UPDATE products local
            SET global_sku = global.global_sku
            FROM products global
            WHERE local.global_product_id = global.id
              AND local.global_sku IS NULL
              AND global.global_sku IS NOT NULL
            """
        )
    )

    # Seed tenant sequences from max global_sku + 1 per tenant.
    op.execute(
        sa.text(
            """
            INSERT INTO tenant_sku_sequences (tenant_id, next_value, updated_at)
            SELECT
                t.id,
                COALESCE(
                    (
                        SELECT MAX(CAST(p.global_sku AS BIGINT)) + 1
                        FROM products p
                        WHERE p.tenant_id = t.id
                          AND p.global_sku ~ '^[0-9]+$'
                    ),
                    :default_start
                ),
                now()
            FROM tenants t
            """
        ).bindparams(default_start=DEFAULT_START)
    )

    op.create_index(
        "uq_product_global_sku_tenant_global",
        "products",
        ["tenant_id", "global_sku"],
        unique=True,
        postgresql_where=sa.text("catalog_level = 'global' AND global_sku IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_product_global_sku_tenant_global", table_name="products")
    op.drop_index("ix_products_global_sku", table_name="products")
    op.drop_column("products", "global_sku")
    op.drop_table("tenant_sku_sequences")
