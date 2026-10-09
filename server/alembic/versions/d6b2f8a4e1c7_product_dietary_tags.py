"""product dietary tags ("סימוני תזונה", docs/SPEC_PRODUCT_DIETARY.md)

* `products.dietary_tags` — JSON list of codes (vegan, vegetarian, dairy, meat,
  gluten_free, spicy), validated in app/services/dietary.py. Null: none, which is what
  every existing product is.

The product's `description` (String(1000)) already exists; nothing to change there.
Additive and guarded: the API's `create_all` may have added the column first.

Revision ID: d6b2f8a4e1c7
Revises: c4e8a2d6f0b3
Create Date: 2026-10-06 18:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "d6b2f8a4e1c7"
down_revision = "c4e8a2d6f0b3"
branch_labels = None
depends_on = None


def _existing_columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if "dietary_tags" not in _existing_columns("products"):
        op.add_column("products", sa.Column("dietary_tags", sa.JSON(), nullable=True))


def downgrade() -> None:
    if "dietary_tags" in _existing_columns("products"):
        op.drop_column("products", "dietary_tags")
