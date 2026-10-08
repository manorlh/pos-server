"""events: the producer's view ("עמדת מפיק")

Revision ID: 0a4df5f5984e
Revises: 24735c884faf
Create Date: 2026-10-09

* `userrole` gains `producer_view` — an event's customer / producer, read-only, scoped to the
  events granted to them. A native Postgres enum: the value is added in an autocommit block
  (`ALTER TYPE … ADD VALUE` cannot share a transaction with its first use); `IF NOT EXISTS`
  makes a re-run harmless.
* `producer_event_grants` — which events each producer may see (revoked rows kept).
* `report_events.producer_settings` — the settlement switch, the linked voucher batches and
  their production prices.

Idempotent (the auto-reloading API's `create_all` may have made the table first); offline
(`--sql`) the plain statements.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0a4df5f5984e"
down_revision: Union[str, Sequence[str], None] = "24735c884faf"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GRANTS = "producer_event_grants"


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'producer_view'")

    bind = None if _offline() else op.get_bind()
    columns = set() if bind is None else {c["name"] for c in sa.inspect(bind).get_columns("report_events")}
    if "producer_settings" not in columns:
        op.add_column("report_events", sa.Column("producer_settings", postgresql.JSONB(), nullable=True))

    if bind is None or not sa.inspect(bind).has_table(GRANTS):
        op.create_table(
            GRANTS,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("report_events.id", ondelete="CASCADE"), nullable=False),
            sa.Column("display_name", sa.String(120), nullable=True),
            sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("revoked_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.UniqueConstraint("user_id", "event_id", name="uq_producer_event_grants_user_event"),
        )
    indexes = set() if bind is None else {i["name"] for i in sa.inspect(bind).get_indexes(GRANTS)}
    if "ix_producer_event_grants_event" not in indexes:
        op.create_index("ix_producer_event_grants_event", GRANTS, ["event_id"])
    if "ix_producer_event_grants_tenant_id" not in indexes:
        op.create_index("ix_producer_event_grants_tenant_id", GRANTS, ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_producer_event_grants_tenant_id", table_name=GRANTS)
    op.drop_index("ix_producer_event_grants_event", table_name=GRANTS)
    op.drop_table(GRANTS)
    op.drop_column("report_events", "producer_settings")
    # Postgres cannot drop an enum value; any producer user must be removed by hand first.
