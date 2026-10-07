"""A screen's scope: kds_devices.scope

`kds_devices.scope` — which orders a KDS screen (station / Expo / manager, on top of its stations)
or a "מסך מוכן / לא מוכן" board shows: `{areaIds, machineIds}`, the points of sale (`shop_areas`)
and / or the tills and kiosks whose orders it lists. Null (or both lists empty) = the whole shop,
as before. Set on the dashboard's KDS page next to the screen's design; applied by the cloud when
it builds the screen's board (docs/SPEC_KDS.md §15).

The screens' design (layouts and options, docs/SPEC_KDS.md §14) needs no column: it is the
existing `kds_devices.display` (v2) and `shops.settings.kdsDisplayDefaults`.

Idempotent; never downgraded in place.

Revision ID: c4f8a2d6e9b1
Revises: e7d1b4a9c3f6
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "c4f8a2d6e9b1"
down_revision: Union[str, Sequence[str], None] = "e7d1b4a9c3f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = None if context.is_offline_mode() else sa.inspect(op.get_bind())
    cols = set() if insp is None else {c["name"] for c in insp.get_columns("kds_devices")}
    if "scope" not in cols:
        op.add_column("kds_devices", sa.Column("scope", sa.JSON(), nullable=True))


def downgrade() -> None:
    # Never run in place (shared dev DB); kept for completeness.
    op.drop_column("kds_devices", "scope")
