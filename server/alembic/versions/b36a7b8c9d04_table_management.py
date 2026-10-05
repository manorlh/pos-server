"""table management ("ניהול שולחנות"): zones, tables, open orders, cancellation reasons

* `table_zones` — a shop's floor areas (optionally one point of sale's), map or grid.
* `dining_tables` — the tables, unique number per shop among live ones, and the synced
  mode's lock (till, employee, expiry).
* `table_orders` — a table's order from opening to payment / cancellation, versioned;
  one synced open order per table (partial unique index).
* `table_events` — what happened to each order.
* `table_cancel_reasons` — the tenant's cancellation reasons.

Guarded like the other recent revisions: the app's `create_all` may already have made
the tables from the models, so only what is missing is created.

Revision ID: b36a7b8c9d04
Revises: b25f6a7b8c93
Create Date: 2026-10-04 03:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "b36a7b8c9d04"
down_revision = "b25f6a7b8c93"
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


def _ts(name: str, nullable: bool = True, default: bool = False) -> sa.Column:
    if default:
        return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable, server_default=sa.func.now())
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    tables = _existing_tables()

    if "table_zones" not in tables:
        op.create_table(
            "table_zones",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("area_id", UUID, sa.ForeignKey("shop_areas.id", ondelete="SET NULL"), nullable=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("layout", sa.String(8), nullable=False, server_default="grid"),
            sa.Column("background_url", sa.String(1000), nullable=True),
            sa.Column("canvas_width", sa.Integer(), nullable=False, server_default="1000"),
            sa.Column("canvas_height", sa.Integer(), nullable=False, server_default="700"),
            _ts("archived_at"),
            _ts("created_at", nullable=False, default=True),
            _ts("updated_at", nullable=False, default=True),
            sa.CheckConstraint("layout IN ('map', 'grid')", name="ck_table_zones_layout"),
        )

    if "dining_tables" not in tables:
        op.create_table(
            "dining_tables",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("zone_id", UUID, sa.ForeignKey("table_zones.id", ondelete="CASCADE"), nullable=False),
            sa.Column("number", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(60), nullable=True),
            sa.Column("seats", sa.Integer(), nullable=False, server_default="4"),
            sa.Column("shape", sa.String(8), nullable=False, server_default="square"),
            sa.Column("x", sa.Float(), nullable=False, server_default="0"),
            sa.Column("y", sa.Float(), nullable=False, server_default="0"),
            sa.Column("width", sa.Float(), nullable=False, server_default="80"),
            sa.Column("height", sa.Float(), nullable=False, server_default="80"),
            sa.Column("rotation", sa.Integer(), nullable=False, server_default="0"),
            _ts("archived_at"),
            _ts("created_at", nullable=False, default=True),
            _ts("updated_at", nullable=False, default=True),
            sa.Column("lock_machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("lock_pos_user_id", sa.String(100), nullable=True),
            sa.Column("lock_pos_user_name", sa.String(200), nullable=True),
            _ts("lock_acquired_at"),
            _ts("lock_expires_at"),
            sa.CheckConstraint("shape IN ('round', 'square', 'rect')", name="ck_dining_tables_shape"),
        )

    if "table_orders" not in tables:
        op.create_table(
            "table_orders",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("table_id", UUID, sa.ForeignKey("dining_tables.id", ondelete="CASCADE"), nullable=False),
            sa.Column("zone_id", UUID, nullable=True),
            sa.Column("table_number", sa.Integer(), nullable=True),
            sa.Column("table_name", sa.String(60), nullable=True),
            sa.Column("status", sa.String(16), nullable=False, server_default="open"),
            sa.Column("source", sa.String(8), nullable=False, server_default="synced"),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("last_request_id", sa.String(64), nullable=True),
            sa.Column("guests", sa.Integer(), nullable=True),
            sa.Column("cart_json", sa.Text(), nullable=True),
            sa.Column("extras_json", sa.Text(), nullable=True),
            sa.Column("item_count", sa.Numeric(12, 3), nullable=False, server_default="0"),
            sa.Column("total", sa.Numeric(12, 2), nullable=False, server_default="0"),
            _ts("opened_at", nullable=False, default=True),
            sa.Column("opened_machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("opened_by_pos_user_id", sa.String(100), nullable=True),
            sa.Column("opened_by_pos_user_name", sa.String(200), nullable=True),
            _ts("updated_at", nullable=False, default=True),
            sa.Column("updated_machine_id", UUID, nullable=True),
            sa.Column("updated_by_pos_user_id", sa.String(100), nullable=True),
            sa.Column("updated_by_pos_user_name", sa.String(200), nullable=True),
            _ts("sent_at"),
            sa.Column("send_count", sa.Integer(), nullable=False, server_default="0"),
            _ts("bill_printed_at"),
            _ts("closed_at"),
            sa.Column("closed_machine_id", UUID, nullable=True),
            sa.Column("closed_by_pos_user_id", sa.String(100), nullable=True),
            sa.Column("closed_by_pos_user_name", sa.String(200), nullable=True),
            sa.Column("transaction_id", sa.String(100), nullable=True),
            sa.Column("transaction_number", sa.String(50), nullable=True),
            sa.Column("paid_total", sa.Numeric(12, 2), nullable=True),
            sa.Column("pay_conflict", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("cancel_reason_id", UUID, nullable=True),
            sa.Column("cancel_reason_text", sa.String(300), nullable=True),
            sa.Column("cancel_approved_by_user_id", UUID, nullable=True),
            sa.Column("cancel_approved_by_pos_user_id", sa.String(100), nullable=True),
            sa.Column("cancel_approved_by_name", sa.String(200), nullable=True),
            sa.Column("cancelled_items", postgresql.JSONB(), nullable=True),
            sa.CheckConstraint(
                "status IN ('open', 'paid', 'cancelled', 'void')", name="ck_table_orders_status"
            ),
            sa.CheckConstraint("source IN ('synced', 'local')", name="ck_table_orders_source"),
        )

    if "table_events" not in tables:
        op.create_table(
            "table_events",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, nullable=False),
            sa.Column("shop_id", UUID, nullable=False),
            sa.Column("table_id", UUID, nullable=True),
            sa.Column("order_id", UUID, nullable=True),
            sa.Column("kind", sa.String(24), nullable=False),
            _ts("occurred_at", nullable=False, default=True),
            sa.Column("machine_id", UUID, nullable=True),
            sa.Column("pos_user_id", sa.String(100), nullable=True),
            sa.Column("pos_user_name", sa.String(200), nullable=True),
            sa.Column("user_id", UUID, nullable=True),
            sa.Column("version", sa.Integer(), nullable=True),
            sa.Column("details", postgresql.JSONB(), nullable=True),
        )

    if "table_cancel_reasons" not in tables:
        op.create_table(
            "table_cancel_reasons",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("requires_note", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            _ts("created_at", nullable=False, default=True),
            _ts("updated_at", nullable=False, default=True),
        )

    wanted = (
        ("table_zones", "ix_table_zones_tenant_id", ["tenant_id"], False, None),
        ("table_zones", "ix_table_zones_shop", ["shop_id"], False, None),
        ("dining_tables", "ix_dining_tables_tenant_id", ["tenant_id"], False, None),
        ("dining_tables", "ix_dining_tables_shop_id", ["shop_id"], False, None),
        ("dining_tables", "ix_dining_tables_zone", ["zone_id"], False, None),
        ("dining_tables", "uq_dining_tables_shop_live_number", ["shop_id", "number"], True, "archived_at IS NULL"),
        ("table_orders", "ix_table_orders_tenant_id", ["tenant_id"], False, None),
        ("table_orders", "ix_table_orders_table_id", ["table_id"], False, None),
        ("table_orders", "ix_table_orders_shop_opened", ["shop_id", "opened_at"], False, None),
        ("table_orders", "ix_table_orders_shop_status", ["shop_id", "status"], False, None),
        (
            "table_orders", "uq_table_orders_open_synced", ["table_id"], True,
            "status = 'open' AND source = 'synced'",
        ),
        ("table_events", "ix_table_events_tenant_id", ["tenant_id"], False, None),
        ("table_events", "ix_table_events_shop_id", ["shop_id"], False, None),
        ("table_events", "ix_table_events_order", ["order_id", "occurred_at"], False, None),
        ("table_cancel_reasons", "ix_table_cancel_reasons_tenant_id", ["tenant_id"], False, None),
    )
    for table, name, columns, unique, where in wanted:
        if name in _existing_indexes(table):
            continue
        kwargs = {"unique": unique}
        if where:
            kwargs["postgresql_where"] = sa.text(where)
        op.create_index(name, table, columns, **kwargs)


def downgrade() -> None:
    op.drop_table("table_cancel_reasons")
    op.drop_table("table_events")
    op.drop_table("table_orders")
    op.drop_table("dining_tables")
    op.drop_table("table_zones")
