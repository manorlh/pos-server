"""cashmag: credits for change owed at a CashMag kiosk (no station)

"מכשיר מזומן CashMag" (P:/specs/cashmag-windows.md §6): a kiosk paying at a CashMag machine has no station of ours.
When its customer keeps the change owed as a credit ("זיכוי להזמנה הבאה"), the cloud makes the credit from the kiosk's
document — a `cash_station_txs` row with no station:

* `cash_station_txs.station_id` and `cash_credit_redemptions.station_id` — nullable (a CashMag credit and its
  redemptions have no station);
* `cash_station_txs.device` (nullable) — "cashmag" for such a row; null for every station's.

Idempotent (each column looked at first; the API's create_all may have made them). No existing row changes.

Revision ID: f3b8d2c6a9e1
Revises: e5a9c3d1f7b2
Create Date: 2026-10-16 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "f3b8d2c6a9e1"
down_revision: Union[str, Sequence[str], None] = "e5a9c3d1f7b2"
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


def _columns(table: str) -> dict:
    """{name: column} of [table]; offline (SQL output) every table is taken as there, as it is on production."""
    if _offline():
        return {}
    insp = sa.inspect(op.get_bind())
    if not insp.has_table(table):
        return {}
    return {c["name"]: c for c in insp.get_columns(table)}


def _station_nullable(table: str, columns: dict) -> None:
    col = columns.get("station_id")
    if not _offline() and (col is None or col.get("nullable")):
        return
    if not _offline() and op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table(table) as batch:
            batch.alter_column("station_id", existing_type=col["type"], nullable=True)
        return
    op.alter_column(table, "station_id", nullable=True)


def upgrade() -> None:
    txs = _columns(TXS)
    if _offline() or txs:
        _station_nullable(TXS, txs)
        if _offline() or "device" not in txs:
            op.add_column(TXS, sa.Column("device", sa.String(16), nullable=True))
    redemptions = _columns(REDEMPTIONS)
    if _offline() or redemptions:
        _station_nullable(REDEMPTIONS, redemptions)


def downgrade() -> None:
    # The station columns stay nullable (a CashMag credit may be there); only the marker column goes.
    if _offline():
        return
    if "device" in _columns(TXS):
        op.drop_column(TXS, "device")
