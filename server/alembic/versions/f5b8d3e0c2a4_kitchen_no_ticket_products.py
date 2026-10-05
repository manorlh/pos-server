"""kitchen printers: "ללא בון" on the product itself, for every shop

* `kitchen_no_ticket_products` — a product listed here prints on no kitchen / bar printer
  in any shop, whatever its category says. One row per product; deleting it sends the
  product back to its category.

Guarded: the app's `create_all` may already have made the table from the model.

Revision ID: f5b8d3e0c2a4
Revises: f4a7c2e9b1d3
Create Date: 2026-10-04 07:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f5b8d3e0c2a4"
down_revision = "f4a7c2e9b1d3"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def _tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _indexes(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    if "kitchen_no_ticket_products" not in _tables():
        op.create_table(
            "kitchen_no_ticket_products",
            sa.Column("product_id", UUID, sa.ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column(
                "created_by_user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
            ),
            sa.Column(
                "created_by_machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True
            ),
        )
    if "ix_kitchen_no_ticket_products_tenant_id" not in _indexes("kitchen_no_ticket_products"):
        op.create_index(
            "ix_kitchen_no_ticket_products_tenant_id", "kitchen_no_ticket_products", ["tenant_id"]
        )


def downgrade() -> None:
    op.drop_index("ix_kitchen_no_ticket_products_tenant_id", table_name="kitchen_no_ticket_products")
    op.drop_table("kitchen_no_ticket_products")
