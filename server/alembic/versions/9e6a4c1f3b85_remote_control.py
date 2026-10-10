"""remote control of tills and kiosks: a kiosk banner, quick hides, device commands

* `kiosk_devices.banner_message` / `banner_at` / `banner_by` / `banner_until` — "הודעה על
  המסך": shown on the kiosk's screens while it keeps selling.
* `kiosk_quick_hides` — a product or a category hidden on the kiosks of a shop until a time
  ("הגריל סגור"); added to every kiosk's `catalog.hiddenProducts` / `hiddenCategories`
  (app/services/kiosk_live.py).
* `device_commands` — one remote action for one device with its delivery and acknowledgement
  (the audit), and `device_remote_states` — what a device must be now ("נעל קופה")
  (app/services/device_commands.py).

Idempotent (columns, the table and its indexes are looked at first). Never downgraded in place.

Revision ID: 9e6a4c1f3b85
Revises: 8d5f3b0e2a74
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "9e6a4c1f3b85"
down_revision: Union[str, Sequence[str], None] = "8d5f3b0e2a74"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEVICES = "kiosk_devices"
HIDES = "kiosk_quick_hides"
COMMANDS = "device_commands"
STATES = "device_remote_states"
BANNER_COLUMNS = (
    ("banner_message", sa.String(300)),
    ("banner_at", sa.DateTime(timezone=True)),
    ("banner_by", sa.String(200)),
    ("banner_until", sa.DateTime(timezone=True)),
)
INDEXES = (
    ("ix_kiosk_quick_hides_tenant_id", ["tenant_id"]),
    ("ix_kiosk_quick_hides_shop", ["shop_id", "cleared_at"]),
)


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    have_cols = set() if insp is None else {c["name"] for c in insp.get_columns(DEVICES)}
    for name, type_ in BANNER_COLUMNS:
        if name not in have_cols:
            op.add_column(DEVICES, sa.Column(name, type_, nullable=True))

    if insp is None or not insp.has_table(HIDES):
        op.create_table(
            HIDES,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("item_id", uuid, nullable=False),
            sa.Column("item_name", sa.String(255), nullable=True),
            sa.Column("until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("note", sa.String(200), nullable=True),
            sa.Column("created_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("cleared_by_name", sa.String(200), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        have = set()
    else:
        have = {i["name"] for i in insp.get_indexes(HIDES)}
    for name, cols in INDEXES:
        if name not in have:
            op.create_index(name, HIDES, cols)

    # ── remote commands to tills and kiosks, and what a device must be now ──
    if insp is None or not insp.has_table(COMMANDS):
        op.create_table(
            COMMANDS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="SET NULL"), nullable=True),
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("batch_id", uuid, nullable=True),
            sa.Column("action", sa.String(32), nullable=False),
            sa.Column("message", sa.String(300), nullable=True),
            sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
            sa.Column("detail", sa.String(300), nullable=True),
            sa.Column("source", sa.String(16), nullable=False, server_default="dashboard"),
            sa.Column("created_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        have = set()
    else:
        have = {i["name"] for i in insp.get_indexes(COMMANDS)}
    for name, cols in (
        ("ix_device_commands_tenant_id", ["tenant_id"]),
        ("ix_device_commands_batch_id", ["batch_id"]),
        ("ix_device_commands_machine_status", ["machine_id", "status"]),
        ("ix_device_commands_shop_created", ["shop_id", "created_at"]),
    ):
        if name not in have:
            op.create_index(name, COMMANDS, cols)
    if insp is None or not insp.has_table(STATES):
        op.create_table(
            STATES,
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("locked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("lock_message", sa.String(300), nullable=True),
            sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("locked_by", sa.String(200), nullable=True),
            sa.Column("unlocked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("unlocked_by", sa.String(200), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_device_remote_states_tenant_id", STATES, ["tenant_id"])


def downgrade() -> None:
    op.drop_table(STATES)
    op.drop_table(COMMANDS)
    op.drop_table(HIDES)
    for name, _type in BANNER_COLUMNS:
        op.drop_column(DEVICES, name)
