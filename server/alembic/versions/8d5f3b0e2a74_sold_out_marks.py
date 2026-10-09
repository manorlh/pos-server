"""blocks on a product ("אזל" / "חסום") per company, shop, kiosks, point of sale, device, event

`sold_out_marks`: a product blocked for a scope, from the dashboard or by itself when the stock it
sells from reaches 0 (app/services/sold_out.py). The setting that turns the automatic block on and
off (`autoSoldOutAtZero`, default on) is a POS settings key — no DDL.

Idempotent: the auto-reloading dev API's `create_all` may make the table before this runs, so
the table and each index are looked at first. Never downgraded in place.

Revision ID: 8d5f3b0e2a74
Revises: 6b1e9d4f2a87
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "8d5f3b0e2a74"
down_revision: Union[str, Sequence[str], None] = "e8b3f5a1c7d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "sold_out_marks"
INDEXES = (
    ("ix_sold_out_marks_tenant_id", ["tenant_id"]),
    ("ix_sold_out_marks_company_id", ["company_id"]),
    ("ix_sold_out_marks_shop_product", ["shop_id", "product_id"]),
    ("ix_sold_out_marks_scope", ["scope", "scope_id"]),
)


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    if insp is None or not insp.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company_id", uuid, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=True),
            sa.Column("product_id", uuid, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("scope", sa.String(16), nullable=False),
            sa.Column("scope_id", uuid, nullable=False),
            sa.Column("kind", sa.String(16), nullable=False, server_default="sold_out"),
            sa.Column("until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("until_mode", sa.String(16), nullable=True),
            sa.Column("source", sa.String(16), nullable=False, server_default="manual"),
            sa.Column("note", sa.String(200), nullable=True),
            sa.Column("created_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("cleared_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("cleared_by_name", sa.String(200), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        have = set()
    else:
        have = {i["name"] for i in insp.get_indexes(TABLE)}
    for name, cols in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, cols)


def downgrade() -> None:
    op.drop_table(TABLE)
