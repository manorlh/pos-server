"""shop_active_log — who turned a shop off or back on, when and why

"סניף לא פעיל" (P:/specs/shop-code-and-inactive.md §3, approved 13.10.2026): only the super
admin turns a shop off or back on, with a reason, and "כל שינוי נרשם, עם מי, מתי והסיבה". One
row per change (app/models/shop_active_log.py, app/services/shop_active.py). The flag itself is
the existing `shops.is_active`; nothing on `shops` changes, and existing shops are untouched.

Idempotent: the API's create_all may have made the table before this runs — then only its
missing index is added. Never needs a downgrade in practice; the downgrade drops only what this
revision adds.

Revision ID: e5a1c9d3b7f2, revises c7e4a2f9d1b6 (13.10.2026).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "e5a1c9d3b7f2"
down_revision: Union[str, Sequence[str], None] = "c7e4a2f9d1b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "shop_active_log"
INDEXES = (("ix_shop_active_log_shop_created", ["shop_id", "created_at"]),)


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except NameError:  # run by hand (a test) outside alembic's environment: its migration context says
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_table(table: str) -> bool:
    if _offline():
        return False
    return sa.inspect(op.get_bind()).has_table(table)


def _indexes(table: str) -> set:
    if _offline() or not _has_table(table):
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _uuid():
    return postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    if not _has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", _uuid(), primary_key=True),
            sa.Column("tenant_id", _uuid(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", _uuid(), sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("active", sa.Boolean(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("user_id", _uuid(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    have = _indexes(TABLE)
    for name, columns in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, columns)


def downgrade() -> None:
    if _has_table(TABLE):
        op.drop_table(TABLE)
