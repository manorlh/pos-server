"""Kiosk "נעילה למכירה" until a time

Revision ID: a8e2c4f6b1d9
Revises: f5d7b9c1e3a2
Create Date: 2026-10-06

docs/SPEC_KIOSK.md §15 — a controlling till (or the dashboard) stops a kiosk taking orders
until it is reopened by hand, until HH:MM today, for N minutes, or until the kiosk's next
automatic opening:

* `kiosk_devices.paused_until` — when the lock lifts by itself (null: by hand only);
* `kiosk_devices.paused_mode` — how it was set ("manual" | "time" | "minutes" | "next_open"),
  for "נעול עד …" on every screen.

Idempotent: added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a8e2c4f6b1d9'
down_revision: Union[str, Sequence[str], None] = 'f5d7b9c1e3a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ('kiosk_devices', 'paused_until', lambda: sa.DateTime(timezone=True)),
    ('kiosk_devices', 'paused_mode', lambda: sa.String(20)),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, column, kind in COLUMNS:
        if column not in {c['name'] for c in inspector.get_columns(table)}:
            op.add_column(table, sa.Column(column, kind(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, column, _kind in reversed(COLUMNS):
        if column in {c['name'] for c in inspector.get_columns(table)}:
            op.drop_column(table, column)
