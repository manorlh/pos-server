"""initial_schema_v2

Revision ID: 21c770e570fd
Revises:
Create Date: 2026-03-28

Full schema — users, merchants, companies, shops, pos_machines,
pairing_codes, categories, products, sync_logs
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB

revision: str = "21c770e570fd"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── users ──────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("username", sa.String(100), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column(
            "role",
            sa.Enum(
                "super_admin", "distributor", "merchant_admin",
                "company_manager", "shop_manager", "cashier",
                name="userrole",
            ),
            nullable=False,
            server_default="cashier",
        ),
        sa.Column("merchant_id", UUID(as_uuid=True), nullable=True),
        sa.Column("company_id", UUID(as_uuid=True), nullable=True),
        sa.Column("shop_id", UUID(as_uuid=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("username", name="uq_users_username"),
    )
    op.create_index("ix_users_email", "users", ["email"])
    op.create_index("ix_users_username", "users", ["username"])

    # ── merchants ──────────────────────────────────────────────────────────
    op.create_table(
        "merchants",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("distributor_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # ── companies ─────────────────────────────────────────────────────────
    op.create_table(
        "companies",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("vat_number", sa.String(20), nullable=True),
        sa.Column("address", sa.String(500), nullable=True),
        sa.Column("city", sa.String(100), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_companies_merchant_id", "companies", ["merchant_id"])

    # ── shops ──────────────────────────────────────────────────────────────
    op.create_table(
        "shops",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("branch_id", sa.String(50), nullable=True),
        sa.Column("address", sa.String(500), nullable=True),
        sa.Column("city", sa.String(100), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_shops_company_id", "shops", ["company_id"])

    # Add deferred FKs to users now that merchants/companies/shops exist
    op.create_foreign_key("fk_users_merchant", "users", "merchants", ["merchant_id"], ["id"])
    op.create_foreign_key("fk_users_company", "users", "companies", ["company_id"], ["id"])
    op.create_foreign_key("fk_users_shop", "users", "shops", ["shop_id"], ["id"])

    # ── pos_machines ───────────────────────────────────────────────────────
    op.create_table(
        "pos_machines",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), nullable=True),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("distributor_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("machine_code", sa.String(100), nullable=False),
        sa.Column("mqtt_client_id", sa.String(255), nullable=True),
        sa.Column(
            "pairing_status",
            sa.Enum("unpaired", "paired", "assigned", name="pairingstatus"),
            nullable=False,
            server_default="unpaired",
        ),
        sa.Column("device_info", JSONB, nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("machine_code", name="uq_pos_machines_code"),
        sa.UniqueConstraint("mqtt_client_id", name="uq_pos_machines_mqtt"),
    )
    op.create_index("ix_pos_machines_machine_code", "pos_machines", ["machine_code"])
    op.create_index("ix_pos_machines_shop_id", "pos_machines", ["shop_id"])

    # ── pairing_codes ──────────────────────────────────────────────────────
    op.create_table(
        "pairing_codes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("distributor_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("pos_machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_used", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("code", name="uq_pairing_codes_code"),
    )
    op.create_index("ix_pairing_codes_code", "pairing_codes", ["code"])

    # ── categories ─────────────────────────────────────────────────────────
    op.create_table(
        "categories",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), nullable=False),
        sa.Column("company_id", UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=True),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("pos_machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=True),
        sa.Column(
            "catalog_level",
            sa.Enum("global", "local", name="categorycataloglevel"),
            nullable=False,
            server_default="global",
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("color", sa.String(7), nullable=True),
        sa.Column("image_url", sa.String(500), nullable=True),
        sa.Column("parent_id", UUID(as_uuid=True), sa.ForeignKey("categories.id"), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_categories_merchant_id", "categories", ["merchant_id"])
    op.create_index("ix_categories_company_id", "categories", ["company_id"])
    op.create_index("ix_categories_shop_id", "categories", ["shop_id"])

    # ── products ───────────────────────────────────────────────────────────
    op.create_table(
        "products",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), nullable=False),
        sa.Column("company_id", UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=True),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("pos_machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=True),
        sa.Column("category_id", UUID(as_uuid=True), sa.ForeignKey("categories.id"), nullable=False),
        sa.Column("global_product_id", UUID(as_uuid=True), sa.ForeignKey("products.id"), nullable=True),
        sa.Column(
            "catalog_level",
            sa.Enum("global", "local", name="productcataloglevel"),
            nullable=False,
            server_default="global",
        ),
        sa.Column("is_local_override", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("price", sa.Numeric(10, 2), nullable=False),
        sa.Column("sku", sa.String(100), nullable=False),
        sa.Column("image_url", sa.String(500), nullable=True),
        sa.Column("in_stock", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("stock_quantity", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("barcode", sa.String(100), nullable=True),
        sa.Column("tax_rate", sa.Numeric(5, 2), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("merchant_id", "sku", name="uq_product_sku_merchant"),
    )
    op.create_index("ix_products_merchant_id", "products", ["merchant_id"])
    op.create_index("ix_products_company_id", "products", ["company_id"])
    op.create_index("ix_products_shop_id", "products", ["shop_id"])
    op.create_index("ix_products_sku", "products", ["sku"])

    # ── sync_logs ──────────────────────────────────────────────────────────
    op.create_table(
        "sync_logs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column(
            "direction",
            sa.Enum("server_to_pos", "pos_to_server", name="syncdirection"),
            nullable=False,
        ),
        sa.Column(
            "entity_type",
            sa.Enum("products", "categories", "transactions", "z_report", name="syncentitytype"),
            nullable=False,
        ),
        sa.Column("entity_id", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "action",
            sa.Enum("create", "update", "delete", "full_sync", name="syncaction"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Enum("success", "failed", "conflict_resolved", name="syncstatus"),
            nullable=False,
            server_default="success",
        ),
        sa.Column("conflict_note", sa.Text(), nullable=True),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_sync_logs_machine_id", "sync_logs", ["machine_id"])


def downgrade() -> None:
    op.drop_table("sync_logs")
    op.drop_table("products")
    op.drop_table("categories")
    op.drop_table("pairing_codes")
    op.drop_table("pos_machines")
    op.drop_constraint("fk_users_merchant", "users", type_="foreignkey")
    op.drop_constraint("fk_users_company", "users", type_="foreignkey")
    op.drop_constraint("fk_users_shop", "users", type_="foreignkey")
    op.drop_table("shops")
    op.drop_table("companies")
    op.drop_table("merchants")
    op.drop_table("users")
    for t in ("userrole", "pairingstatus", "categorycataloglevel",
              "productcataloglevel", "syncdirection", "syncentitytype",
              "syncaction", "syncstatus"):
        op.execute(f"DROP TYPE IF EXISTS {t}")
