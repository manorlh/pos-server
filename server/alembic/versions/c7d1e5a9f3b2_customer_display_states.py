"""customer_display_states: the cloud relay of a till's customer screen ("מסך לקוח")

One row per till: the latest screen state it published for a paired customer display that
cannot reach it over the shop's LAN (app/services/customer_display.py, P:/specs/customer-display.md).
The settings themselves need no migration: they are the `customerDisplay` key of the settings
JSON every layer already has.

Add-only and idempotent (the auto-reloaded API may have created the table from the model
before this runs). Revision ID: c7d1e5a9f3b2, revises b8e2d4f6a1c3.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c7d1e5a9f3b2"
down_revision: Union[str, Sequence[str], None] = "b8e2d4f6a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "customer_display_states"


def _exists() -> bool:
    if context.is_offline_mode():
        return False
    return sa.inspect(op.get_bind()).has_table(TABLE)


def upgrade() -> None:
    if _exists():
        return
    op.create_table(
        TABLE,
        sa.Column(
            "till_machine_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("pos_machines.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("state", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table(TABLE)
