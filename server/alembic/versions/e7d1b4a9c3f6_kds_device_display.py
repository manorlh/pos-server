"""A KDS screen's look: kds_devices.display

`kds_devices.display` — how the "מסך מוכן / לא מוכן" board looks (`{theme, accent, sound,
showPreparing, title}`, set on the dashboard's KDS page for a pickup screen; docs/SPEC_KDS.md §13).
Null = the defaults. Read by every board: the Windows app and the browser board at `/board`
(it comes with the screen's `device` in `GET /sync/{m}/kds/board`).

Idempotent; never downgraded in place.

Revision ID: e7d1b4a9c3f6
Revises: a6c2e8f4b1d7
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "e7d1b4a9c3f6"
down_revision: Union[str, Sequence[str], None] = "a6c2e8f4b1d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = None if context.is_offline_mode() else sa.inspect(op.get_bind())
    cols = set() if insp is None else {c["name"] for c in insp.get_columns("kds_devices")}
    if "display" not in cols:
        op.add_column("kds_devices", sa.Column("display", sa.JSON(), nullable=True))


def downgrade() -> None:
    # Never run in place (shared dev DB); kept for completeness.
    op.drop_column("kds_devices", "display")
