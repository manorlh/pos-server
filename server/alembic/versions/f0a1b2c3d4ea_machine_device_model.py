"""which hardware a till is: a Nova 55F (built-in printer) or a Modo (no printer)

* `pos_machines.device_model` — "N55F" | "MODO", null = unknown. Responses derive
  `hasPrinter` from it, and null reads as a 55F: every till that existed before this
  column has a printer.
* `pairing_codes.device_model` — the model chosen when the code was generated, copied
  onto the machine when a device redeems it.

Parent is the area and category availability tables (f0a1b2c3d4e9).

Revision ID: f0a1b2c3d4ea
Revises: f0a1b2c3d4e9
Create Date: 2026-10-04 10:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "f0a1b2c3d4ea"
down_revision = "f0a1b2c3d4e9"
branch_labels = None
depends_on = None


_TABLES = ("pos_machines", "pairing_codes")


def _existing_columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    # Guarded like f0a1b2c3d4e8: `create_all` may have made them already.
    for table in _TABLES:
        if "device_model" not in _existing_columns(table):
            op.add_column(table, sa.Column("device_model", sa.String(16), nullable=True))


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.drop_column(table, "device_model")
