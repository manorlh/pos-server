"""shift_close_requests: closing a till's shift remotely without a Z

* `shift_close_requests` — an operator's request that a till close its open shift, sent
  to the till exactly as a Z run's close is (statuses are plain strings; see
  app/models/shift_close_request.py);
* `shifts.close_request_id` — the standalone request a close answered (a Z run item's
  stays in `close_request_item_id`).

Nothing to backfill: no such request existed before.

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-09-28 14:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "d3e4f5a6b7c8"
down_revision = "c2d3e4f5a6b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "shift_close_requests",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("shift_id", UUID(as_uuid=True), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("created_by_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_shift_close_requests_tenant_id", "shift_close_requests", ["tenant_id"])
    op.create_index(
        "ix_shift_close_requests_machine_status", "shift_close_requests", ["machine_id", "status"]
    )

    op.add_column("shifts", sa.Column("close_request_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_shifts_close_request_id_shift_close_requests",
        "shifts", "shift_close_requests", ["close_request_id"], ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_shifts_close_request_id_shift_close_requests", "shifts", type_="foreignkey"
    )
    op.drop_column("shifts", "close_request_id")
    op.drop_index("ix_shift_close_requests_machine_status", table_name="shift_close_requests")
    op.drop_index("ix_shift_close_requests_tenant_id", table_name="shift_close_requests")
    op.drop_table("shift_close_requests")
