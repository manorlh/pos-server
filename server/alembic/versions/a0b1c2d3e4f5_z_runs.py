"""z runs replace close-day requests

A Z is now produced in the cloud by a Z run: one per shop, an item per till, each
waiting for that till's shift close to be accepted before the Z is built. This replaces
`close_day_requests` / `close_day_request_items`, which told a till to close its *day*
(and file its own Z). Those tables are dropped; their rows describe instructions for a
flow that no longer exists and no fiscal document depends on them.

* `z_runs`, `z_run_items` (statuses are plain strings; see app/models/z_run.py);
* `z_reports.z_run_id` (the run that built it) and `z_runs.z_report_id`;
* `shifts.close_request_item_id` now references `z_run_items` (values pointing at the
  dropped table are cleared first).

Revision ID: a0b1c2d3e4f5
Revises: f9a0b1c2d3e4
Create Date: 2026-09-27 23:30:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "a0b1c2d3e4f5"
down_revision = "f9a0b1c2d3e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "z_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=False),
        sa.Column("created_by_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("z_report_id", UUID(as_uuid=True), nullable=True),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_foreign_key(
        "fk_z_runs_z_report_id_z_reports", "z_runs", "z_reports", ["z_report_id"], ["id"]
    )
    op.create_index("ix_z_runs_tenant_id", "z_runs", ["tenant_id"])
    op.create_index("ix_z_runs_shop_status", "z_runs", ["shop_id", "status"])

    op.create_table(
        "z_run_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "run_id", UUID(as_uuid=True),
            sa.ForeignKey("z_runs.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("through_shift_id", UUID(as_uuid=True), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("close_shift_id", UUID(as_uuid=True), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("include_open_shift", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_z_run_items_run_id", "z_run_items", ["run_id"])
    op.create_index("ix_z_run_items_machine_status", "z_run_items", ["machine_id", "status"])

    op.add_column("z_reports", sa.Column("z_run_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_z_reports_z_run_id_z_runs", "z_reports", "z_runs", ["z_run_id"], ["id"]
    )
    op.create_index("ix_z_reports_z_run_id", "z_reports", ["z_run_id"])

    op.execute("UPDATE shifts SET close_request_item_id = NULL")
    op.create_foreign_key(
        "fk_shifts_close_request_item_id_z_run_items",
        "shifts", "z_run_items", ["close_request_item_id"], ["id"],
    )

    op.drop_table("close_day_request_items")
    op.drop_table("close_day_requests")
    op.execute("DROP TYPE IF EXISTS closedayitemstatus")
    op.execute("DROP TYPE IF EXISTS closedayrequeststatus")


def downgrade() -> None:
    bind = op.get_bind()
    built = bind.execute(sa.text("SELECT count(*) FROM z_reports WHERE z_run_id IS NOT NULL")).scalar()
    if built:
        raise RuntimeError(
            f"Cannot downgrade: {built} Z report(s) were built by Z runs; the previous "
            "revision cannot represent them. Remove them deliberately first."
        )

    request_status = sa.Enum(
        "pending", "in_progress", "completed", "partial", "failed", name="closedayrequeststatus"
    )
    item_status = sa.Enum(
        "pending", "sent", "received", "completed", "failed", "cancelled", "expired",
        name="closedayitemstatus",
    )
    op.create_table(
        "close_day_requests",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("initiated_by_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("status", request_status, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_close_day_requests_tenant_id", "close_day_requests", ["tenant_id"])
    op.create_index("ix_close_day_requests_shop_id", "close_day_requests", ["shop_id"])
    op.create_table(
        "close_day_request_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "request_id", UUID(as_uuid=True),
            sa.ForeignKey("close_day_requests.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("shift_id", UUID(as_uuid=True), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("z_report_id", UUID(as_uuid=True), sa.ForeignKey("z_reports.id"), nullable=True),
        sa.Column("status", item_status, nullable=False),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_close_day_request_items_request_id", "close_day_request_items", ["request_id"])
    op.create_index("ix_close_day_request_items_machine_id", "close_day_request_items", ["machine_id"])
    op.create_index("ix_close_day_items_machine_status", "close_day_request_items", ["machine_id", "status"])

    op.drop_constraint("fk_shifts_close_request_item_id_z_run_items", "shifts", type_="foreignkey")
    op.execute("UPDATE shifts SET close_request_item_id = NULL")
    op.drop_index("ix_z_reports_z_run_id", table_name="z_reports")
    op.drop_constraint("fk_z_reports_z_run_id_z_runs", "z_reports", type_="foreignkey")
    op.drop_column("z_reports", "z_run_id")
    op.drop_table("z_run_items")
    op.drop_constraint("fk_z_runs_z_report_id_z_reports", "z_runs", type_="foreignkey")
    op.drop_table("z_runs")
