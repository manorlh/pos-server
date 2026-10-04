"""Z on the till: per-till Z mode, numbering and dashboard requests (docs/SHIFTS_API.md §5)

* `pos_machines.z_mode` — `cloud` (default: every till today, the shop's Z run builds
  its Z) or `till` (it asks for its own Z).
* `z_reports` — `origin` (`cloud` on every existing row), `machine_sequence_number` (a
  till Z's number in its till's run; unique per till where set), `client_request_id`
  (the till's idempotency key, unique), `created_by_name` / `created_by_pos_user_id`
  (who pressed it at the till), `till_totals` (the till's own sum, audit) and
  `totals_mismatch`.
* `machine_z_sequences` — the per-till gapless counter (`last_number`, 0 = none yet).
* `till_z_requests` — the dashboard asking a till for its Z.

Nothing is backfilled: no till is in `till` mode until someone switches it.

Parent is the printer status (f1a2b3c4d5e6).

Revision ID: a2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-10-01 18:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "a2b3c4d5e6f7"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pos_machines",
        sa.Column("z_mode", sa.String(8), nullable=False, server_default="cloud"),
    )

    op.add_column(
        "z_reports",
        sa.Column("origin", sa.String(8), nullable=False, server_default="cloud"),
    )
    op.add_column("z_reports", sa.Column("machine_sequence_number", sa.Integer(), nullable=True))
    op.add_column(
        "z_reports", sa.Column("client_request_id", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.add_column("z_reports", sa.Column("created_by_name", sa.String(255), nullable=True))
    op.add_column("z_reports", sa.Column("created_by_pos_user_id", sa.String(100), nullable=True))
    op.add_column(
        "z_reports", sa.Column("till_totals", postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )
    op.add_column(
        "z_reports",
        sa.Column("totals_mismatch", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_unique_constraint(
        "uq_z_reports_client_request_id", "z_reports", ["client_request_id"]
    )
    op.create_index(
        "uq_z_reports_machine_sequence",
        "z_reports",
        ["machine_id", "machine_sequence_number"],
        unique=True,
        postgresql_where=sa.text("machine_sequence_number IS NOT NULL"),
    )

    op.create_table(
        "machine_z_sequences",
        sa.Column(
            "machine_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("pos_machines.id"),
            primary_key=True,
        ),
        sa.Column("last_number", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )

    op.create_table(
        "till_z_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("shop_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("initiated_by", sa.String(255), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("z_report_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("z_reports.id"), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_till_z_requests_tenant_id", "till_z_requests", ["tenant_id"])
    op.create_index("ix_till_z_requests_shop_id", "till_z_requests", ["shop_id"])
    op.create_index("ix_till_z_requests_machine_status", "till_z_requests", ["machine_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_till_z_requests_machine_status", table_name="till_z_requests")
    op.drop_index("ix_till_z_requests_shop_id", table_name="till_z_requests")
    op.drop_index("ix_till_z_requests_tenant_id", table_name="till_z_requests")
    op.drop_table("till_z_requests")
    op.drop_table("machine_z_sequences")

    op.drop_index("uq_z_reports_machine_sequence", table_name="z_reports")
    op.drop_constraint("uq_z_reports_client_request_id", "z_reports", type_="unique")
    for column in (
        "totals_mismatch",
        "till_totals",
        "created_by_pos_user_id",
        "created_by_name",
        "client_request_id",
        "machine_sequence_number",
        "origin",
    ):
        op.drop_column("z_reports", column)

    op.drop_column("pos_machines", "z_mode")
