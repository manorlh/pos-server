"""A till's Z mode over time

`pos_machines.z_mode_history` — every change of who produces the till's Z (`z_mode`: the shop
Z, or its own Z — per-till or independent), oldest first: `[{at, from, to}]`. A document is
filed in the container of the mode its till was in when it was issued (docs/SHIFTS_API.md
§1.2c-bis): a late, waiting or re-filed document keeps going to the Z kind it was issued
under, whatever the till switched to since.

Idempotent; never downgraded in place.

Revision ID: a6c2e8f4b1d7
Revises: e4f1a9c7b3d2
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "a6c2e8f4b1d7"
down_revision: Union[str, Sequence[str], None] = "e4f1a9c7b3d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = None if context.is_offline_mode() else sa.inspect(op.get_bind())
    cols = set() if insp is None else {c["name"] for c in insp.get_columns("pos_machines")}
    if "z_mode_history" not in cols:
        op.add_column("pos_machines", sa.Column("z_mode_history", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    # Never run in place (shared dev DB); kept for completeness.
    op.drop_column("pos_machines", "z_mode_history")
