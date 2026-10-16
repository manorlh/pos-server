"""cash: the host kiosk ("מארח עמדת מזומן") and the cloud relay

P:/specs/cash-paylink.md §14 (owner, 16.10):

* `pos_machines.cash_host_embedded` (NOT NULL, default false) — a Windows kiosk whose PC has the PayLink on USB is
  also the cash host of its station(s) (§14.1). Off for every existing device.
* `cash_relay_requests` — the cloud relay (§14.4): one LAN call of a client whose `cashRoute` is cloud / auto, kept
  as the client signed it for the station's host, handed to the host once, with the host's answer. Kept a day.

Add-only and idempotent (each column and table looked at first; the API's create_all may have made them). No
existing row changes.

Revision ID: f3a8c6e1d9b4
Revises: e5a9c3d1f7b2
Create Date: 2026-10-16 12:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "f3a8c6e1d9b4"
down_revision: Union[str, Sequence[str], None] = "e5a9c3d1f7b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MACHINES = "pos_machines"
RELAY = "cash_relay_requests"


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_table(table: str) -> bool:
    if _offline():
        return table == MACHINES
    return sa.inspect(op.get_bind()).has_table(table)


def _columns(table: str) -> set:
    if _offline() or not _has_table(table):
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set:
    if _offline() or not _has_table(table):
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    now = sa.text("now()") if _offline() or op.get_bind().dialect.name == "postgresql" else sa.text("CURRENT_TIMESTAMP")

    if _has_table(MACHINES) and "cash_host_embedded" not in _columns(MACHINES):
        op.add_column(MACHINES, sa.Column("cash_host_embedded", sa.Boolean(), nullable=False, server_default=sa.text("false")))

    if not _has_table(RELAY):
        op.create_table(
            RELAY,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("station_id", uid, sa.ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("host_machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("client_machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("method", sa.String(8), nullable=False),
            sa.Column("path", sa.String(300), nullable=False),
            sa.Column("signed", jsonb, nullable=False),
            sa.Column("body", sa.Text(), nullable=False, server_default=""),
            sa.Column("digest", sa.String(64), nullable=False),
            sa.Column("state", sa.String(12), nullable=False, server_default="pending"),
            sa.Column("reply", jsonb, nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("taken_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        )
    have = _indexes(RELAY)
    for name, columns in (
        ("ix_cash_relay_requests_tenant_id", ["tenant_id"]),
        ("ix_cash_relay_requests_host_state", ["host_machine_id", "state", "created_at"]),
        ("ix_cash_relay_requests_created", ["created_at"]),
    ):
        if name not in have:
            op.create_index(name, RELAY, columns)


def downgrade() -> None:
    if _offline():
        return
    if _has_table(RELAY):
        op.drop_table(RELAY)
    if _has_table(MACHINES) and "cash_host_embedded" in _columns(MACHINES):
        op.drop_column(MACHINES, "cash_host_embedded")
