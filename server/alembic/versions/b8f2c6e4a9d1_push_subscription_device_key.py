"""push_subscriptions.device_key: one subscription per browser per user (fix/pwa-push)

"ההתראות לווינדוס ולאנדרואיד לא עובדות מ-PWA" (16.10): a browser that subscribed again (a new
endpoint after a sign-out, a key rotation or an expired subscription) left its older row active
beside the new one. The dashboard now sends its own random browser id (localStorage); a new
subscription from the same browser of the same user replaces the older row.

* `push_subscriptions.device_key` — String(64), nullable (every existing row: unknown, as before).
* `ix_push_subscriptions_user_device` on (user_id, device_key).

Add-only and idempotent (the API's create_all may have made them first); offline (`--sql`) the
plain statements.

Revision ID: b8f2c6e4a9d1
Revises: e5a9c3d1f7b2
Create Date: 2026-10-16 12:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8f2c6e4a9d1"
down_revision: Union[str, Sequence[str], None] = "e5a9c3d1f7b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "push_subscriptions"
COLUMN = "device_key"
INDEX = "ix_push_subscriptions_user_device"


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _has_column() -> bool:
    if _offline():
        return False
    return COLUMN in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def _has_index() -> bool:
    if _offline():
        return False
    return INDEX in {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(TABLE)}


def upgrade() -> None:
    if not _has_column():
        op.add_column(TABLE, sa.Column(COLUMN, sa.String(64), nullable=True))
    if not _has_index():
        op.create_index(INDEX, TABLE, ["user_id", COLUMN])


def downgrade() -> None:
    if _offline() or _has_index():
        op.drop_index(INDEX, table_name=TABLE)
    if _offline() or _has_column():
        op.drop_column(TABLE, COLUMN)
