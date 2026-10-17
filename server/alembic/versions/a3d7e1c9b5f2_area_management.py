"""area management: where a product is sold inside a shop, the till user's points of sale, area prices, price policy

P:/specs/chain-areas.md (owner, 17.10 — "ניהול נקודות מכירה", a chain of shops with points of sale inside them):

* `shop_product_overrides.area_ids` (JSONB, null) — "שיוך מוצר לנקודות מכירה": the shop's points of sale
  (`shop_areas.id` strings) where this product is sold. Null — every point of sale of the shop, as today.
* `pos_users.area_ids` (JSONB, null) — the points of sale whose tills this till user may sign in on. Null —
  every till of the shop, as today.

* `area_product_overrides.price` (NUMERIC(10,2), null) — a point of sale's own price (null = the shop's).
* `price_policies` — per company: who below the chain may change prices, locks, allowed range. No row = today.
* `price_changes` — every price written (who, level, old → new, from where).

(The dashboard's top-bar scope is a user preference, `users.preferences.dashboardScope` — no schema.)

Add-only and idempotent (each column and table looked at first; the API's create_all may have made them).
No existing row changes: every product is sold everywhere it is today, every till user signs in where they do today.

Revision ID: a3d7e1c9b5f2
Revises: b87054615214
Create Date: 2026-10-17 22:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "a3d7e1c9b5f2"
down_revision: Union[str, Sequence[str], None] = "b87054615214"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OVERRIDES = "shop_product_overrides"
USERS = "pos_users"
AREA_OVERRIDES = "area_product_overrides"
POLICIES = "price_policies"
CHANGES = "price_changes"


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_table(table: str) -> bool:
    if _offline():
        return table not in (POLICIES, CHANGES)
    return sa.inspect(op.get_bind()).has_table(table)


def _columns(table: str) -> set:
    if _offline() or not _has_table(table):
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set:
    if _offline() or not _has_table(table):
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    uid = postgresql.UUID(as_uuid=True)
    now = sa.text("now()") if _offline() or op.get_bind().dialect.name == "postgresql" else sa.text("CURRENT_TIMESTAMP")

    for table in (OVERRIDES, USERS):
        if _has_table(table) and "area_ids" not in _columns(table):
            op.add_column(table, sa.Column("area_ids", jsonb, nullable=True))
    if _has_table(AREA_OVERRIDES) and "price" not in _columns(AREA_OVERRIDES):
        op.add_column(AREA_OVERRIDES, sa.Column("price", sa.Numeric(10, 2), nullable=True))

    if not _has_table(POLICIES):
        op.create_table(
            POLICIES,
            sa.Column("company_id", uid, sa.ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("editors", sa.String(10), nullable=False, server_default="area"),
            sa.Column("shop_editors", jsonb, nullable=True),
            sa.Column("locked_product_ids", jsonb, nullable=True),
            sa.Column("locked_category_ids", jsonb, nullable=True),
            sa.Column("max_delta_pct", sa.Numeric(6, 2), nullable=True),
            sa.Column("updated_by_user_id", uid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
        )
    if "ix_price_policies_tenant_id" not in _indexes(POLICIES):
        op.create_index("ix_price_policies_tenant_id", POLICIES, ["tenant_id"])

    if not _has_table(CHANGES):
        op.create_table(
            CHANGES,
            sa.Column("id", uid, primary_key=True),
            sa.Column("tenant_id", uid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("product_id", uid, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("level", sa.String(10), nullable=False),
            sa.Column("target_id", uid, nullable=True),
            sa.Column("old_price", sa.Numeric(10, 2), nullable=True),
            sa.Column("new_price", sa.Numeric(10, 2), nullable=True),
            sa.Column("actor_user_id", uid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("actor_pos_user_id", uid, sa.ForeignKey("pos_users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("machine_id", uid, sa.ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True),
            sa.Column("source", sa.String(12), nullable=False, server_default="dashboard"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
        )
    have = _indexes(CHANGES)
    for name, cols in (
        ("ix_price_changes_tenant_id", ["tenant_id"]),
        ("ix_price_changes_product_id", ["product_id"]),
        ("ix_price_changes_target_id", ["target_id"]),
        ("ix_price_changes_created_at", ["created_at"]),
    ):
        if name not in have:
            op.create_index(name, CHANGES, cols)


def downgrade() -> None:
    for table in (CHANGES, POLICIES):
        if _has_table(table):
            op.drop_table(table)
    if "price" in _columns(AREA_OVERRIDES):
        op.drop_column(AREA_OVERRIDES, "price")
    for table in (USERS, OVERRIDES):
        if "area_ids" in _columns(table):
            op.drop_column(table, "area_ids")
