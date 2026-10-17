"""unpair safety and pairing from the cloud (P:/specs/foreign-records-upload.md §5.1, §6)

* `pos_machines.unpaired_at` / `unpaired_by` / `unpaired_info` — the device said it unpaired
  (`POST /sync/{m}/unpaired`): when, by whom, and {reason, pending, deviceInfo}. The dashboard shows
  "לא מצומד — ממתין לצימוד מחדש" until the machine's next pairing clears them.
* `device_pairing_requests.device_code` / `code_expires_at` — the short "קוד מכשיר" an unpaired
  device shows (§6.1), `last_tenant_id` — the tenant of its last pairing (the dashboard's pending
  list), `claimed_by_user_id` — who claimed it from the dashboard (§6.2).

Add-only and idempotent (each column looked at first: the API's create_all may have made it).

Revision ID: d9e4b1f7a3c6
Revises: a1d5e8c3b7f2
Create Date: 2026-10-17 23:30:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "d9e4b1f7a3c6"
down_revision: Union[str, Sequence[str], None] = "a1d5e8c3b7f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _columns(table: str) -> set:
    """The table's columns — offline: none of ours yet."""
    if _offline():
        return set()
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(table):
        return {"__missing__"}
    return {c["name"] for c in inspector.get_columns(table)}


def _indexes(table: str) -> set:
    if _offline():
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    machines = _columns("pos_machines")
    if "__missing__" not in machines:
        if "unpaired_at" not in machines:
            op.add_column("pos_machines", sa.Column("unpaired_at", sa.DateTime(timezone=True), nullable=True))
        if "unpaired_by" not in machines:
            op.add_column("pos_machines", sa.Column("unpaired_by", sa.String(200), nullable=True))
        if "unpaired_info" not in machines:
            op.add_column("pos_machines", sa.Column("unpaired_info", sa.JSON(), nullable=True))
    requests = _columns("device_pairing_requests")
    if "__missing__" not in requests:
        if "device_code" not in requests:
            op.add_column("device_pairing_requests", sa.Column("device_code", sa.String(8), nullable=True))
        if "code_expires_at" not in requests:
            op.add_column("device_pairing_requests", sa.Column("code_expires_at", sa.DateTime(timezone=True), nullable=True))
        if "last_tenant_id" not in requests:
            op.add_column(
                "device_pairing_requests", sa.Column("last_tenant_id", postgresql.UUID(as_uuid=True), nullable=True)
            )
        if "claimed_by_user_id" not in requests:
            op.add_column(
                "device_pairing_requests", sa.Column("claimed_by_user_id", postgresql.UUID(as_uuid=True), nullable=True)
            )
        indexes = _indexes("device_pairing_requests")
        if "ix_device_pairing_requests_device_code" not in indexes:
            op.create_index("ix_device_pairing_requests_device_code", "device_pairing_requests", ["device_code"])
        if "ix_device_pairing_requests_last_tenant_id" not in indexes:
            op.create_index("ix_device_pairing_requests_last_tenant_id", "device_pairing_requests", ["last_tenant_id"])


def downgrade() -> None:
    requests = _columns("device_pairing_requests")
    if "__missing__" not in requests:
        indexes = _indexes("device_pairing_requests")
        for name in ("ix_device_pairing_requests_device_code", "ix_device_pairing_requests_last_tenant_id"):
            if name in indexes:
                op.drop_index(name, table_name="device_pairing_requests")
        for column in ("claimed_by_user_id", "last_tenant_id", "code_expires_at", "device_code"):
            if column in requests:
                op.drop_column("device_pairing_requests", column)
    machines = _columns("pos_machines")
    if "__missing__" not in machines:
        for column in ("unpaired_info", "unpaired_by", "unpaired_at"):
            if column in machines:
                op.drop_column("pos_machines", column)
