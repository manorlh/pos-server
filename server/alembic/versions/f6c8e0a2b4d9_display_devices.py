"""Display devices: KDS and the "מוכן / לא מוכן" board are not tills (docs/SPEC_DEVICE_ROLE_MODEL.md §2.2)

* `pos_machines.is_fiscal` — false for a display device (no register number, shifts, Z,
  payments or documents). NOT NULL, default true: every existing machine stays what it
  was. Nothing here changes the fiscal status of an existing machine — a till that shows a
  KDS screen today, with or without documents, stays a till (the dashboard flags it).
* `pos_machines.platform` — "android" | "windows", from `device_info.platform` at pairing.
* `pairing_codes.platform`, `pairing_codes.kds_options` — the platform a code is for, and a
  KDS / board code's screen; `pairing_codes.device_role` widened for "order_status_board".

Idempotent and guarded: the app's `create_all` may have added nothing here (columns are
never added by it), but a re-run must not fail either. Offline mode emits plain DDL.

Revision ID: f6c8e0a2b4d9
Revises: f3a9c1e7b5d2
Create Date: 2026-10-07 12:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa


revision = "f6c8e0a2b4d9"
down_revision = "f3a9c1e7b5d2"
branch_labels = None
depends_on = None


def _columns(table: str) -> dict:
    if context.is_offline_mode():
        return {}
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return {}
    return {c["name"]: c for c in inspector.get_columns(table)}


def _indexes(table: str) -> set:
    if context.is_offline_mode():
        return set()
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {i["name"] for i in inspector.get_indexes(table)}


def upgrade() -> None:
    machines = _columns("pos_machines")
    if "is_fiscal" not in machines:
        op.add_column(
            "pos_machines",
            sa.Column("is_fiscal", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if "platform" not in machines:
        op.add_column("pos_machines", sa.Column("platform", sa.String(16), nullable=True))
    if "ix_pos_machines_is_fiscal" not in _indexes("pos_machines"):
        op.create_index("ix_pos_machines_is_fiscal", "pos_machines", ["is_fiscal"])

    codes = _columns("pairing_codes")
    if "platform" not in codes:
        op.add_column("pairing_codes", sa.Column("platform", sa.String(16), nullable=True))
    if "kds_options" not in codes:
        op.add_column("pairing_codes", sa.Column("kds_options", sa.JSON(), nullable=True))
    role = codes.get("device_role")
    length = getattr(role["type"], "length", None) if role is not None else None
    if context.is_offline_mode() or (length is not None and length < 32):
        op.alter_column(
            "pairing_codes", "device_role",
            existing_type=sa.String(length or 16), type_=sa.String(32), existing_nullable=True,
        )


def downgrade() -> None:
    # Never run on a shared database (see the project notes): fix forward instead.
    op.drop_index("ix_pos_machines_is_fiscal", table_name="pos_machines")
    op.drop_column("pos_machines", "platform")
    op.drop_column("pos_machines", "is_fiscal")
    op.drop_column("pairing_codes", "kds_options")
    op.drop_column("pairing_codes", "platform")
