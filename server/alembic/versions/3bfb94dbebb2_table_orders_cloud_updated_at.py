"""table_orders.cloud_updated_at

"העברת שרת מקומי" (P:/specs/local-server-switch.md §8, gap 1): a till that was the shop's server
before a switch comes back with table changes it never uploaded, and the cloud applies only the
orders it has not changed since the switch. `updated_at` is the till's own clock for a LAN host's
mirror, so the cloud keeps its own: when it took the last write (nullable — older rows have none).

Idempotent: the column is looked at first (the API's create_all may have added it). Never needs a
downgrade in practice; the downgrade drops only what this revision adds.

Revision ID: 3bfb94dbebb2, revises c7e4a2f9d1b6 (13.10.2026).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "3bfb94dbebb2"
down_revision: Union[str, Sequence[str], None] = "c7e4a2f9d1b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "table_orders"
COLUMN = "cloud_updated_at"


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except NameError:  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_table() -> bool:
    if _offline():
        return True
    return sa.inspect(op.get_bind()).has_table(TABLE)


def _has_column() -> bool:
    if _offline():
        return False
    insp = sa.inspect(op.get_bind())
    return insp.has_table(TABLE) and COLUMN in {c["name"] for c in insp.get_columns(TABLE)}


def upgrade() -> None:
    if _has_table() and not _has_column():
        op.add_column(TABLE, sa.Column(COLUMN, sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    if not _offline() and _has_column():
        op.drop_column(TABLE, COLUMN)
