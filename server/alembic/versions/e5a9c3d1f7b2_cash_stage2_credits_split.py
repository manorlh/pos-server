"""cash stage 2: the customer's choice for change owed, cash + card, cash credits and their redemptions

"מכשיר מזומן לקיוסק" stage 2 (P:/specs/cash-paylink.md §11.15):

* `cash_station_txs.change_owed_ask` (NOT NULL, default false) / `change_owed_as` (slip | credit | tip) — under the
  station policy `ask` the kiosk asks the customer what to do with change the unit could not pay;
  `split_agorot` (NOT NULL, default 0) — cash + card: what the cash paid (the card paid the rest).
* `cash_credit_redemptions` — a cash credit ("זיכוי להזמנה הבאה", an owed item of kind `change_credit`) redeemed
  towards an order at a till or a kiosk: by the device's own id (idempotent), its amount, released when the order
  was not paid, confirmed by the document's `cash_credit` leg.

Add-only and idempotent (each column and table looked at first; the API's create_all may have made them). No
existing row changes.

Revision ID: e5a9c3d1f7b2
Revises: d2c7a5e9f1b3
Create Date: 2026-10-15 10:30:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "e5a9c3d1f7b2"
down_revision: Union[str, Sequence[str], None] = "d2c7a5e9f1b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TXS = "cash_station_txs"
REDEMPTIONS = "cash_credit_redemptions"


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
        return table == TXS
    return sa.inspect(op.get_bind()).has_table(table)


def _columns(table: str) -> set:
    if _offline() or not _has_table(table):
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    now = sa.text("now()") if _offline() or op.get_bind().dialect.name == "postgresql" else sa.text("CURRENT_TIMESTAMP")

    if _has_table(TXS):
        have = _columns(TXS)
        if "change_owed_ask" not in have:
            op.add_column(TXS, sa.Column("change_owed_ask", sa.Boolean(), nullable=False, server_default=sa.text("false")))
        if "change_owed_as" not in have:
            op.add_column(TXS, sa.Column("change_owed_as", sa.String(8), nullable=True))
        if "split_agorot" not in have:
            op.add_column(TXS, sa.Column("split_agorot", sa.BigInteger(), nullable=False, server_default="0"))

    if not _has_table(REDEMPTIONS):
        op.create_table(
            REDEMPTIONS,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("tx_id", uid, sa.ForeignKey("cash_station_txs.tx_id", ondelete="CASCADE"), nullable=False),
            sa.Column("station_id", uid, sa.ForeignKey("cash_stations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("code", sa.String(32), nullable=False),
            sa.Column("machine_id", uid, nullable=True),
            sa.Column("amount_agorot", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(12), nullable=False, server_default="redeemed"),
            sa.Column("document_id", uid, nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_cash_credit_redemptions_tenant_id", REDEMPTIONS, ["tenant_id"])
        op.create_index("ix_cash_credit_redemptions_tx", REDEMPTIONS, ["tx_id", "status"])


def downgrade() -> None:
    if _offline():
        return
    if _has_table(REDEMPTIONS):
        op.drop_table(REDEMPTIONS)
    if _has_table(TXS):
        have = _columns(TXS)
        for column in ("split_agorot", "change_owed_as", "change_owed_ask"):
            if column in have:
                op.drop_column(TXS, column)
