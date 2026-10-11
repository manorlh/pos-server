"""prepaid_voucher_batches.test_mode / test_mode_since / test_mode_by; prepaid_voucher_test_redemptions

"מצב בדיקה" for production voucher batches (P:/specs/voucher-test-mode.md): a batch's real vouchers are
scanned through the whole redemption while nothing is taken off them and nothing counts anywhere. Three
columns on the batch — `test_mode` NOT NULL with a server default of false (every batch so far reads as
real), when it was turned on and by whom (nullable) — and the "יומן בדיקות" table each would-be
redemption is written to instead.

Idempotent: each column and the table are looked at first (the API's create_all may have made the table
before this runs — then only its missing indexes are added). Never needs a downgrade in practice; the
downgrade drops only what this revision adds.

Revision ID: c7e4a2f9d1b6, revises b5e2c8a417d3 (12.10.2026).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c7e4a2f9d1b6"
down_revision: Union[str, Sequence[str], None] = "b5e2c8a417d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BATCHES = "prepaid_voucher_batches"
TABLE = "prepaid_voucher_test_redemptions"
COLUMNS = (
    ("test_mode", lambda: sa.Column("test_mode", sa.Boolean(), nullable=False, server_default=sa.false())),
    ("test_mode_since", lambda: sa.Column("test_mode_since", sa.DateTime(timezone=True), nullable=True)),
    ("test_mode_by", lambda: sa.Column("test_mode_by", sa.String(length=200), nullable=True)),
)
INDEXES = (
    ("ix_prepaid_voucher_test_redemptions_batch", ["batch_id", "created_at"]),
    ("ix_prepaid_voucher_test_redemptions_sale", ["machine_id", "sale_ref"]),
    ("ix_prepaid_voucher_test_redemptions_tenant_id", ["tenant_id"]),
)


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except NameError:  # run by hand (a test) outside alembic's environment: its migration context says
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _insp():
    return sa.inspect(op.get_bind())


def _has_table(table: str) -> bool:
    if _offline():
        return table == BATCHES
    return _insp().has_table(table)


def _has_column(table: str, column: str) -> bool:
    if _offline():
        return False
    insp = _insp()
    return insp.has_table(table) and column in {c["name"] for c in insp.get_columns(table)}


def _indexes(table: str) -> set:
    if _offline():
        return set()
    return {i["name"] for i in _insp().get_indexes(table)}


def _uuid():
    return postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    if _has_table(BATCHES):
        for column, make in COLUMNS:
            if not _has_column(BATCHES, column):
                op.add_column(BATCHES, make())
    if not _has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", _uuid(), primary_key=True),
            sa.Column("tenant_id", _uuid(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("batch_id", _uuid(), sa.ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("voucher_id", _uuid(), sa.ForeignKey("prepaid_vouchers.id", ondelete="CASCADE"), nullable=False),
            sa.Column("serial", sa.Integer(), nullable=True),
            sa.Column("machine_id", _uuid(), sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("shop_id", _uuid(), sa.ForeignKey("shops.id", ondelete="SET NULL"), nullable=True),
            sa.Column("pos_user_id", sa.String(length=100), nullable=True),
            sa.Column("pos_user_name", sa.String(length=200), nullable=True),
            sa.Column("operation", sa.String(length=16), nullable=False),
            sa.Column("client_request_id", sa.String(length=100), nullable=False),
            sa.Column("sale_ref", sa.String(length=100), nullable=True),
            sa.Column("status", sa.String(length=16), nullable=False),
            sa.Column("transaction_id", sa.String(length=100), nullable=True),
            sa.Column("items", sa.JSON(), nullable=True),
            sa.Column("forfeited", sa.JSON(), nullable=True),
            sa.Column("units", sa.JSON(), nullable=True),
            sa.Column("covered_agorot", sa.Integer(), nullable=True),
            sa.Column("value_agorot", sa.Integer(), nullable=True),
            sa.Column("top_up_agorot", sa.Integer(), nullable=True),
            sa.Column("list_value_agorot", sa.Integer(), nullable=True),
            sa.Column("discount_agorot", sa.Integer(), nullable=True),
            sa.Column("uses", sa.Integer(), nullable=True),
            sa.Column("redemption_accounting", sa.String(length=16), nullable=True),
            sa.Column("remaining_after", sa.JSON(), nullable=True),
            sa.Column("answer", sa.JSON(), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("machine_id", "operation", "client_request_id",
                                name="uq_prepaid_voucher_test_redemptions_request"),
        )
    have = _indexes(TABLE)
    for name, columns in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, columns)


def downgrade() -> None:
    if _has_table(TABLE):
        op.drop_table(TABLE)
    for column, _make in reversed(COLUMNS):
        if _has_column(BATCHES, column):
            op.drop_column(BATCHES, column)
