"""add close_day_requests and close_day_request_items

Revision ID: g3h4i5j6k7l8
Revises: f2a3b4c5d6e7
Create Date: 2026-06-30 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "g3h4i5j6k7l8"
down_revision = "f2a3b4c5d6e7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "close_day_requests",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("initiated_by_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "in_progress", "completed", "partial", "failed",
                name="closedayrequeststatus",
            ),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_close_day_requests_tenant_id", "close_day_requests", ["tenant_id"])
    op.create_index("ix_close_day_requests_shop_id", "close_day_requests", ["shop_id"])

    op.create_table(
        "close_day_request_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "request_id",
            UUID(as_uuid=True),
            sa.ForeignKey("close_day_requests.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("trading_day_id", UUID(as_uuid=True), sa.ForeignKey("trading_days.id"), nullable=True),
        sa.Column("z_report_id", UUID(as_uuid=True), sa.ForeignKey("z_reports.id"), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "sent", "received", "completed", "failed", "cancelled", "expired",
                name="closedayitemstatus",
            ),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_close_day_request_items_request_id", "close_day_request_items", ["request_id"])
    op.create_index("ix_close_day_request_items_machine_id", "close_day_request_items", ["machine_id"])
    op.create_index("ix_close_day_items_machine_status", "close_day_request_items", ["machine_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_close_day_items_machine_status", table_name="close_day_request_items")
    op.drop_index("ix_close_day_request_items_machine_id", table_name="close_day_request_items")
    op.drop_index("ix_close_day_request_items_request_id", table_name="close_day_request_items")
    op.drop_table("close_day_request_items")
    op.drop_index("ix_close_day_requests_shop_id", table_name="close_day_requests")
    op.drop_index("ix_close_day_requests_tenant_id", table_name="close_day_requests")
    op.drop_table("close_day_requests")
    sa.Enum(name="closedayitemstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="closedayrequeststatus").drop(op.get_bind(), checkfirst=True)
