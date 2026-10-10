"""web channels on time menus and blocks: catalog_menus.web_channels, sold_out_marks.channels / web_display

specs/digital-menu-ordering-cards-plan.md §1 (time menus offered on the web) and §4.3 (blocks in four
channels), app/services/digital_effective.py.

* `catalog_menus.web_channels` — the web channels a time menu is offered on too (NULL: none — every
  menu so far). Never in a device's menus block: the tills and kiosks read `channel` only.
* `sold_out_marks.channels` — the channels a block covers (NULL: as `target` always meant, the
  devices only); `sold_out_marks.web_display` — its look on the web. A block with channels reaches a
  device only when its channel is among them; every existing block is NULL: unchanged.

Add-only, idempotent (each column looked at first).

Revision ID: 31958d027cef
Revises: 2e5378a4c106
Create Date: 2026-10-10
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "31958d027cef"
down_revision: Union[str, Sequence[str], None] = "2e5378a4c106"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns(table):
    if context.is_offline_mode():
        return set()
    insp = sa.inspect(op.get_bind())
    return {c["name"] for c in insp.get_columns(table)} if insp.has_table(table) else set()


def upgrade() -> None:
    if "web_channels" not in _columns("catalog_menus"):
        op.add_column("catalog_menus", sa.Column("web_channels", sa.JSON(), nullable=True))
    have = _columns("sold_out_marks")
    if "channels" not in have:
        op.add_column("sold_out_marks", sa.Column("channels", sa.JSON(), nullable=True))
    if "web_display" not in have:
        op.add_column("sold_out_marks", sa.Column("web_display", sa.String(8), nullable=True))


def downgrade() -> None:
    op.drop_column("sold_out_marks", "web_display")
    op.drop_column("sold_out_marks", "channels")
    op.drop_column("catalog_menus", "web_channels")
