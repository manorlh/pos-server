"""till messages: a manager's message every targeted till must acknowledge

* `till_messages` — one message, its target (company / shop / area / till) and expiry.
* `till_message_receipts` — one row per till the message reached at send time, with
  when the till first fetched it and who acknowledged it ("קראתי").

Guarded like f0a1b2c3d4ec: the app's `create_all` may already have made the tables from
the models, so only what is missing is created.

Parent is the accounting export (f0a1b2c3d4ec).

Revision ID: a1c2e3f4b5d6
Revises: f0a1b2c3d4ec
Create Date: 2026-10-03 18:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "a1c2e3f4b5d6"
down_revision = "f0a1b2c3d4ec"
branch_labels = None
depends_on = None


def _existing_tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _existing_indexes(table: str, tables: set) -> set:
    if context.is_offline_mode() or table not in tables:
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    tables = _existing_tables()
    if "till_messages" not in tables:
        op.create_table(
            "till_messages",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("title", sa.String(200), nullable=True),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column("target_level", sa.String(16), nullable=False),
            sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
            sa.CheckConstraint(
                "target_level IN ('company', 'shop', 'area', 'machine')",
                name="ck_till_messages_target_level",
            ),
        )
    if "till_message_receipts" not in tables:
        op.create_table(
            "till_message_receipts",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "message_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("till_messages.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "machine_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("pos_machines.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acknowledged_by_pos_user_id", sa.String(100), nullable=True),
            sa.Column("acknowledged_by_pos_user_name", sa.String(200), nullable=True),
            sa.UniqueConstraint("message_id", "machine_id", name="uq_till_message_receipts_machine"),
        )

    tables = _existing_tables()
    wanted = (
        ("till_messages", "ix_till_messages_tenant_id", ["tenant_id"]),
        ("till_messages", "ix_till_messages_created_at", ["created_at"]),
        ("till_message_receipts", "ix_till_message_receipts_message_id", ["message_id"]),
        ("till_message_receipts", "ix_till_message_receipts_machine_id", ["machine_id"]),
    )
    for table, name, columns in wanted:
        if name not in _existing_indexes(table, tables):
            op.create_index(name, table, columns)


def downgrade() -> None:
    op.drop_index("ix_till_message_receipts_machine_id", table_name="till_message_receipts")
    op.drop_index("ix_till_message_receipts_message_id", table_name="till_message_receipts")
    op.drop_table("till_message_receipts")
    op.drop_index("ix_till_messages_created_at", table_name="till_messages")
    op.drop_index("ix_till_messages_tenant_id", table_name="till_messages")
    op.drop_table("till_messages")
