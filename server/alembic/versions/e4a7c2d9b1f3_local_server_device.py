"""pos_machines: the dedicated local server ("שרת מקומי")

P:/specs/dedicated-local-server.md §11: an Android device that does not sell and serves the shop's
tables, printing and local shop Z. Four columns on `pos_machines`, every one additive:

* `is_local_server` (NOT NULL, default false, indexed) — set at pairing only;
* `local_server_status` (JSONB) + `local_server_status_at` — its heartbeat's `localServer` block;
* `lan_identity` (JSONB) — the EC P-256 public key tills verify a discovered host against.

No existing machine changes: every row reads false / null. Idempotent: each column is looked at
first (the API's create_all may have added it). Never needs a downgrade in practice; the downgrade
drops only what this revision adds.

Revision ID: e4a7c2d9b1f3, revises 3bfb94dbebb2 (13.10.2026).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "e4a7c2d9b1f3"
down_revision: Union[str, Sequence[str], None] = "3bfb94dbebb2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "pos_machines"
INDEX = "ix_pos_machines_is_local_server"


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment — or after
        # one that left alembic's `context` proxy empty (None) behind it
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _json():
    """JSONB on Postgres (production), plain JSON elsewhere (a test's SQLite)."""
    if _offline():
        return postgresql.JSONB()
    return postgresql.JSONB() if op.get_bind().dialect.name == "postgresql" else sa.JSON()


def _columns() -> set:
    if _offline():
        return set()
    insp = sa.inspect(op.get_bind())
    if not insp.has_table(TABLE):
        return set()
    return {c["name"] for c in insp.get_columns(TABLE)}


def _has_table() -> bool:
    if _offline():
        return True
    return sa.inspect(op.get_bind()).has_table(TABLE)


def _has_index() -> bool:
    if _offline():
        return False
    return INDEX in {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(TABLE)}


def upgrade() -> None:
    if not _has_table():
        return
    have = _columns()
    if "is_local_server" not in have:
        op.add_column(
            TABLE,
            sa.Column("is_local_server", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    if "local_server_status" not in have:
        op.add_column(TABLE, sa.Column("local_server_status", _json(), nullable=True))
    if "local_server_status_at" not in have:
        op.add_column(TABLE, sa.Column("local_server_status_at", sa.DateTime(timezone=True), nullable=True))
    if "lan_identity" not in have:
        op.add_column(TABLE, sa.Column("lan_identity", _json(), nullable=True))
    if not _has_index():
        op.create_index(INDEX, TABLE, ["is_local_server"])


def downgrade() -> None:
    if _offline() or not _has_table():
        return
    if _has_index():
        op.drop_index(INDEX, table_name=TABLE)
    have = _columns()
    for column in ("lan_identity", "local_server_status_at", "local_server_status", "is_local_server"):
        if column in have:
            op.drop_column(TABLE, column)
