"""till messages: scheduled and recurring messages, per-occurrence receipts

* `till_messages` gains its schedule: `schedule_kind` (now / scheduled / recurring),
  `send_at`, `sent_at`, `timezone`, the weekly recurrence (`recur_days`, `recur_time`,
  `recur_start_date`, `recur_end_date`, `occurrence_ttl_minutes`), `paused_at` and
  `last_occurrence_date`. Existing rows are "now" messages, already sent.
* `till_message_receipts` gains `occurrence_date`, `occurs_at`, `expires_at`: a recurring
  message has one receipt per till per occurrence. The (message, till) unique constraint
  becomes a partial unique index for one-off messages plus a unique index on
  (message, till, occurrence date).

Guarded: only what is missing is added.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-10-03 21:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def _uniques(insp, table: str) -> set:
    return set() if insp is None else {u["name"] for u in insp.get_unique_constraints(table)}


def _checks(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_check_constraints(table)}


MESSAGE_COLUMNS = (
    sa.Column("schedule_kind", sa.String(16), nullable=False, server_default="now"),
    sa.Column("send_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("timezone", sa.String(64), nullable=True),
    sa.Column("recur_days", sa.String(7), nullable=True),
    sa.Column("recur_time", sa.String(5), nullable=True),
    sa.Column("recur_start_date", sa.Date(), nullable=True),
    sa.Column("recur_end_date", sa.Date(), nullable=True),
    sa.Column("occurrence_ttl_minutes", sa.Integer(), nullable=True),
    sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("last_occurrence_date", sa.Date(), nullable=True),
)

RECEIPT_COLUMNS = (
    sa.Column("occurrence_date", sa.Date(), nullable=True),
    sa.Column("occurs_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
)


def upgrade() -> None:
    insp = _inspector()
    have = _columns(insp, "till_messages")
    added_sent_at = "sent_at" not in have
    for column in MESSAGE_COLUMNS:
        if column.name not in have:
            op.add_column("till_messages", column.copy())
    if added_sent_at:
        op.execute("UPDATE till_messages SET sent_at = created_at WHERE schedule_kind = 'now'")
    if "ck_till_messages_schedule_kind" not in _checks(insp, "till_messages"):
        op.create_check_constraint(
            "ck_till_messages_schedule_kind",
            "till_messages",
            "schedule_kind IN ('now', 'scheduled', 'recurring')",
        )

    have = _columns(insp, "till_message_receipts")
    for column in RECEIPT_COLUMNS:
        if column.name not in have:
            op.add_column("till_message_receipts", column.copy())

    indexes = _indexes(insp, "till_message_receipts")
    if "uq_till_message_receipts_once" not in indexes:
        op.create_index(
            "uq_till_message_receipts_once",
            "till_message_receipts",
            ["message_id", "machine_id"],
            unique=True,
            postgresql_where=sa.text("occurrence_date IS NULL"),
        )
    if "uq_till_message_receipts_occurrence" not in indexes:
        op.create_index(
            "uq_till_message_receipts_occurrence",
            "till_message_receipts",
            ["message_id", "machine_id", "occurrence_date"],
            unique=True,
        )
    if "uq_till_message_receipts_machine" in _uniques(insp, "till_message_receipts"):
        op.drop_constraint("uq_till_message_receipts_machine", "till_message_receipts", type_="unique")


def downgrade() -> None:
    op.execute("DELETE FROM till_message_receipts WHERE occurrence_date IS NOT NULL")
    op.create_unique_constraint(
        "uq_till_message_receipts_machine", "till_message_receipts", ["message_id", "machine_id"]
    )
    op.drop_index("uq_till_message_receipts_occurrence", table_name="till_message_receipts")
    op.drop_index("uq_till_message_receipts_once", table_name="till_message_receipts")
    for column in reversed(RECEIPT_COLUMNS):
        op.drop_column("till_message_receipts", column.name)
    op.drop_constraint("ck_till_messages_schedule_kind", "till_messages", type_="check")
    for column in reversed(MESSAGE_COLUMNS):
        op.drop_column("till_messages", column.name)
