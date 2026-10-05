"""menu layer: modifiers, prep notes, allergens, meals, upsells, courses (docs/SPEC_MENU_MODIFIERS.md)

* `modifier_groups`, `modifier_options`, `modifier_links` — reusable modifier groups and
  which categories / products get them (a product's own list wins over its category's).
* `prep_note_presets` — quick note chips.
* `meal_slots`, `meal_slot_options` — a meal product's slots and their components.
* `upsell_rules`, `upsell_stats` — suggestions at the till, and the tills' daily counts.
* `menu_courses` — the courses a table's lines are fired in.
* `menu_sync_state` — when an organization's menu last changed (the delta catalog pull).
* `transaction_item_parts` — sold lines taken apart for the reports.
* `products.allergens`, `products.course_id`, `categories.course_id`,
  `transaction_items.details`, `transaction_items.upsell_rule_id`.

Guarded: the app's `create_all` may already have made the new tables, and a dev database
may already have a column from an earlier run of this revision.

Revision ID: e1a2b3c4d5e6
Revises: d81a2b3c4d5f
Create Date: 2026-10-04 07:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "e1a2b3c4d5e6"
down_revision = "d81a2b3c4d5f"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def _tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _now():
    return sa.text("now()")


def upgrade() -> None:
    tables = _tables()

    if "modifier_groups" not in tables:
        op.create_table(
            "modifier_groups",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", UUID, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False, server_default="addon"),
            sa.Column("min_select", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("max_select", sa.Integer(), nullable=True),
            sa.Column("free_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("allow_quantity", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("allow_pre", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.CheckConstraint("kind IN ('choice', 'addon', 'removal')", name="ck_modifier_groups_kind"),
            sa.CheckConstraint("min_select >= 0", name="ck_modifier_groups_min"),
        )
        op.create_index("ix_modifier_groups_tenant", "modifier_groups", ["tenant_id"])

    if "modifier_options" not in tables:
        op.create_table(
            "modifier_options",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("group_id", UUID, sa.ForeignKey("modifier_groups.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("kitchen_name", sa.String(60), nullable=True),
            sa.Column("price", sa.Numeric(10, 2), nullable=False, server_default="0"),
            sa.Column("is_default", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("allergens", sa.JSON(), nullable=True),
            sa.Column("linked_product_id", UUID, nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        )
        op.create_index("ix_modifier_options_group", "modifier_options", ["group_id"])

    if "modifier_links" not in tables:
        op.create_table(
            "modifier_links",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("target_type", sa.String(16), nullable=False),
            sa.Column("target_id", UUID, nullable=False),
            sa.Column("group_id", UUID, sa.ForeignKey("modifier_groups.id", ondelete="CASCADE"), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.CheckConstraint("target_type IN ('category', 'product')", name="ck_modifier_links_target_type"),
        )
        op.create_index("ix_modifier_links_target", "modifier_links", ["tenant_id", "target_type", "target_id"])
        op.create_index("ix_modifier_links_group", "modifier_links", ["group_id"])

    if "prep_note_presets" not in tables:
        op.create_table(
            "prep_note_presets",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", UUID, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("target_type", sa.String(16), nullable=False),
            sa.Column("target_id", UUID, nullable=True),
            sa.Column("text", sa.String(60), nullable=False),
            sa.Column("is_important", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.CheckConstraint(
                "target_type IN ('all', 'category', 'product')", name="ck_prep_note_presets_target_type"
            ),
        )
        op.create_index(
            "ix_prep_note_presets_tenant", "prep_note_presets", ["tenant_id", "target_type", "target_id"]
        )

    if "meal_slots" not in tables:
        op.create_table(
            "meal_slots",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("product_id", UUID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(60), nullable=False),
            sa.Column("min_select", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("max_select", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        )
        op.create_index("ix_meal_slots_product", "meal_slots", ["product_id"])

    if "meal_slot_options" not in tables:
        op.create_table(
            "meal_slot_options",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("slot_id", UUID, sa.ForeignKey("meal_slots.id", ondelete="CASCADE"), nullable=False),
            sa.Column("product_id", UUID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("upcharge", sa.Numeric(10, 2), nullable=False, server_default="0"),
            sa.Column("is_default", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        )
        op.create_index("ix_meal_slot_options_slot", "meal_slot_options", ["slot_id"])

    if "upsell_rules" not in tables:
        op.create_table(
            "upsell_rules",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", UUID, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("trigger_type", sa.String(16), nullable=False),
            sa.Column("trigger_ids", sa.JSON(), nullable=False),
            sa.Column("action", sa.String(16), nullable=False, server_default="add"),
            sa.Column("product_id", UUID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("message", sa.String(200), nullable=True),
            sa.Column("show_price", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("start_time", sa.String(5), nullable=True),
            sa.Column("end_time", sa.String(5), nullable=True),
            sa.Column("weekdays", sa.JSON(), nullable=True),
            sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.CheckConstraint("trigger_type IN ('product', 'category')", name="ck_upsell_rules_trigger_type"),
            sa.CheckConstraint("action IN ('add', 'upgrade')", name="ck_upsell_rules_action"),
        )
        op.create_index("ix_upsell_rules_tenant", "upsell_rules", ["tenant_id"])

    if "upsell_stats" not in tables:
        op.create_table(
            "upsell_stats",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("shop_id", UUID, nullable=True),
            sa.Column("rule_id", UUID, nullable=False),
            sa.Column("day", sa.Date(), nullable=False),
            sa.Column("shown", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("accepted", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("dismissed", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
            sa.UniqueConstraint("machine_id", "rule_id", "day", name="uq_upsell_stats_machine_rule_day"),
        )
        op.create_index("ix_upsell_stats_tenant_day", "upsell_stats", ["tenant_id", "day"])

    if "menu_courses" not in tables:
        op.create_table(
            "menu_courses",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", UUID, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("name", sa.String(60), nullable=False),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        )
        op.create_index("ix_menu_courses_tenant", "menu_courses", ["tenant_id"])

    if "menu_sync_state" not in tables:
        op.create_table(
            "menu_sync_state",
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        )

    if "transaction_item_parts" not in tables:
        op.create_table(
            "transaction_item_parts",
            sa.Column("id", UUID, primary_key=True),
            sa.Column(
                "transaction_id", UUID, sa.ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("item_id", UUID, nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("component_index", sa.Integer(), nullable=True),
            sa.Column("product_id", UUID, nullable=True),
            sa.Column("base_product_id", UUID, nullable=True),
            sa.Column("group_id", UUID, nullable=True),
            sa.Column("group_name", sa.String(100), nullable=True),
            sa.Column("option_id", UUID, nullable=True),
            sa.Column("name", sa.String(255), nullable=True),
            sa.Column("modifier_kind", sa.String(16), nullable=True),
            sa.Column("pre", sa.String(16), nullable=True),
            sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
            sa.Column("unit_price", sa.Numeric(12, 2), nullable=True),
            sa.Column("gross", sa.Numeric(12, 2), nullable=False),
            sa.Column("discount", sa.Numeric(12, 2), nullable=True),
            sa.CheckConstraint("kind IN ('component', 'modifier')", name="ck_transaction_item_parts_kind"),
        )
        op.create_index("ix_transaction_item_parts_transaction", "transaction_item_parts", ["transaction_id"])
        op.create_index("ix_transaction_item_parts_item", "transaction_item_parts", ["item_id"])
        op.create_index("ix_transaction_item_parts_product", "transaction_item_parts", ["product_id"])
        op.create_index("ix_transaction_item_parts_option", "transaction_item_parts", ["option_id"])

    products = _columns("products")
    if "allergens" not in products:
        op.add_column("products", sa.Column("allergens", sa.JSON(), nullable=True))
    if "course_id" not in products:
        op.add_column("products", sa.Column("course_id", UUID, nullable=True))
    if "course_id" not in _columns("categories"):
        op.add_column("categories", sa.Column("course_id", UUID, nullable=True))
    items = _columns("transaction_items")
    if "details" not in items:
        op.add_column("transaction_items", sa.Column("details", sa.JSON(), nullable=True))
    if "upsell_rule_id" not in items:
        op.add_column("transaction_items", sa.Column("upsell_rule_id", UUID, nullable=True))


def downgrade() -> None:
    op.drop_column("transaction_items", "upsell_rule_id")
    op.drop_column("transaction_items", "details")
    op.drop_column("categories", "course_id")
    op.drop_column("products", "course_id")
    op.drop_column("products", "allergens")
    for name in (
        "transaction_item_parts", "menu_sync_state", "menu_courses", "upsell_stats", "upsell_rules",
        "meal_slot_options", "meal_slots", "prep_note_presets", "modifier_links", "modifier_options",
        "modifier_groups",
    ):
        op.drop_table(name)
