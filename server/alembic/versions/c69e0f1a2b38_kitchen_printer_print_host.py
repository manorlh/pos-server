"""kitchen printers: the LAN print host ("שרת הדפסות")

A printer of connection type `host` is printed by one till of the shop (its host) for
every other till, which sends its jobs to the host over the shop's LAN — the host's
address and port are `host_lan_address` / `host_lan_port` — and through the cloud relay
when the host cannot be reached on the LAN.

Guarded: the columns may already exist on a dev database that ran this revision.

Revision ID: c69e0f1a2b38
Revises: c58d9e0f1a27
Create Date: 2026-10-04 05:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "c69e0f1a2b38"
down_revision = "c58d9e0f1a27"
branch_labels = None
depends_on = None

_OLD = "connection_type IN ('network', 'bluetooth', 'cloud', 'till')"
_NEW = "connection_type IN ('network', 'bluetooth', 'cloud', 'host', 'till')"
_CK = "ck_kitchen_printers_connection_type"


def _columns() -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("kitchen_printers")}


def upgrade() -> None:
    columns = _columns()
    if "host_lan_address" not in columns:
        op.add_column("kitchen_printers", sa.Column("host_lan_address", sa.String(255), nullable=True))
    if "host_lan_port" not in columns:
        op.add_column("kitchen_printers", sa.Column("host_lan_port", sa.Integer(), nullable=True))
    op.execute(f"ALTER TABLE kitchen_printers DROP CONSTRAINT IF EXISTS {_CK}")
    op.create_check_constraint(_CK, "kitchen_printers", _NEW)


def downgrade() -> None:
    op.execute("UPDATE kitchen_printers SET connection_type = 'cloud' WHERE connection_type = 'host'")
    op.execute(f"ALTER TABLE kitchen_printers DROP CONSTRAINT IF EXISTS {_CK}")
    op.create_check_constraint(_CK, "kitchen_printers", _OLD)
    op.drop_column("kitchen_printers", "host_lan_port")
    op.drop_column("kitchen_printers", "host_lan_address")
