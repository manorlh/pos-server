"""Table policies ("סוגי שולחנות") and staff / managers' meals on the sale

Revision ID: f3a9c1e7b5d2
Revises: e5b7d9f1a3c8
Create Date: 2026-10-07

app/services/table_policies.py:

* `table_types` — a policy reusable across a shop's tables: kind (regular / staff /
  managers), discount %, a manager's approval, a reason, the staff meal's mode.
* `dining_tables.kind`, `.discount_percent`, `.type_id` — a table's own policy, or its type.
* `transactions.meal_kind`, `.meal_employee_id`, `.meal_employee_name`, `.meal_reason` — a
  staff or managers' meal, whose and why (the meals report).

Idempotent: the auto-reloading dev API runs `create_all` at startup and may have made the
table (and, on a fresh database, the columns) before this runs — only what is missing is added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f3a9c1e7b5d2"
down_revision: Union[str, Sequence[str], None] = "e5b7d9f1a3c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TYPES = "table_types"


def _columns(inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    uuid = postgresql.UUID(as_uuid=True)
    if not inspector.has_table(TYPES):
        op.create_table(
            TYPES,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(60), nullable=False),
            sa.Column("kind", sa.String(12), nullable=False, server_default="regular"),
            sa.Column("discount_percent", sa.Numeric(5, 2), nullable=False, server_default="0"),
            sa.Column("require_approval", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("require_reason", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("staff_mode", sa.String(12), nullable=False, server_default="percent"),
            sa.Column("staff_allowance", sa.Numeric(12, 2), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("kind IN ('regular', 'staff', 'managers')", name="ck_table_types_kind"),
            sa.CheckConstraint(
                "discount_percent >= 0 AND discount_percent <= 100", name="ck_table_types_discount",
            ),
        )
        inspector = sa.inspect(bind)
    indexes = {i["name"] for i in inspector.get_indexes(TYPES)}
    if "ix_table_types_shop" not in indexes:
        op.create_index("ix_table_types_shop", TYPES, ["shop_id"])
    if "ix_table_types_tenant_id" not in indexes:
        op.create_index("ix_table_types_tenant_id", TYPES, ["tenant_id"])

    have = _columns(inspector, "dining_tables")
    if "kind" not in have:
        op.add_column("dining_tables", sa.Column("kind", sa.String(12), nullable=False, server_default="regular"))
    if "discount_percent" not in have:
        op.add_column("dining_tables", sa.Column("discount_percent", sa.Numeric(5, 2), nullable=True))
    if "type_id" not in have:
        op.add_column("dining_tables", sa.Column("type_id", uuid, nullable=True))
        op.create_foreign_key(
            "fk_dining_tables_type_id", "dining_tables", TYPES, ["type_id"], ["id"], ondelete="SET NULL",
        )

    have = _columns(inspector, "transactions")
    for name, column in (
        ("meal_kind", sa.String(16)),
        ("meal_employee_id", sa.String(100)),
        ("meal_employee_name", sa.String(200)),
        ("meal_reason", sa.String(300)),
    ):
        if name not in have:
            op.add_column("transactions", sa.Column(name, column, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    have = _columns(inspector, "transactions")
    for name in ("meal_reason", "meal_employee_name", "meal_employee_id", "meal_kind"):
        if name in have:
            op.drop_column("transactions", name)
    have = _columns(inspector, "dining_tables")
    if "type_id" in have:
        fks = {fk["name"] for fk in inspector.get_foreign_keys("dining_tables")}
        if "fk_dining_tables_type_id" in fks:
            op.drop_constraint("fk_dining_tables_type_id", "dining_tables", type_="foreignkey")
        op.drop_column("dining_tables", "type_id")
    for name in ("discount_percent", "kind"):
        if name in have:
            op.drop_column("dining_tables", name)
    if inspector.has_table(TYPES):
        op.drop_table(TYPES)
