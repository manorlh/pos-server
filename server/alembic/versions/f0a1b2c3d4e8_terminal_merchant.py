"""the business name and supplier number the till's card terminal is set up under

* `pos_machines.terminal_merchant_name`, `terminal_supplier_number` — from the
  heartbeat's `terminal` block, as Agamento names them. Null until a till reports them.

Parent is the card terminal columns (f0a1b2c3d4e7).

Revision ID: f0a1b2c3d4e8
Revises: f0a1b2c3d4e7
Create Date: 2026-10-03 21:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "f0a1b2c3d4e8"
down_revision = "f0a1b2c3d4e7"
branch_labels = None
depends_on = None


_MACHINE_COLUMNS = (
    ("terminal_merchant_name", sa.String(120)),
    ("terminal_supplier_number", sa.String(30)),
)


def _existing_columns() -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("pos_machines")}


def upgrade() -> None:
    # Guarded like f0a1b2c3d4e7: `create_all` may have made them already.
    columns = _existing_columns()
    for name, type_ in _MACHINE_COLUMNS:
        if name not in columns:
            op.add_column("pos_machines", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _type in reversed(_MACHINE_COLUMNS):
        op.drop_column("pos_machines", name)
