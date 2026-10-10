"""product channels: "מופיע ב" — four channels on a product, and exceptions per shop / point of sale

specs/digital-menu-ordering-cards-plan.md §4.2, app/services/product_channels.py.

* `products.channel_online`, `products.channel_menu` — the two web channels, off (false) for every
  product: new web exposure starts as a draft. The tills' and the kiosks' pair stays where it was,
  in `products.sales_channel` (which may now also hold `none`): nothing an existing till or kiosk
  is sent changes.
* `product_channel_overrides` — a shop's or a point of sale's exception for one channel.

Add-only and idempotent (columns, table and indexes are looked at first).

Revision ID: 8a4c967e3fb0
Revises: c7d1a9e4f2b6
Create Date: 2026-10-10
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "8a4c967e3fb0"
down_revision: Union[str, Sequence[str], None] = "c7d1a9e4f2b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "product_channel_overrides"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    have = set() if insp is None else {c["name"] for c in insp.get_columns("products")}
    if "channel_online" not in have:
        op.add_column("products", sa.Column("channel_online", sa.Boolean(), nullable=False, server_default="false"))
    if "channel_menu" not in have:
        op.add_column("products", sa.Column("channel_menu", sa.Boolean(), nullable=False, server_default="false"))

    if insp is None or not insp.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("product_id", uuid, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("level", sa.String(8), nullable=False),
            sa.Column("target_id", uuid, nullable=False),
            sa.Column("channel", sa.String(8), nullable=False),
            sa.Column("allowed", sa.Boolean(), nullable=True),
            sa.Column("updated_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("updated_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("level IN ('shop', 'area')", name="ck_product_channel_overrides_level"),
            sa.CheckConstraint(
                "channel IN ('pos', 'kiosk', 'online', 'menu')", name="ck_product_channel_overrides_channel",
            ),
            sa.UniqueConstraint("product_id", "level", "target_id", "channel", name="uq_product_channel_overrides"),
        )
    indexes = set() if insp is None or not insp.has_table(TABLE) else {i["name"] for i in insp.get_indexes(TABLE)}
    if "ix_product_channel_overrides_target" not in indexes:
        op.create_index("ix_product_channel_overrides_target", TABLE, ["tenant_id", "level", "target_id"])
    if "ix_product_channel_overrides_product_id" not in indexes:
        op.create_index("ix_product_channel_overrides_product_id", TABLE, ["product_id"])


def downgrade() -> None:
    op.drop_index("ix_product_channel_overrides_product_id", table_name=TABLE)
    op.drop_index("ix_product_channel_overrides_target", table_name=TABLE)
    op.drop_table(TABLE)
    op.drop_column("products", "channel_menu")
    op.drop_column("products", "channel_online")
