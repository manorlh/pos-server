"""menu: per-option limits, meal slot quantities / repeats / deferred items / refills, product order limits

docs/SPEC_MENU_MODIFIERS.md §3.9:

* `modifier_options.max_qty` — the most of one option in a dish ("ביצים" up to 3).
* `meal_slots.quantity`, `allow_repeat`, `deferred`, `refillable`, `max_refills` — how many
  items a meal's slot includes, whether the same product may fill two of them, whether
  what is not chosen at the order can be taken later, and refills.
* `products.max_per_order`, `refillable`, `max_refills`.

Guarded: a dev database may already have a column from an earlier run of this revision.

Revision ID: f6c9e1a2b3d4
Revises: f5b8d3e0c2a4
Create Date: 2026-10-04 08:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "f6c9e1a2b3d4"
down_revision = "f5b8d3e0c2a4"
branch_labels = None
depends_on = None


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if "max_qty" not in _columns("modifier_options"):
        op.add_column("modifier_options", sa.Column("max_qty", sa.Integer(), nullable=True))

    slots = _columns("meal_slots")
    if "quantity" not in slots:
        op.add_column("meal_slots", sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"))
    if "allow_repeat" not in slots:
        op.add_column("meal_slots", sa.Column("allow_repeat", sa.Boolean(), nullable=False, server_default="false"))
    if "deferred" not in slots:
        op.add_column("meal_slots", sa.Column("deferred", sa.Boolean(), nullable=False, server_default="false"))
    if "refillable" not in slots:
        op.add_column("meal_slots", sa.Column("refillable", sa.Boolean(), nullable=False, server_default="false"))
    if "max_refills" not in slots:
        op.add_column("meal_slots", sa.Column("max_refills", sa.Integer(), nullable=True))

    products = _columns("products")
    if "max_per_order" not in products:
        op.add_column("products", sa.Column("max_per_order", sa.Integer(), nullable=True))
    if "refillable" not in products:
        op.add_column("products", sa.Column("refillable", sa.Boolean(), nullable=False, server_default="false"))
    if "max_refills" not in products:
        op.add_column("products", sa.Column("max_refills", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("products", "max_refills")
    op.drop_column("products", "refillable")
    op.drop_column("products", "max_per_order")
    op.drop_column("meal_slots", "max_refills")
    op.drop_column("meal_slots", "refillable")
    op.drop_column("meal_slots", "deferred")
    op.drop_column("meal_slots", "allow_repeat")
    op.drop_column("meal_slots", "quantity")
    op.drop_column("modifier_options", "max_qty")
