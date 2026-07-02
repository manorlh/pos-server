"""add vouchers and issued_vouchers

Revision ID: a8b9c0d1e2f3
Revises: f7a8b9c0d1e3
Create Date: 2026-06-26 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ENUM, UUID


revision = "a8b9c0d1e2f3"
down_revision = "f7a8b9c0d1e3"
branch_labels = None
depends_on = None

value_display_mode = ENUM(
    "product_price", "fixed", "none",
    name="valuedisplaymode",
    create_type=False,
)
issued_voucher_status = ENUM(
    "issued", "voided", "redeemed",
    name="issuedvoucherstatus",
    create_type=False,
)


def upgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE valuedisplaymode AS ENUM ('product_price', 'fixed', 'none');
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
        """
    )
    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE issuedvoucherstatus AS ENUM ('issued', 'voided', 'redeemed');
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
        """
    )

    op.create_table(
        "vouchers",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("subtitle", sa.String(500), nullable=True),
        sa.Column("body_text", sa.Text(), nullable=True),
        sa.Column("footer_text", sa.String(500), nullable=True),
        sa.Column("validity_days", sa.Integer(), nullable=True),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "value_display_mode",
            value_display_mode,
            nullable=False,
            server_default="product_price",
        ),
        sa.Column("display_value", sa.Numeric(12, 2), nullable=True),
        sa.Column("print_barcode", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("print_qr", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("language", sa.String(5), nullable=True, server_default="he"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_vouchers_tenant_id", "vouchers", ["tenant_id"])

    op.add_column(
        "products",
        sa.Column("voucher_id", UUID(as_uuid=True), sa.ForeignKey("vouchers.id"), nullable=True),
    )
    op.create_index("ix_products_voucher_id", "products", ["voucher_id"])

    op.create_table(
        "issued_vouchers",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=True),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=True),
        sa.Column(
            "transaction_id",
            UUID(as_uuid=True),
            sa.ForeignKey("transactions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("transaction_item_id", UUID(as_uuid=True), nullable=True),
        sa.Column("voucher_id", UUID(as_uuid=True), sa.ForeignKey("vouchers.id"), nullable=True),
        sa.Column("product_id", UUID(as_uuid=True), sa.ForeignKey("products.id"), nullable=True),
        sa.Column("product_name", sa.String(255), nullable=True),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False, server_default="1"),
        sa.Column("unit_value", sa.Numeric(12, 2), nullable=True),
        sa.Column("face_value", sa.Numeric(12, 2), nullable=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status",
            issued_voucher_status,
            nullable=False,
            server_default="issued",
        ),
        sa.Column("reprint_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_printed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_issued_vouchers_transaction", "issued_vouchers", ["transaction_id"])
    op.create_index("ix_issued_vouchers_tenant", "issued_vouchers", ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_issued_vouchers_tenant", table_name="issued_vouchers")
    op.drop_index("ix_issued_vouchers_transaction", table_name="issued_vouchers")
    op.drop_table("issued_vouchers")
    op.drop_index("ix_products_voucher_id", table_name="products")
    op.drop_column("products", "voucher_id")
    op.drop_index("ix_vouchers_tenant_id", table_name="vouchers")
    op.drop_table("vouchers")
    op.execute("DROP TYPE IF EXISTS issuedvoucherstatus")
    op.execute("DROP TYPE IF EXISTS valuedisplaymode")
