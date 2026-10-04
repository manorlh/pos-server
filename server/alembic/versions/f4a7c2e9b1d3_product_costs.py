"""product costs for the insights' menu engineering ("עלות ליחידה")

* `product_costs` — one row per tenant and global product: what a unit costs the business,
  excluding VAT. Read by the insights (contribution margin, food cost %); never synced to
  the tills. See app/models/product_cost.py and docs/SPEC_INSIGHTS.md.

Guarded like the other recent revisions: the app's `create_all` may already have made
the table from the model, so only what is missing is created.

Revision ID: f4a7c2e9b1d3
Revises: e1a2b3c4d5e6
Create Date: 2026-10-04 03:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f4a7c2e9b1d3"
down_revision = "e1a2b3c4d5e6"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def _existing_tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _existing_indexes(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    if "product_costs" not in _existing_tables():
        op.create_table(
            "product_costs",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("product_id", UUID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("cost", sa.Numeric(10, 2), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_by_user_id", UUID, sa.ForeignKey("users.id"), nullable=True),
            sa.UniqueConstraint("tenant_id", "product_id", name="uq_product_costs_tenant_product"),
        )
    indexes = _existing_indexes("product_costs")
    if "ix_product_costs_tenant_id" not in indexes:
        op.create_index("ix_product_costs_tenant_id", "product_costs", ["tenant_id"])
    if "ix_product_costs_product_id" not in indexes:
        op.create_index("ix_product_costs_product_id", "product_costs", ["product_id"])


def downgrade() -> None:
    if "product_costs" in _existing_tables():
        op.drop_table("product_costs")
