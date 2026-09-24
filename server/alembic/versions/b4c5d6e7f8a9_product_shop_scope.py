"""where a product is sold: a shop-scope rule on the product, and a rule marker on its rows

Additive only. Every existing row keeps behaving exactly as it does today.

`products.shop_scope_mode` — null (managed by hand from the assortment page, which is
every product that exists today), `company` (a rule: "every shop of company X",
optionally with its sub-companies) or `shops` (an explicit list). A plain string, not a
Postgres enum: the app validates it, and an enum type would make a third mode a
migration with a lock instead of a code change.

`products.shop_scope_company_id` / `products.shop_scope_include_subcompanies` — the
rule's company and whether it reaches down the company tree. `ON DELETE SET NULL` on
the FK so a product scoped to a company it does not itself belong to (a tenant-wide
product scoped to one company) never blocks deleting that company; a `company` rule
with no company simply covers no shops.

`shop_product_overrides.assigned_by_rule` — marks the rows the product's scope created,
so the scope only ever touches its own rows. `false` on every existing row, which is
the truth: all of them were added by hand.

The index on `shop_scope_company_id` serves the hooks that run when a shop is created
or a company moves ("which products' rules cover this company?").

Revision ID: b4c5d6e7f8a9
Revises: a3b4c5d6e7f8
Create Date: 2026-09-25 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "b4c5d6e7f8a9"
down_revision = "a3b4c5d6e7f8"
branch_labels = None
depends_on = None


_FK = "fk_products_shop_scope_company_id_companies"
_IX = "ix_products_shop_scope_company_id"


def upgrade() -> None:
    op.add_column("products", sa.Column("shop_scope_mode", sa.String(16), nullable=True))
    op.add_column(
        "products",
        sa.Column("shop_scope_company_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        _FK, "products", "companies", ["shop_scope_company_id"], ["id"], ondelete="SET NULL"
    )
    op.create_index(_IX, "products", ["shop_scope_company_id"])
    op.add_column(
        "products",
        sa.Column(
            "shop_scope_include_subcompanies",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "shop_product_overrides",
        sa.Column(
            "assigned_by_rule",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("shop_product_overrides", "assigned_by_rule")
    op.drop_column("products", "shop_scope_include_subcompanies")
    op.drop_index(_IX, table_name="products")
    op.drop_constraint(_FK, "products", type_="foreignkey")
    op.drop_column("products", "shop_scope_company_id")
    op.drop_column("products", "shop_scope_mode")
