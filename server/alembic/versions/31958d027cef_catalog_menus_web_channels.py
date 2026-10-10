"""web channels on time menus: catalog_menus.web_channels

specs/digital-menu-ordering-cards-plan.md §1 (time menus offered on the web too),
app/services/digital_effective.py `web_menus`.

* `catalog_menus.web_channels` — the web channels a time menu is offered on too (["online",
  "menu"]; NULL: none — every menu so far). Never in a device's menus block: the tills and kiosks
  read `channel` only, unchanged.

The blocks' channels and the product's "מופיע ב" are item-blocks' (`sold_out_marks.channels`,
`products.appears_in`, migration c7d1a9e4f2b6) — nothing of them here.

Add-only, idempotent (the column looked at first).

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


def downgrade() -> None:
    op.drop_column("catalog_menus", "web_channels")
