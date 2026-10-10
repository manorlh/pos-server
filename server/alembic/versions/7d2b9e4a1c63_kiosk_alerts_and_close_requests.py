"""Kiosk alerts to the tills and the kiosk's close with the shop Z

Revision ID: 7d2b9e4a1c63
Revises: 5c1e9a7f3b28
Create Date: 2026-10-06

docs/SPEC_KIOSK.md §16 (app/models/kiosk_ops.py):

* `kiosk_alerts` — "התראות לקופות": a kiosk's printer / card-terminal / help alerts, one
  open row per kiosk and key (partial unique index), routed to the shop's tills.
* `kiosk_close_requests` — "סגירה יחד עם ה-Z הסניפי": the shop's Z asks a kiosk to close
  its shift and make its own Z; the kiosk reports back.

Additive and idempotent: a table the auto-reloading API already created (create_all at
startup) is kept, and only its missing indexes are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '7d2b9e4a1c63'
down_revision: Union[str, Sequence[str], None] = '5c1e9a7f3b28'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _indexes(bind, table: str) -> set:
    return {ix["name"] for ix in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    json = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")

    if not inspector.has_table("kiosk_alerts"):
        op.create_table(
            "kiosk_alerts",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shops.id", ondelete="SET NULL"), nullable=True),
            sa.Column("kiosk_machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("key", sa.String(40), nullable=False),
            sa.Column("reason", sa.String(40), nullable=False),
            sa.Column("text", sa.String(300), nullable=False),
            sa.Column("detail", json, nullable=True),
            sa.Column("request_id", sa.String(64), nullable=True),
            sa.Column("raised_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_reported_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("ping_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("pinged_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acknowledged_by_machine_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("acknowledged_by_name", sa.String(200), nullable=True),
            sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("clear_reason", sa.String(24), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    have = _indexes(bind, "kiosk_alerts")
    if "ix_kiosk_alerts_tenant_id" not in have:
        op.create_index("ix_kiosk_alerts_tenant_id", "kiosk_alerts", ["tenant_id"])
    if "ix_kiosk_alerts_shop_open" not in have:
        op.create_index("ix_kiosk_alerts_shop_open", "kiosk_alerts", ["shop_id", "cleared_at"])
    if "uq_kiosk_alerts_open" not in have:
        op.create_index(
            "uq_kiosk_alerts_open", "kiosk_alerts", ["kiosk_machine_id", "key"], unique=True,
            postgresql_where=sa.text("cleared_at IS NULL"),
        )

    if not inspector.has_table("kiosk_close_requests"):
        op.create_table(
            "kiosk_close_requests",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shops.id", ondelete="SET NULL"), nullable=True),
            sa.Column("kiosk_machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("source", sa.String(16), nullable=False),
            sa.Column("source_ref", sa.String(64), nullable=True),
            sa.Column("state", sa.String(16), nullable=False),
            sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("result", json, nullable=True),
        )
    have = _indexes(bind, "kiosk_close_requests")
    if "ix_kiosk_close_requests_tenant_id" not in have:
        op.create_index("ix_kiosk_close_requests_tenant_id", "kiosk_close_requests", ["tenant_id"])
    if "ix_kiosk_close_requests_kiosk_state" not in have:
        op.create_index("ix_kiosk_close_requests_kiosk_state", "kiosk_close_requests", ["kiosk_machine_id", "state"])


def downgrade() -> None:
    op.drop_table("kiosk_close_requests")
    op.drop_table("kiosk_alerts")
