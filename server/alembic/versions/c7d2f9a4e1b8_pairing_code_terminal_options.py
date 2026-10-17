"""pairing code terminal options: "מסופון אשראי" chosen when a device is added

The add-device dialog's "סוג מסופון" (a till or a kiosk, Android / Windows): the card terminal type and its
non-secret fields, written to the new machine's own settings layer as it pairs — the same till parameters
the device already reads (`paymentIntegration`, `nayax*`, `synqpay*`, `zcredit*`, `tapToPay*`;
app/services/device_terminal.py).

* `pairing_codes.terminal_options` JSON NULL — the cleaned settings patch; NULL = nothing to write.

Add-only and idempotent (the column looked at first: the API's create_all may have made it).

Revision ID: c7d2f9a4e1b8
Revises: b87054615214
Create Date: 2026-10-17 22:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "c7d2f9a4e1b8"
down_revision: Union[str, Sequence[str], None] = "b87054615214"
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


def upgrade() -> None:
    columns = _columns("pairing_codes")
    if "__missing__" in columns:
        return
    if "terminal_options" not in columns:
        op.add_column("pairing_codes", sa.Column("terminal_options", sa.JSON(), nullable=True))


def downgrade() -> None:
    if "terminal_options" in _columns("pairing_codes"):
        op.drop_column("pairing_codes", "terminal_options")
