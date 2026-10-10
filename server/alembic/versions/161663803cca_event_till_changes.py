"""events: the history of tills added, removed and moved ("שיוך קופות מהיר לאירוע")

Revision ID: 161663803cca
Revises: c8a1e5f3d9b7
Create Date: 2026-10-09

`report_event_machine_changes` — every till added to, removed from or moved between events (a
move: two rows, each naming the other event), who and when. Append only.

Idempotent (the auto-reloading API's `create_all` may have made the table first).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "161663803cca"
down_revision: Union[str, Sequence[str], None] = "c8a1e5f3d9b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "report_event_machine_changes"


def upgrade() -> None:
    bind = None if op.get_context().as_sql else op.get_bind()
    if bind is None or not sa.inspect(bind).has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("machine_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("action", sa.String(16), nullable=False),
            sa.Column("other_event_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("other_event_name", sa.String(120), nullable=True),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    indexes = set() if bind is None else {i["name"] for i in sa.inspect(bind).get_indexes(TABLE)}
    if "ix_report_event_machine_changes_event" not in indexes:
        op.create_index("ix_report_event_machine_changes_event", TABLE, ["event_id", "created_at"])
    if "ix_report_event_machine_changes_tenant_id" not in indexes:
        op.create_index("ix_report_event_machine_changes_tenant_id", TABLE, ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_report_event_machine_changes_tenant_id", table_name=TABLE)
    op.drop_index("ix_report_event_machine_changes_event", table_name=TABLE)
    op.drop_table(TABLE)
