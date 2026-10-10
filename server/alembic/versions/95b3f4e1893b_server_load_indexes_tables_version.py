"""server load: hot-query indexes and the tables' state version

From the performance review (P:/specs/performance-review-2026-10.md #9, #3). Add-only: no column
of an existing table changes, no data moves.

Indexes — each built CONCURRENTLY, outside the migration's transaction, so no read or write
waits while it builds (`transactions` is the largest table); an invalid leftover of a failed
build is dropped and built again on the next run:

* `kds_changes (task_id)` — "מוכן" on the KDS reads the task's last cancellation on every bump
  (`kds._last_cancel_at`): a scan of every tenant's changes until now;
* `kds_changes (shop_id) WHERE acked_at IS NULL AND requires_ack IS true` — the board's changes
  still waiting for an acknowledgement;
* `kds_orders (shop_id, updated_at)` — the board's orders handed over a moment ago;
* `kds_orders (shop_id, created_at)` — the till's "הזמנות להכנה" of the last day (its time bound
  is now in the SQL too);
* `transactions (tenant_id, created_at)`, `transactions (shop_id, created_at)` — the dashboard's
  sales figures (polled while a dashboard is open) over a time window;
* `table_orders (shop_id, closed_at)` — "נסגרו היום";
* `kiosk_orders (shop_id, closed_at)` — the kiosk orders the tills still show after closing.

Table `tables_state_versions` (app/models/tables_state.py): the shop's tables version, so a till
that holds it is answered "unchanged" without the state being built.

lock_timeout: the table is created in the migration's own transaction under the repo's
`SET LOCAL lock_timeout = '10s'`, unless the session already carries a lock_timeout (alembic/env.py
or the role): that one is kept, never overridden. CREATE INDEX CONCURRENTLY takes no lock that
blocks reads or writes; it runs under the session's lock_timeout as it stands — if one trips, the
build's invalid leftover is rebuilt on the next `alembic upgrade head`.

Idempotent (the API's create_all may have made the table, a test database the indexes).
Offline (`--sql`): the same statements, CONCURRENTLY each in its own autocommit block.

Revision ID: 95b3f4e1893b
Revises: b8e2d4f6a1c3
Create Date: 2026-10-10
"""
from __future__ import annotations

from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "95b3f4e1893b"
down_revision: Union[str, Sequence[str], None] = "b8e2d4f6a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "tables_state_versions"
LOCK_TIMEOUT = "10s"

#: (name, table, columns, partial-index predicate)
INDEXES = (
    ("ix_kds_changes_task", "kds_changes", ("task_id",), None),
    ("ix_kds_changes_shop_unacked", "kds_changes", ("shop_id",), "acked_at IS NULL AND requires_ack IS true"),
    ("ix_kds_orders_shop_updated", "kds_orders", ("shop_id", "updated_at"), None),
    ("ix_kds_orders_shop_created", "kds_orders", ("shop_id", "created_at"), None),
    ("ix_transactions_tenant_created_at", "transactions", ("tenant_id", "created_at"), None),
    ("ix_transactions_shop_created_at", "transactions", ("shop_id", "created_at"), None),
    ("ix_table_orders_shop_closed", "table_orders", ("shop_id", "closed_at"), None),
    ("ix_kiosk_orders_shop_closed", "kiosk_orders", ("shop_id", "closed_at"), None),
)


def _offline() -> bool:
    return context.is_offline_mode()


def _postgres() -> bool:
    return op.get_context().dialect.name == "postgresql"


def _session_lock_timeout_set() -> bool:
    """Whether this session already has a lock_timeout (from env.py or the role): if so, keep it."""
    if _offline() or not _postgres():
        return False
    value = op.get_bind().execute(sa.text("SHOW lock_timeout")).scalar()
    return str(value or "0").strip() not in ("0", "0ms", "0s")


def _create_table() -> None:
    if not _offline() and sa.inspect(op.get_bind()).has_table(TABLE):
        return
    if _postgres() and not _session_lock_timeout_set():
        op.execute(sa.text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
    op.create_table(
        TABLE,
        sa.Column("shop_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("version", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def _index_state(name: str) -> Optional[bool]:
    """True: a valid index; False: an invalid leftover (a failed concurrent build); None: none."""
    return op.get_bind().execute(sa.text(
        "SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid "
        "WHERE c.relname = :n AND c.relkind = 'i'"
    ), {"n": name}).scalar()


def _create_index(name: str, table: str, columns: Sequence[str], where: Optional[str]) -> None:
    cols = ", ".join(columns)
    tail = f" WHERE {where}" if where else ""
    if not _postgres():  # pragma: no cover - production and every migration run are Postgres
        if _offline() or name not in {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}:
            op.execute(f"CREATE INDEX {name} ON {table} ({cols}){tail}")
        return
    if not _offline():
        state = _index_state(name)
        if state is True:
            return
    else:
        state = None
    with op.get_context().autocommit_block():
        if state is False:
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
        op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {table} ({cols}){tail}")


def upgrade() -> None:
    _create_table()
    for name, table, columns, where in INDEXES:
        _create_index(name, table, columns, where)


def downgrade() -> None:
    """A scratch database only: the indexes and the version table go."""
    for name, _table, _columns, _where in reversed(INDEXES):
        if _postgres():
            with op.get_context().autocommit_block():
                op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
        else:  # pragma: no cover
            op.execute(f"DROP INDEX IF EXISTS {name}")
    if _offline() or sa.inspect(op.get_bind()).has_table(TABLE):
        op.drop_table(TABLE)
