"""availability per area, and category activity per shop, area and till

* `area_product_overrides` (area × product): a fifth product availability level,
  between the shop's and the till's — machine → area → shop → the shop's own company →
  the product. Tri-state `is_available` like its neighbours (d6e7f8a9b0c1), cleared to
  NULL rather than deleted, `ON DELETE CASCADE` on both keys.
* `category_availability_overrides` (level × target × category): whether a category is
  active for one shop, one area or one till (`level` = "shop" | "area" | "machine",
  `target_id` the shop's, area's or till's id — no foreign key, it names one of three
  tables). The category's own `is_active` stays the tenant-wide floor; the rule is in
  `app/services/category_availability.py`.

Nothing existing is touched: with no rows, every till resolves exactly what it has now.

Guarded like d6e7f8a9b0c1: tables and indexes are created only if absent, since the
app's `create_all` may have made them already.

Parent is the terminal merchant columns (f0a1b2c3d4e8).

Revision ID: f0a1b2c3d4e9
Revises: f0a1b2c3d4e8
Create Date: 2026-10-03 23:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "f0a1b2c3d4e9"
down_revision = "f0a1b2c3d4e8"
branch_labels = None
depends_on = None


def _index(table: str, column: str) -> str:
    # The names SQLAlchemy gives `index=True`, so the migration and `create_all` agree.
    return f"ix_{table}_{column}"


def _timestamps():
    return (
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )


def _ensure_indexes(table: str, columns, existed: bool, offline: bool) -> None:
    indexes = (
        set()
        if offline or not existed
        else {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}
    )
    for column in columns:
        if _index(table, column) not in indexes:
            op.create_index(_index(table, column), table, [column])


def upgrade() -> None:
    offline = context.is_offline_mode()
    tables: set[str] = set() if offline else set(sa.inspect(op.get_bind()).get_table_names())

    if "area_product_overrides" not in tables:
        op.create_table(
            "area_product_overrides",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "area_id",
                UUID(as_uuid=True),
                sa.ForeignKey("shop_areas.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "product_id",
                UUID(as_uuid=True),
                sa.ForeignKey("products.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("is_available", sa.Boolean(), nullable=True),
            *_timestamps(),
            sa.UniqueConstraint("area_id", "product_id", name="uq_area_product_override"),
        )
    _ensure_indexes(
        "area_product_overrides", ("area_id", "product_id"),
        "area_product_overrides" in tables, offline,
    )

    if "category_availability_overrides" not in tables:
        op.create_table(
            "category_availability_overrides",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("level", sa.String(16), nullable=False),
            sa.Column("target_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "category_id",
                UUID(as_uuid=True),
                sa.ForeignKey("categories.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("is_active", sa.Boolean(), nullable=True),
            *_timestamps(),
            sa.UniqueConstraint(
                "level", "target_id", "category_id", name="uq_category_availability_override"
            ),
        )
    _ensure_indexes(
        "category_availability_overrides", ("target_id", "category_id"),
        "category_availability_overrides" in tables, offline,
    )


def downgrade() -> None:
    op.drop_table("category_availability_overrides")
    op.drop_table("area_product_overrides")
