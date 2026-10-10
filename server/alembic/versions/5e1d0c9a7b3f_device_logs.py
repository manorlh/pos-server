""""שליחת לוגים לענן": device logs uploaded for support, and the "בקש לוגים" command

* `device_log_uploads` — one row per upload of a device's logs (app/services/device_logs.py): the
  gzip as sent, its metadata, tenant / branch / machine, the `upload_logs` command it answers.
* `device_commands.params` / `.result` — a command's parameters (`upload_logs` → {"minutes"}) and
  what its answer carried (→ {"log_id"}).
* `pos_machines.reported_capabilities` — what the device's build can do, from its heartbeat
  (`device_logs_v1`).

Add-only. Idempotent: the auto-reloading dev API's `create_all` may make the table before this
runs, so the table, its indexes and the columns are looked at first.

Revision ID: 5e1d0c9a7b3f
Revises: c8a1e5f3d9b7
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "5e1d0c9a7b3f"
down_revision: Union[str, Sequence[str], None] = "95b3f4e1893b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "device_log_uploads"
INDEXES = {
    "ix_device_log_uploads_machine_received": ["machine_id", "received_at"],
    "ix_device_log_uploads_tenant_received": ["tenant_id", "received_at"],
    "ix_device_log_uploads_received": ["received_at"],
}
COLUMNS = (
    ("device_commands", "params"),
    ("device_commands", "result"),
    ("pos_machines", "reported_capabilities"),
)


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    if insp is None or not insp.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("upload_id", uuid, nullable=False),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
            sa.Column("branch_id", uuid, sa.ForeignKey("shops.id", ondelete="SET NULL"), nullable=True),
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("reason", sa.String(16), nullable=False),
            sa.Column("command_id", uuid, sa.ForeignKey("device_commands.id", ondelete="SET NULL"), nullable=True),
            sa.Column("requested_by_name", sa.String(200), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("app_version", sa.String(100), nullable=True),
            sa.Column("version_code", sa.BigInteger(), nullable=True),
            sa.Column("device_model", sa.String(100), nullable=True),
            sa.Column("os", sa.String(100), nullable=True),
            sa.Column("from_ms", sa.BigInteger(), nullable=True),
            sa.Column("to_ms", sa.BigInteger(), nullable=True),
            sa.Column("line_count", sa.Integer(), nullable=True),
            sa.Column("content_encoding", sa.String(32), nullable=False),
            sa.Column("content", sa.LargeBinary(), nullable=False),
            sa.Column("size_bytes", sa.Integer(), nullable=False),
            sa.Column("inflated_bytes", sa.BigInteger(), nullable=True),
            sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("opened_by_name", sa.String(200), nullable=True),
            sa.UniqueConstraint("machine_id", "upload_id", name="uq_device_log_uploads_machine_upload"),
        )
        for name, cols in INDEXES.items():
            op.create_index(name, TABLE, cols)
    else:
        existing = {i["name"] for i in insp.get_indexes(TABLE)}
        for name, cols in INDEXES.items():
            if name not in existing:
                op.create_index(name, TABLE, cols)
    for table, column in COLUMNS:
        if insp is not None and column in {c["name"] for c in insp.get_columns(table)}:
            continue
        op.add_column(table, sa.Column(column, postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    for table, column in reversed(COLUMNS):
        op.drop_column(table, column)
    for name in INDEXES:
        op.drop_index(name, table_name=TABLE)
    op.drop_table(TABLE)
