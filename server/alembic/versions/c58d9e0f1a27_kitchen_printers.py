"""kitchen / bar ticket printers ("מדפסות בונים"): printers, routing, cloud relay jobs

* `kitchen_printers` — a shop's printers (optionally one point of sale's or one till's):
  network / bluetooth / cloud (relayed to a host till) / the till's own.
* `kitchen_printer_routes` — category / product → printer, per shop; a null printer is an
  explicit "no ticket".
* `kitchen_print_jobs` — tickets relayed through the cloud to the till that prints them.

Guarded like the other recent revisions: the app's `create_all` may already have made
the tables from the models, so only what is missing is created.

Revision ID: c58d9e0f1a27
Revises: c47b8c9d0e15
Create Date: 2026-10-04 04:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "c58d9e0f1a27"
down_revision = "c47b8c9d0e15"
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

    if "kitchen_printers" not in tables:
        op.create_table(
            "kitchen_printers",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("area_id", UUID, sa.ForeignKey("shop_areas.id", ondelete="SET NULL"), nullable=True),
            sa.Column("machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("connection_type", sa.String(16), nullable=False),
            sa.Column("host", sa.String(255), nullable=True),
            sa.Column("port", sa.Integer(), nullable=True),
            sa.Column("bt_address", sa.String(17), nullable=True),
            sa.Column("bt_name", sa.String(100), nullable=True),
            sa.Column("host_machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("host_connection", sa.String(16), nullable=True),
            sa.Column("paper_width", sa.Integer(), nullable=False, server_default="80"),
            sa.Column("copies", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("cut_paper", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("beep", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            _ts("created_at", nullable=False, default=True),
            _ts("updated_at", nullable=False, default=True),
            sa.CheckConstraint(
                "connection_type IN ('network', 'bluetooth', 'cloud', 'till')",
                name="ck_kitchen_printers_connection_type",
            ),
            sa.CheckConstraint(
                "host_connection IS NULL OR host_connection IN ('till', 'network', 'bluetooth')",
                name="ck_kitchen_printers_host_connection",
            ),
            sa.CheckConstraint("paper_width IN (58, 80)", name="ck_kitchen_printers_paper_width"),
        )
    indexes = _existing_indexes("kitchen_printers") if "kitchen_printers" in tables else set()
    if "ix_kitchen_printers_shop" not in indexes:
        op.create_index("ix_kitchen_printers_shop", "kitchen_printers", ["shop_id"])
    if "ix_kitchen_printers_tenant_id" not in indexes:
        op.create_index("ix_kitchen_printers_tenant_id", "kitchen_printers", ["tenant_id"])

    if "kitchen_printer_routes" not in tables:
        op.create_table(
            "kitchen_printer_routes",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("target_type", sa.String(16), nullable=False),
            sa.Column("target_id", UUID, nullable=False),
            sa.Column(
                "printer_id", UUID, sa.ForeignKey("kitchen_printers.id", ondelete="CASCADE"), nullable=True
            ),
            _ts("created_at", nullable=False, default=True),
            sa.CheckConstraint(
                "target_type IN ('category', 'product')", name="ck_kitchen_printer_routes_target_type"
            ),
        )
    indexes = _existing_indexes("kitchen_printer_routes") if "kitchen_printer_routes" in tables else set()
    if "uq_kitchen_printer_routes_printer" not in indexes:
        op.create_index(
            "uq_kitchen_printer_routes_printer",
            "kitchen_printer_routes",
            ["shop_id", "target_type", "target_id", "printer_id"],
            unique=True,
            postgresql_where=sa.text("printer_id IS NOT NULL"),
        )
    if "uq_kitchen_printer_routes_none" not in indexes:
        op.create_index(
            "uq_kitchen_printer_routes_none",
            "kitchen_printer_routes",
            ["shop_id", "target_type", "target_id"],
            unique=True,
            postgresql_where=sa.text("printer_id IS NULL"),
        )
    if "ix_kitchen_printer_routes_shop" not in indexes:
        op.create_index("ix_kitchen_printer_routes_shop", "kitchen_printer_routes", ["shop_id"])
    if "ix_kitchen_printer_routes_tenant_id" not in indexes:
        op.create_index("ix_kitchen_printer_routes_tenant_id", "kitchen_printer_routes", ["tenant_id"])

    if "kitchen_print_jobs" not in tables:
        op.create_table(
            "kitchen_print_jobs",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column(
                "printer_id", UUID, sa.ForeignKey("kitchen_printers.id", ondelete="SET NULL"), nullable=True
            ),
            sa.Column("printer_name", sa.String(100), nullable=True),
            sa.Column("kind", sa.String(8), nullable=False, server_default="ticket"),
            sa.Column(
                "target_machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=True
            ),
            sa.Column(
                "source_machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True
            ),
            sa.Column(
                "created_by_user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
            ),
            sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column("deliveries", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("error", sa.String(500), nullable=True),
            _ts("created_at", nullable=False, default=True),
            _ts("expires_at", nullable=False),
            _ts("delivered_at"),
            _ts("completed_at"),
            sa.CheckConstraint(
                "status IN ('pending', 'printing', 'done', 'failed', 'expired')",
                name="ck_kitchen_print_jobs_status",
            ),
            sa.CheckConstraint("kind IN ('ticket', 'test')", name="ck_kitchen_print_jobs_kind"),
        )
    indexes = _existing_indexes("kitchen_print_jobs") if "kitchen_print_jobs" in tables else set()
    if "ix_kitchen_print_jobs_target_status" not in indexes:
        op.create_index(
            "ix_kitchen_print_jobs_target_status", "kitchen_print_jobs", ["target_machine_id", "status"]
        )
    if "ix_kitchen_print_jobs_source" not in indexes:
        op.create_index("ix_kitchen_print_jobs_source", "kitchen_print_jobs", ["source_machine_id", "created_at"])
    if "ix_kitchen_print_jobs_printer" not in indexes:
        op.create_index("ix_kitchen_print_jobs_printer", "kitchen_print_jobs", ["printer_id", "created_at"])
    if "ix_kitchen_print_jobs_tenant_id" not in indexes:
        op.create_index("ix_kitchen_print_jobs_tenant_id", "kitchen_print_jobs", ["tenant_id"])


def downgrade() -> None:
    op.drop_table("kitchen_print_jobs")
    op.drop_table("kitchen_printer_routes")
    op.drop_table("kitchen_printers")
