"""KDS orders: pickup_label — a kiosk order's label as its slip printed it

The kiosk's "מספר הזמנה" may print with its letter ("A-17", today's) or the number alone ("17",
`pickup.labelFormat: "number"`, the owner 09.10.2026). The kitchen engine kept only the number,
so its cards and the pickup screen said "#17" whatever the slip said. A kiosk's release now
carries `pickupLabel`; the order keeps it (`kds_orders.pickup_label`) and the screens show it.
Null for every other order: their answers are unchanged.

Add-only and idempotent (the column is looked at first). Revision ID: 5f2c8a1e7d93, revises
b8e2d4f6a1c3.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "5f2c8a1e7d93"
down_revision: Union[str, Sequence[str], None] = "5e1d0c9a7b3f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if "pickup_label" not in _columns("kds_orders"):
        op.add_column("kds_orders", sa.Column("pickup_label", sa.String(length=32), nullable=True))


def downgrade() -> None:
    if context.is_offline_mode() or "pickup_label" in _columns("kds_orders"):
        op.drop_column("kds_orders", "pickup_label")
