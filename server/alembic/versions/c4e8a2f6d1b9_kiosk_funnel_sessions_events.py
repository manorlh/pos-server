"""Kiosk funnel: kiosk_sessions and kiosk_events ("ביצועי קיוסקים")

Revision ID: c4e8a2f6d1b9
Revises: 5d9e1f3a7c62
Create Date: 2026-10-07

docs/SPEC_KIOSK_INSIGHTS.md: every customer session on a self-order kiosk is reported as
small anonymous events (`POST /sync/{machine_id}/kiosk/events`, idempotent by machine +
session + seq) and folded into one row per session, which the dashboard's "ביצועי קיוסקים"
aggregates. No personal data.

Idempotent: the auto-reloading dev API runs `create_all` at startup and may have made the
tables before this runs — then only the missing indexes are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c4e8a2f6d1b9"
down_revision: Union[str, Sequence[str], None] = "5d9e1f3a7c62"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SESSIONS = "kiosk_sessions"
EVENTS = "kiosk_events"

INDEXES = {
    SESSIONS: (
        ("ix_kiosk_sessions_machine_started", ["machine_id", "started_at"]),
        ("ix_kiosk_sessions_shop_started", ["shop_id", "started_at"]),
        ("ix_kiosk_sessions_tenant_started", ["tenant_id", "started_at"]),
    ),
    EVENTS: (
        ("ix_kiosk_events_machine_at", ["machine_id", "at"]),
        ("ix_kiosk_events_tenant_type_at", ["tenant_id", "type", "at"]),
    ),
}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    uuid = postgresql.UUID(as_uuid=True)
    json = postgresql.JSONB()
    if not inspector.has_table(SESSIONS):
        op.create_table(
            SESSIONS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="SET NULL"), nullable=True),
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("session_id", sa.String(64), nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("end_reason", sa.String(16), nullable=True),
            sa.Column("last_step", sa.String(16), nullable=True),
            sa.Column("max_rank", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("steps", sa.String(200), nullable=True),
            sa.Column("service", sa.String(16), nullable=True),
            sa.Column("paid", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("order_ms", sa.BigInteger(), nullable=True),
            sa.Column("duration_ms", sa.BigInteger(), nullable=True),
            sa.Column("basket_agorot", sa.BigInteger(), nullable=True),
            sa.Column("items", sa.Integer(), nullable=True),
            sa.Column("tip_agorot", sa.BigInteger(), nullable=True),
            sa.Column("upsell_shown", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("upsell_accepted", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("upsell_declined", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("pay_attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("pay_failures", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("help", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("basket_changed", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("last_seq", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("platform", sa.String(16), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("machine_id", "session_id", name="uq_kiosk_sessions_machine_session"),
        )
    if not inspector.has_table(EVENTS):
        op.create_table(
            EVENTS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="SET NULL"), nullable=True),
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("session_id", sa.String(64), nullable=False),
            sa.Column("seq", sa.Integer(), nullable=False),
            sa.Column("type", sa.String(16), nullable=False),
            sa.Column("step", sa.String(16), nullable=True),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("elapsed_ms", sa.BigInteger(), nullable=True),
            sa.Column("data", json, nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("machine_id", "session_id", "seq", name="uq_kiosk_events_machine_session_seq"),
        )
    inspector = sa.inspect(bind)
    for table, indexes in INDEXES.items():
        have = {i["name"] for i in inspector.get_indexes(table)}
        for name, columns in indexes:
            if name not in have:
                op.create_index(name, table, columns)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in (EVENTS, SESSIONS):
        if inspector.has_table(table):
            op.drop_table(table)
