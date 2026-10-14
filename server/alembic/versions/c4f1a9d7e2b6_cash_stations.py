"""cash stations: the cash host role, the PayLink stations, their journal, drawer movements and commands

"מכשיר מזומן לקיוסק" (P:/specs/cash-paylink.md §11, §12): a headless Windows box in the device role
`cash_host` runs the shop's PayLink cash units ("עמדות מזומן") for the self-order kiosks.

* `pos_machines.is_cash_host` (NOT NULL, default false, indexed) — set at pairing only; `cash_status` (JSONB) +
  `cash_status_at` — the host's heartbeat `cash` block (its LAN address, its stations' state and alerts).
* `cash_stations` — one PayLink unit per row (its USB serial), its host, name, place, own settings.
* `cash_station_txs` — the host's journal of transactions (by the kiosk's `txId`, the last `seq`), with the
  owed item a till pays out ("שולם ללקוח") or the dashboard resolves, and the shop Z that took it.
* `cash_station_movements` — the station drawer's float / refill / collect / count / dump / adjust.
* `cash_host_commands` — the dashboard's commands to a host, delivered with its pull, acknowledged once.
* Data: the phone alerts' new type `cash` ("מכשיר מזומן") is added to every push preference that holds each
  type the phone alerts started with (as 3c9e5a7b1d24 / 8d4f2a6c1e93 / 396f22daf19c did) — on by default.

The cash parameters (`cash*`, `kioskOfflineBlockCash`) are built-ins, created at startup
(`ensure_builtin_parameters`). Add-only and idempotent: each table and column is looked at first (the API's
create_all may have made them). No existing row changes but the push preferences above; every machine reads
`is_cash_host` false.

Revision ID: c4f1a9d7e2b6
Revises: 4ff6c2ab6d7c
Create Date: 2026-10-14 23:30:00
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c4f1a9d7e2b6"
down_revision: Union[str, Sequence[str], None] = "4ff6c2ab6d7c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MACHINES = "pos_machines"
MACHINE_INDEX = "ix_pos_machines_is_cash_host"
STATIONS = "cash_stations"
TXS = "cash_station_txs"
MOVEMENTS = "cash_station_movements"
COMMANDS = "cash_host_commands"
RULES = "exception_alert_rules"

#: The types the phone alerts started with (a preference holding them all chose "everything").
ORIGINAL = ("till_offline", "card_terminal", "large_void", "drawer_no_sale", "till_low_sales", "target_reached")
NEW = ("cash",)


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _json():
    """JSONB on Postgres (production), plain JSON elsewhere (a test's SQLite)."""
    if _offline():
        return postgresql.JSONB()
    return postgresql.JSONB() if op.get_bind().dialect.name == "postgresql" else sa.JSON()


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
    now = sa.text("now()") if _offline() or op.get_bind().dialect.name == "postgresql" else sa.text("CURRENT_TIMESTAMP")

    # ── pos_machines ──
    if _has_table(MACHINES):
        have = _columns(MACHINES)
        if "is_cash_host" not in have:
            op.add_column(MACHINES, sa.Column("is_cash_host", sa.Boolean(), nullable=False, server_default=sa.text("false")))
        if "cash_status" not in have:
            op.add_column(MACHINES, sa.Column("cash_status", _json(), nullable=True))
        if "cash_status_at" not in have:
            op.add_column(MACHINES, sa.Column("cash_status_at", sa.DateTime(timezone=True), nullable=True))
        if MACHINE_INDEX not in _indexes(MACHINES):
            op.create_index(MACHINE_INDEX, MACHINES, ["is_cash_host"])

    # ── cash_stations ──
    if not _has_table(STATIONS):
        op.create_table(
            STATIONS,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company_id", uid, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", uid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("host_machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("location", sa.String(100), nullable=True),
            sa.Column("serial", sa.String(32), nullable=False, server_default=""),
            sa.Column("settings", _json(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("created_by", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
        )
        op.create_index("ix_cash_stations_tenant_id", STATIONS, ["tenant_id"])
        op.create_index("ix_cash_stations_shop", STATIONS, ["shop_id", "is_active"])
        op.create_index("ix_cash_stations_host", STATIONS, ["host_machine_id"])

    # ── cash_station_txs ──
    if not _has_table(TXS):
        money = [
            sa.Column(name, sa.BigInteger(), nullable=False, server_default="0")
            for name in (
                "amount_agorot", "due_agorot", "inserted_agorot", "change_due_agorot", "change_paid_agorot",
                "change_owed_agorot", "refund_due_agorot", "refund_paid_agorot", "held_agorot",
            )
        ]
        op.create_table(
            TXS,
            sa.Column("tx_id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("station_id", uid, sa.ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("host_machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("client_machine_id", uid, nullable=True),
            sa.Column("shop_id", uid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("state", sa.String(16), nullable=False),
            sa.Column("outcome", sa.String(20), nullable=True),
            *money,
            sa.Column("rounding_agorot", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("held_reason", sa.String(32), nullable=True),
            sa.Column("cancel_reason", sa.String(32), nullable=True),
            sa.Column("slip_code", sa.String(32), nullable=True),
            sa.Column("order_ref", sa.String(100), nullable=True),
            sa.Column("order_label", sa.String(100), nullable=True),
            sa.Column("device_serial", sa.String(64), nullable=True),
            sa.Column("document_id", sa.String(64), nullable=True),
            sa.Column("document_number", sa.String(64), nullable=True),
            sa.Column("acked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("seq", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("data", _json(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("owed_status", sa.String(12), nullable=False, server_default="none"),
            sa.Column("owed_kind", sa.String(16), nullable=True),
            sa.Column("owed_agorot", sa.BigInteger(), nullable=True),
            sa.Column("owed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("resolved_by_machine_id", uid, nullable=True),
            sa.Column("resolved_by_user", _json(), nullable=True),
            sa.Column("resolution", sa.String(20), nullable=True),
            sa.Column("resolution_note", sa.String(300), nullable=True),
            sa.Column("movement_id", uid, nullable=True),
            sa.Column("paid_shift_id", uid, nullable=True),
            sa.Column("paid_agorot", sa.BigInteger(), nullable=True),
            sa.Column("z_report_id", uid, nullable=True),
            sa.UniqueConstraint("movement_id", name="uq_cash_station_txs_movement_id"),
        )
        op.create_index("ix_cash_station_txs_tenant_id", TXS, ["tenant_id"])
        op.create_index("ix_cash_station_txs_station_created", TXS, ["station_id", "created_at"])
        op.create_index("ix_cash_station_txs_shop_owed", TXS, ["shop_id", "owed_status"])
        op.create_index("ix_cash_station_txs_z", TXS, ["z_report_id"])

    # ── cash_station_movements ──
    if not _has_table(MOVEMENTS):
        op.create_table(
            MOVEMENTS,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("station_id", uid, sa.ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("host_machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("shop_id", uid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(12), nullable=False),
            sa.Column("amount_agorot", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("expected_agorot", sa.BigInteger(), nullable=True),
            sa.Column("counted_agorot", sa.BigInteger(), nullable=True),
            sa.Column("pieces", _json(), nullable=True),
            sa.Column("by", _json(), nullable=True),
            sa.Column("note", sa.String(300), nullable=True),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("z_report_id", uid, nullable=True),
        )
        op.create_index("ix_cash_station_movements_tenant_id", MOVEMENTS, ["tenant_id"])
        op.create_index("ix_cash_station_movements_station_at", MOVEMENTS, ["station_id", "at"])
        op.create_index("ix_cash_station_movements_z", MOVEMENTS, ["z_report_id"])

    # ── cash_host_commands ──
    if not _has_table(COMMANDS):
        op.create_table(
            COMMANDS,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("host_machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("station_id", uid, sa.ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("op", sa.String(20), nullable=False),
            sa.Column("args", _json(), nullable=True),
            sa.Column("by", _json(), nullable=True),
            sa.Column("status", sa.String(12), nullable=False, server_default="pending"),
            sa.Column("message", sa.String(300), nullable=True),
            sa.Column("movement_id", uid, nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("acked_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_cash_host_commands_tenant_id", COMMANDS, ["tenant_id"])
        op.create_index("ix_cash_host_commands_host_status", COMMANDS, ["host_machine_id", "status"])

    # ── Data: the phone alerts' `cash` type, on for "everything" ──
    _push_categories()


def _list(raw):
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    return raw if isinstance(raw, list) else None


def _push_categories() -> None:
    if _offline() or not _has_table(RULES):
        return
    bind = op.get_bind()
    json_type = postgresql.JSONB if bind.dialect.name == "postgresql" else sa.JSON
    rules = sa.table(
        RULES,
        sa.column("id"),
        sa.column("channel", sa.String),
        sa.column("categories", json_type),
        sa.column("deleted_at", sa.DateTime),
    )
    rows = bind.execute(
        sa.select(rules.c.id, rules.c.categories).where(rules.c.channel == "push", rules.c.deleted_at.is_(None))
    ).fetchall()
    for ident, raw in rows:
        chosen = _list(raw)
        if chosen is None or not all(c in chosen for c in ORIGINAL):
            continue
        missing = [c for c in NEW if c not in chosen]
        if missing:
            bind.execute(rules.update().where(rules.c.id == ident).values(categories=[*chosen, *missing]))


def downgrade() -> None:
    if _offline():
        return
    for table in (COMMANDS, MOVEMENTS, TXS, STATIONS):
        if _has_table(table):
            op.drop_table(table)
    if _has_table(MACHINES):
        if MACHINE_INDEX in _indexes(MACHINES):
            op.drop_index(MACHINE_INDEX, table_name=MACHINES)
        have = _columns(MACHINES)
        for column in ("cash_status_at", "cash_status", "is_cash_host"):
            if column in have:
                op.drop_column(MACHINES, column)
