""""פקודות שנשלחו": the dashboard's Idempotency-Key per command request

* `command_request_keys` — one row per key a command request answered (device commands, card
  commands, kiosk commands, till messages, printer tests): a retry with the same key gets the
  same answer and never makes a second command (app/services/command_idempotency.py).

Idempotent: the auto-reloading dev API's `create_all` may make the table before this runs, so
the table and its indexes are looked at first. Never downgraded in place.

Revision ID: c8a1e5f3d9b7
Revises: e4b9d2a7c6f1
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c8a1e5f3d9b7"
down_revision: Union[str, Sequence[str], None] = "e4b9d2a7c6f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "command_request_keys"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    if insp is None or not insp.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, nullable=False),
            sa.Column("kind", sa.String(32), nullable=False),
            sa.Column("key", sa.String(100), nullable=False),
            sa.Column("user_id", uuid, nullable=True),
            sa.Column("fingerprint", sa.String(64), nullable=False),
            sa.Column("response", postgresql.JSONB(), nullable=True),
            sa.Column("status_code", sa.Integer(), nullable=False, server_default="201"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("tenant_id", "kind", "key", name="uq_command_request_keys_key"),
        )
        op.create_index("ix_command_request_keys_created", TABLE, ["created_at"])
        return
    indexes = {i["name"] for i in insp.get_indexes(TABLE)}
    if "ix_command_request_keys_created" not in indexes:
        op.create_index("ix_command_request_keys_created", TABLE, ["created_at"])
    # A table made by an earlier build's create_all had a nullable tenant: keys only live a day.
    tenant = next((c for c in insp.get_columns(TABLE) if c["name"] == "tenant_id"), None)
    if tenant is not None and tenant.get("nullable", False):
        op.execute(sa.text(f"DELETE FROM {TABLE} WHERE tenant_id IS NULL"))
        op.alter_column(TABLE, "tenant_id", existing_type=uuid, nullable=False)


def downgrade() -> None:
    op.drop_index("ix_command_request_keys_created", table_name=TABLE)
    op.drop_table(TABLE)
