"""add shop-level inventory: track_stock, stock_levels, stock_movements

Revision ID: e1f2a3b4c5d6
Revises: c0d1e2f3a4b5
Create Date: 2026-06-27 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, ENUM


revision = "e1f2a3b4c5d6"
down_revision = "c0d1e2f3a4b5"
branch_labels = None
depends_on = None

# create_type=False: we create/drop the enum explicitly with checkfirst below.
# Otherwise create_table() would auto-emit a second CREATE TYPE (without
# checkfirst) and fail with "type already exists".
stock_movement_reason = ENUM(
    "sale",
    "refund",
    "goods_receipt",
    "adjustment",
    "stocktake",
    "wastage",
    name="stockmovementreason",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    product_cols = {c["name"] for c in insp.get_columns("products")}
    if "track_stock" not in product_cols:
        op.add_column(
            "products",
            sa.Column("track_stock", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )

    if "stock_levels" not in insp.get_table_names():
        op.create_table(
            "stock_levels",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=False),
            sa.Column("product_id", UUID(as_uuid=True), sa.ForeignKey("products.id"), nullable=False),
            sa.Column("quantity", sa.Numeric(12, 3), nullable=False, server_default="0"),
            sa.Column("reorder_min", sa.Integer(), nullable=True),
            sa.Column("reorder_max", sa.Integer(), nullable=True),
            sa.Column("reorder_opt", sa.Integer(), nullable=True),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
            sa.UniqueConstraint("shop_id", "product_id", name="uq_stock_level_shop_product"),
        )
        op.create_index("ix_stock_levels_tenant_id", "stock_levels", ["tenant_id"])
        op.create_index("ix_stock_levels_shop_id", "stock_levels", ["shop_id"])
        op.create_index("ix_stock_levels_product_id", "stock_levels", ["product_id"])

    stock_movement_reason.create(bind, checkfirst=True)
    if "stock_movements" not in insp.get_table_names():
        op.create_table(
            "stock_movements",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=False),
            sa.Column("product_id", UUID(as_uuid=True), sa.ForeignKey("products.id"), nullable=False),
            sa.Column("delta", sa.Numeric(12, 3), nullable=False),
            sa.Column("reason", stock_movement_reason, nullable=False),
            sa.Column("transaction_id", UUID(as_uuid=True), sa.ForeignKey("transactions.id"), nullable=True),
            sa.Column("transaction_item_id", UUID(as_uuid=True), nullable=True),
            sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=True),
            sa.Column("created_by_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
        )
        op.create_index("ix_stock_movements_tenant_id", "stock_movements", ["tenant_id"])
        op.create_index("ix_stock_movements_shop_id", "stock_movements", ["shop_id"])
        op.create_index("ix_stock_movements_product_id", "stock_movements", ["product_id"])
        op.create_index("ix_stock_movements_transaction_id", "stock_movements", ["transaction_id"])
        op.create_index("ix_stock_movements_machine_id", "stock_movements", ["machine_id"])
        op.create_index("ix_stock_movements_shop_created", "stock_movements", ["shop_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_stock_movements_shop_created", table_name="stock_movements")
    op.drop_index("ix_stock_movements_machine_id", table_name="stock_movements")
    op.drop_index("ix_stock_movements_transaction_id", table_name="stock_movements")
    op.drop_index("ix_stock_movements_product_id", table_name="stock_movements")
    op.drop_index("ix_stock_movements_shop_id", table_name="stock_movements")
    op.drop_index("ix_stock_movements_tenant_id", table_name="stock_movements")
    op.drop_table("stock_movements")
    stock_movement_reason.drop(op.get_bind(), checkfirst=True)

    op.drop_index("ix_stock_levels_product_id", table_name="stock_levels")
    op.drop_index("ix_stock_levels_shop_id", table_name="stock_levels")
    op.drop_index("ix_stock_levels_tenant_id", table_name="stock_levels")
    op.drop_table("stock_levels")

    op.drop_column("products", "track_stock")
