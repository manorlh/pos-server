"""prepaid_voucher_redemptions: manual redemption from the dashboard ("מימוש ידני מהענן")

When a till's scanner failed at an event and customers were served anyway, a manager records the
redemptions from the cloud (app/services/prepaid_voucher_manual.py). They are ordinary redemption rows
(balance, status, reports and settlement count them) marked:

* `source` — "dashboard" (null: a till, as every row so far);
* `manual` — NOT NULL, server default false;
* `manual_reason`, `manual_by_user_id`, `manual_by_user_name` — why and who;
* `manual_override` — the rules a super admin forced past ("כפייה": expired, not yet valid, another
  shop), a JSON list; null when none;
* `reverse_reason`, `reversed_by_user_name` — an undo from the dashboard.

And a partial unique index on (tenant_id, client_request_id) for the dashboard's rows — a manual
redemption is idempotent by its `clientRequestId` (no till id to key on).

Idempotent: every column and the index are looked at first. Revision ID: d1a5c3e7f902, revises
c7e4a2f9d1b6 (12.10.2026).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "d1a5c3e7f902"
down_revision: Union[str, Sequence[str], None] = "c7e4a2f9d1b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "prepaid_voucher_redemptions"
UNIQUE = "ux_prepaid_voucher_redemptions_manual_request"
COLUMNS = (
    ("source", lambda: sa.Column("source", sa.String(length=16), nullable=True)),
    ("manual", lambda: sa.Column("manual", sa.Boolean(), nullable=False, server_default=sa.false())),
    ("manual_reason", lambda: sa.Column("manual_reason", sa.String(length=200), nullable=True)),
    ("manual_by_user_id", lambda: sa.Column("manual_by_user_id", postgresql.UUID(as_uuid=True), nullable=True)),
    ("manual_by_user_name", lambda: sa.Column("manual_by_user_name", sa.String(length=200), nullable=True)),
    ("manual_override", lambda: sa.Column("manual_override", sa.JSON(), nullable=True)),
    ("reverse_reason", lambda: sa.Column("reverse_reason", sa.String(length=200), nullable=True)),
    ("reversed_by_user_name", lambda: sa.Column("reversed_by_user_name", sa.String(length=200), nullable=True)),
)


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except NameError:  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _insp():
    return sa.inspect(op.get_bind())


def _has_table(table: str) -> bool:
    return True if _offline() else _insp().has_table(table)


def _has_column(table: str, column: str) -> bool:
    if _offline():
        return False
    insp = _insp()
    return insp.has_table(table) and column in {c["name"] for c in insp.get_columns(table)}


def _indexes(table: str) -> set:
    return set() if _offline() else {i["name"] for i in _insp().get_indexes(table)}


def upgrade() -> None:
    if not _has_table(TABLE):
        return
    if op.get_context().dialect.name == "postgresql":
        # Never wait behind a long query on a busy table: fail fast, the deploy retries.
        op.execute(sa.text("SET LOCAL lock_timeout = '10s'"))
    for column, make in COLUMNS:
        if not _has_column(TABLE, column):
            op.add_column(TABLE, make())
    if UNIQUE not in _indexes(TABLE):
        op.create_index(
            UNIQUE, TABLE, ["tenant_id", "client_request_id"], unique=True,
            postgresql_where=sa.text("source = 'dashboard'"), sqlite_where=sa.text("source = 'dashboard'"),
        )


def downgrade() -> None:
    if not _offline() and UNIQUE in _indexes(TABLE):
        op.drop_index(UNIQUE, table_name=TABLE)
    for column, _make in reversed(COLUMNS):
        if _has_column(TABLE, column):
            op.drop_column(TABLE, column)
