"""shop Z from a master till: strict cloud verification, and the fast heartbeat

docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §3.5–§3.6:

* `z_runs.strict_cloud_check` — a run started from the shop's master till: the Z is built
  only once the cloud holds, for every till, the shift closed, its close accepted and every
  sale the till counted (`app.services.z_runs.verify_item`). False for the dashboard's runs.
* `pos_machines.shop_z_screen_until` — the master till has "סגירת Z סניפי" open: until
  then the shop's other tills beat every few seconds, so a close sent to them is picked up
  at once even without realtime.

Guarded: a dev database may already have a column from an earlier run of this revision.

Revision ID: a8e4c2f7d9b1
Revises: f6c9e1a2b3d4
Create Date: 2026-10-04 03:40:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "a8e4c2f7d9b1"
down_revision = "f6c9e1a2b3d4"
branch_labels = None
depends_on = None


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if "strict_cloud_check" not in _columns("z_runs"):
        op.add_column(
            "z_runs",
            sa.Column("strict_cloud_check", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if "shop_z_screen_until" not in _columns("pos_machines"):
        op.add_column(
            "pos_machines",
            sa.Column("shop_z_screen_until", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    if "shop_z_screen_until" in _columns("pos_machines"):
        op.drop_column("pos_machines", "shop_z_screen_until")
    if "strict_cloud_check" in _columns("z_runs"):
        op.drop_column("z_runs", "strict_cloud_check")
