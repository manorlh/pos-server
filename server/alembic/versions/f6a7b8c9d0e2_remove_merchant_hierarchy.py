"""remove merchant hierarchy

Revision ID: f6a7b8c9d0e2
Revises: e5f6a7b8c9d1
Create Date: 2026-06-20 12:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "f6a7b8c9d0e2"
down_revision = "e5f6a7b8c9d1"
branch_labels = None
depends_on = None

_MERCHANT_TABLES = (
    "users",
    "companies",
    "products",
    "categories",
    "pos_machines",
    "transactions",
    "trading_days",
    "z_reports",
    "pos_users",
    "pairing_codes",
)


def _drop_merchant_fk(table: str) -> None:
    op.execute(
        sa.text(
            f"""
            DO $$ DECLARE r record;
            BEGIN
                FOR r IN (
                    SELECT con.conname
                    FROM pg_constraint con
                    JOIN pg_class rel ON rel.oid = con.conrelid
                    JOIN pg_attribute att ON att.attrelid = con.conrelid
                        AND att.attnum = ANY(con.conkey)
                    WHERE rel.relname = '{table}'
                      AND att.attname = 'merchant_id'
                      AND con.contype = 'f'
                ) LOOP
                    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', '{table}', r.conname);
                END LOOP;
            END $$;
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            DO $$ DECLARE r record;
            BEGIN
                FOR r IN (
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = '{table}'
                      AND indexdef ILIKE '%merchant_id%'
                ) LOOP
                    EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
                END LOOP;
            END $$;
            """
        )
    )
    op.drop_column(table, "merchant_id")


def upgrade() -> None:
    # Re-home merchant_admin users under their merchant's first company.
    op.execute(
        sa.text(
            """
            UPDATE users u
            SET role = 'company_manager',
                company_id = COALESCE(
                    u.company_id,
                    (
                        SELECT c.id FROM companies c
                        WHERE c.merchant_id = u.merchant_id
                        ORDER BY c.created_at ASC
                        LIMIT 1
                    )
                )
            WHERE u.role = 'merchant_admin'
            """
        )
    )

    # Tenant-local SKU sequences: collapse per-merchant rows into per-tenant.
    conn = op.get_bind()
    local_exists = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = 'tenant_local_sku_sequences'"
        )
    ).scalar()

    if local_exists:
        op.execute(
            sa.text(
                """
                INSERT INTO tenant_local_sku_sequences (tenant_id, next_value)
                SELECT m.tenant_id, MAX(mss.next_value)
                FROM merchant_sku_sequences mss
                JOIN merchants m ON m.id = mss.merchant_id
                WHERE m.tenant_id IS NOT NULL
                GROUP BY m.tenant_id
                ON CONFLICT (tenant_id) DO UPDATE
                SET next_value = GREATEST(
                    tenant_local_sku_sequences.next_value,
                    EXCLUDED.next_value
                )
                """
            )
        )
        op.drop_table("merchant_sku_sequences")
    else:
        op.add_column(
            "merchant_sku_sequences",
            sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=True),
        )
        op.execute(
            sa.text(
                """
                UPDATE merchant_sku_sequences mss
                SET tenant_id = m.tenant_id
                FROM merchants m
                WHERE m.id = mss.merchant_id
                """
            )
        )
        op.execute(
            sa.text(
                """
                DELETE FROM merchant_sku_sequences a
                USING merchant_sku_sequences b
                WHERE a.tenant_id = b.tenant_id
                  AND a.ctid < b.ctid
                """
            )
        )
        op.execute(
            sa.text(
                """
                UPDATE merchant_sku_sequences mss
                SET next_value = sub.max_next
                FROM (
                    SELECT tenant_id, MAX(next_value) AS max_next
                    FROM merchant_sku_sequences
                    GROUP BY tenant_id
                ) sub
                WHERE mss.tenant_id = sub.tenant_id
                """
            )
        )
        op.drop_constraint("merchant_sku_sequences_pkey", "merchant_sku_sequences", type_="primary")
        op.drop_column("merchant_sku_sequences", "merchant_id")
        op.alter_column("merchant_sku_sequences", "tenant_id", nullable=False)
        op.create_primary_key(
            "tenant_local_sku_sequences_pkey",
            "merchant_sku_sequences",
            ["tenant_id"],
        )
        op.rename_table("merchant_sku_sequences", "tenant_local_sku_sequences")

    op.drop_constraint("uq_product_sku_merchant", "products", type_="unique")
    op.create_unique_constraint("uq_product_sku_tenant", "products", ["tenant_id", "sku"])

    for table in _MERCHANT_TABLES:
        _drop_merchant_fk(table)

    op.drop_table("merchants")


def downgrade() -> None:
    raise NotImplementedError("Merchant hierarchy removal is not reversible")
