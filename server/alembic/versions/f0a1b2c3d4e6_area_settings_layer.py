"""POS settings for a point of sale: a layer between the shop and its tills

* `shop_areas.settings` — the area's own overrides, the same keys as the other layers.
  `{}` for every existing area.
* `shop_areas.settings_updated_at` — when they last changed. NULL for every existing
  area, so no till's settings watermark moves on upgrade.

Parent is the till app releases (f0a1b2c3d4e5).

Revision ID: f0a1b2c3d4e6
Revises: f0a1b2c3d4e5
Create Date: 2026-10-03 23:30:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f0a1b2c3d4e6"
down_revision = "f0a1b2c3d4e5"
branch_labels = None
depends_on = None


def _existing_columns() -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("shop_areas")}


def upgrade() -> None:
    # Guarded like the tables of d0e1f2a3b4c5: on a database the app started against
    # first, `create_all` made `shop_areas` from the model if it was missing, columns
    # included.
    columns = _existing_columns()
    if "settings" not in columns:
        op.add_column(
            "shop_areas",
            sa.Column("settings", postgresql.JSONB(), nullable=False, server_default="{}"),
        )
    if "settings_updated_at" not in columns:
        op.add_column(
            "shop_areas",
            sa.Column("settings_updated_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("shop_areas", "settings_updated_at")
    op.drop_column("shop_areas", "settings")
