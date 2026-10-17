"""tables: the device's and the employee's table scope, and table numbers with letters

P:/specs/table-scope.md (owner, 16.10 — "למלצר אזור או שולחנות והוא רואה רק אותם", "מספרי שולחנות עם אותיות"):

* `pos_machines.table_scope`, `pos_users.table_scope` (JSONB, null) — `{"zoneIds": [...], "tableIds": [...]}`: the
  zones and tables the device / the employee sees (§2, §3). Null — no scope: everything, as today.
* `dining_tables.label` / `label_key` (VARCHAR 12, null) — "3B" and its normalised form ("3B" for "3-b"), unique
  among a shop's live tables by `uq_dining_tables_shop_live_label` (partial, like the number's own) (§6.1).
* `table_orders.table_label` (VARCHAR 12, null) — the label beside the number and the name an order records (§6.1).
* `table_scope_changes` — who changed whose scope, when, from what to what (§10).

Add-only and idempotent (each column, index and table looked at first; the API's create_all may have made them).
No existing row changes: no scope anywhere, no label anywhere — every till sees what it sees today.

Revision ID: e7c4a1b9d3f6
Revises: 6b3b29c7bc5b
Create Date: 2026-10-16 18:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "e7c4a1b9d3f6"
down_revision: Union[str, Sequence[str], None] = "6b3b29c7bc5b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MACHINES = "pos_machines"
USERS = "pos_users"
TABLES = "dining_tables"
ORDERS = "table_orders"
CHANGES = "table_scope_changes"
LABEL_INDEX = "uq_dining_tables_shop_live_label"


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_table(table: str) -> bool:
    if _offline():
        return table != CHANGES
    return sa.inspect(op.get_bind()).has_table(table)


def _columns(table: str) -> set:
    if _offline() or not _has_table(table):
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set:
    if _offline() or not _has_table(table):
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    now = sa.text("now()") if _offline() or op.get_bind().dialect.name == "postgresql" else sa.text("CURRENT_TIMESTAMP")

    for table in (MACHINES, USERS):
        if _has_table(table) and "table_scope" not in _columns(table):
            op.add_column(table, sa.Column("table_scope", jsonb, nullable=True))

    if _has_table(TABLES):
        have = _columns(TABLES)
        if "label" not in have:
            op.add_column(TABLES, sa.Column("label", sa.String(12), nullable=True))
        if "label_key" not in have:
            op.add_column(TABLES, sa.Column("label_key", sa.String(12), nullable=True))
        if LABEL_INDEX not in _indexes(TABLES):
            op.create_index(
                LABEL_INDEX,
                TABLES,
                ["shop_id", "label_key"],
                unique=True,
                postgresql_where=sa.text("archived_at IS NULL AND label_key IS NOT NULL"),
                sqlite_where=sa.text("archived_at IS NULL AND label_key IS NOT NULL"),
            )

    if _has_table(ORDERS) and "table_label" not in _columns(ORDERS):
        op.add_column(ORDERS, sa.Column("table_label", sa.String(12), nullable=True))

    if not _has_table(CHANGES):
        op.create_table(
            CHANGES,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, nullable=True),
            sa.Column("shop_id", uid, nullable=True),
            sa.Column("target_type", sa.String(16), nullable=False),
            sa.Column("target_id", uid, nullable=False),
            sa.Column("target_name", sa.String(200), nullable=True),
            sa.Column("old_value", jsonb, nullable=True),
            sa.Column("new_value", jsonb, nullable=True),
            sa.Column("user_id", uid, nullable=True),
            sa.Column("user_email", sa.String(255), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
        )
    have = _indexes(CHANGES)
    for name, columns in (
        ("ix_table_scope_changes_tenant_id", ["tenant_id"]),
        ("ix_table_scope_changes_shop_at", ["shop_id", "created_at"]),
        ("ix_table_scope_changes_target", ["target_type", "target_id"]),
    ):
        if name not in have:
            op.create_index(name, CHANGES, columns)


def downgrade() -> None:
    if _offline():
        return
    if _has_table(CHANGES):
        op.drop_table(CHANGES)
    if _has_table(ORDERS) and "table_label" in _columns(ORDERS):
        op.drop_column(ORDERS, "table_label")
    if _has_table(TABLES):
        if LABEL_INDEX in _indexes(TABLES):
            op.drop_index(LABEL_INDEX, table_name=TABLES)
        for column in ("label_key", "label"):
            if column in _columns(TABLES):
                op.drop_column(TABLES, column)
    for table in (USERS, MACHINES):
        if _has_table(table) and "table_scope" in _columns(table):
            op.drop_column(table, "table_scope")
