"""The cash drawer module ("מגירת מזומן", docs/SPEC_ROLES_PERMISSIONS.md)

* `cash_drawer_events` — the tills' drawer audit (the drawer spec §14): every attempt to
  open a drawer (approved / denied / failed) and every permission override / refusal.
* `cash_movements` — Cash In / Cash Out / Deposit and the counts (§7, §9).

Both keyed by the till's own id (a resend is a no-op). The drawer's management
parameters are built-in till parameters (created at startup), and its exception kinds
are rules of `audit_exceptions` — neither needs DDL.

Idempotent: the auto-reloading dev API's `create_all` may make the tables before this
runs, so every table and index is looked at first. Never downgraded in place.

Revision ID: f7c3a9d1b5e8
Revises: e5b1c3d7f9a2
Create Date: 2026-10-08
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "f7c3a9d1b5e8"
down_revision: Union[str, Sequence[str], None] = "e5b1c3d7f9a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EVENTS = "cash_drawer_events"
MOVEMENTS = "cash_movements"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _has_table(insp, name: str) -> bool:
    return insp is not None and insp.has_table(name)


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    money = sa.Numeric(12, 2)

    if not _has_table(insp, EVENTS):
        op.create_table(
            EVENTS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("company_id", uuid, nullable=True),
            sa.Column("shop_id", uuid, nullable=True),
            sa.Column("area_id", uuid, nullable=True),
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id"), nullable=False),
            sa.Column("category", sa.String(16), nullable=False),
            sa.Column("event_type", sa.String(24), nullable=False),
            sa.Column("permission", sa.String(64), nullable=True),
            sa.Column("decision", sa.String(16), nullable=True),
            sa.Column("result", sa.String(16), nullable=False),
            sa.Column("result_reason", sa.String(300), nullable=True),
            sa.Column("drawer_id", sa.String(100), nullable=True),
            sa.Column("drawer_name", sa.String(200), nullable=True),
            sa.Column("device_id", sa.String(100), nullable=True),
            sa.Column("shift_id", uuid, nullable=True),
            sa.Column("employee_id", sa.String(100), nullable=True),
            sa.Column("employee_name", sa.String(200), nullable=True),
            sa.Column("employee_role", sa.String(100), nullable=True),
            sa.Column("approver_id", sa.String(100), nullable=True),
            sa.Column("approver_name", sa.String(200), nullable=True),
            sa.Column("approver_method", sa.String(16), nullable=True),
            sa.Column("table_id", sa.String(100), nullable=True),
            sa.Column("sale_id", uuid, nullable=True),
            sa.Column("payment_id", sa.String(100), nullable=True),
            sa.Column("original_sale_id", uuid, nullable=True),
            sa.Column("reason", sa.String(32), nullable=True),
            sa.Column("reason_note", sa.Text(), nullable=True),
            sa.Column("movement_id", uuid, nullable=True),
            sa.Column("cash_movement_type", sa.String(16), nullable=True),
            sa.Column("amount", money, nullable=True),
            sa.Column("expected_balance", money, nullable=True),
            sa.Column("offline", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("training", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("details", postgresql.JSONB(), nullable=True),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        insp = _inspector()
    have = _indexes(insp, EVENTS)
    for name, cols in (
        ("ix_cash_drawer_events_machine_occurred", ["machine_id", "occurred_at"]),
        ("ix_cash_drawer_events_shop_occurred", ["shop_id", "occurred_at"]),
        ("ix_cash_drawer_events_shift", ["shift_id"]),
        ("ix_cash_drawer_events_tenant_occurred", ["tenant_id", "occurred_at"]),
    ):
        if name not in have:
            op.create_index(name, EVENTS, cols)

    if not _has_table(insp, MOVEMENTS):
        op.create_table(
            MOVEMENTS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("company_id", uuid, nullable=True),
            sa.Column("shop_id", uuid, nullable=True),
            sa.Column("area_id", uuid, nullable=True),
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id"), nullable=False),
            sa.Column("movement_type", sa.String(16), nullable=False),
            sa.Column("amount", money, nullable=False),
            sa.Column("expected_before", money, nullable=True),
            sa.Column("expected_after", money, nullable=True),
            sa.Column("variance", money, nullable=True),
            sa.Column("blind", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("reason", sa.String(100), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("source", sa.String(200), nullable=True),
            sa.Column("shift_id", uuid, nullable=True),
            sa.Column("employee_id", sa.String(100), nullable=True),
            sa.Column("employee_name", sa.String(200), nullable=True),
            sa.Column("approver_id", sa.String(100), nullable=True),
            sa.Column("approver_name", sa.String(200), nullable=True),
            sa.Column("drawer_event_id", uuid, nullable=True),
            sa.Column("offline", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("training", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        insp = _inspector()
    have = _indexes(insp, MOVEMENTS)
    for name, cols in (
        ("ix_cash_movements_machine_occurred", ["machine_id", "occurred_at"]),
        ("ix_cash_movements_shop_occurred", ["shop_id", "occurred_at"]),
        ("ix_cash_movements_shift", ["shift_id"]),
    ):
        if name not in have:
            op.create_index(name, MOVEMENTS, cols)


def downgrade() -> None:
    insp = _inspector()
    for table in (MOVEMENTS, EVENTS):
        if insp is None or _has_table(insp, table):
            op.drop_table(table)
