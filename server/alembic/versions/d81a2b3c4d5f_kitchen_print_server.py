"""kitchen printers: the shop's print server ("שרת הדפסות") replaces the per-printer LAN host

* `kitchen_print_hosts` — where the shop's print server till (till parameter
  `printHostTill`) listens on the shop's LAN, as it reports on its heartbeat cadence.
* The per-printer `host` connection type of c69e0f1a2b38 is folded into it: its columns
  go, a printer still of that type becomes `cloud` (same host till), and the connection
  type check is the four types again.

Guarded: the app's `create_all` may already have made the new table.

Revision ID: d81a2b3c4d5f
Revises: c7a1b2c3d4e5
Create Date: 2026-10-04 06:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "d81a2b3c4d5f"
down_revision = "c7a1b2c3d4e5"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
_CK = "ck_kitchen_printers_connection_type"
_FOUR = "connection_type IN ('network', 'bluetooth', 'cloud', 'till')"
_FIVE = "connection_type IN ('network', 'bluetooth', 'cloud', 'host', 'till')"


def _tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if "kitchen_print_hosts" not in _tables():
        op.create_table(
            "kitchen_print_hosts",
            sa.Column(
                "machine_id", UUID, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True
            ),
            sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=True),
            sa.Column("lan_address", sa.String(64), nullable=True),
            sa.Column("port", sa.Integer(), nullable=True),
            sa.Column("reported_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_kitchen_print_hosts_shop_id", "kitchen_print_hosts", ["shop_id"])

    op.execute("UPDATE kitchen_printers SET connection_type = 'cloud' WHERE connection_type = 'host'")
    op.execute(f"ALTER TABLE kitchen_printers DROP CONSTRAINT IF EXISTS {_CK}")
    op.create_check_constraint(_CK, "kitchen_printers", _FOUR)
    columns = _columns("kitchen_printers")
    for column in ("host_lan_address", "host_lan_port"):
        if column in columns:
            op.drop_column("kitchen_printers", column)


def downgrade() -> None:
    op.add_column("kitchen_printers", sa.Column("host_lan_address", sa.String(255), nullable=True))
    op.add_column("kitchen_printers", sa.Column("host_lan_port", sa.Integer(), nullable=True))
    op.execute(f"ALTER TABLE kitchen_printers DROP CONSTRAINT IF EXISTS {_CK}")
    op.create_check_constraint(_CK, "kitchen_printers", _FIVE)
    op.drop_index("ix_kitchen_print_hosts_shop_id", table_name="kitchen_print_hosts")
    op.drop_table("kitchen_print_hosts")
