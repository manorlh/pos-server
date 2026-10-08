"""stock locations along the hierarchy, managed levels, alerts and the daily reset

* `stock_levels` / `stock_movements`: the stock location — `level` (company · shop · area ·
  machine · group) and `target_id` — and `company_id`; `shop_id` becomes nullable (a company
  warehouse has no shop). Every existing row is the shop location it always was (`level = 'shop'`,
  `target_id = shop_id`), so nothing moves. The one-row-per-(shop, product) constraint becomes one
  row per (location, product).
* `stock_levels.opening_quantity` / `daily_reset` / `reset_mode` / `last_reset_at` — "מלאי פתיחה
  ואיפוס יומי".
* `stock_movements.transfer_id` — the two legs of one transfer.
* `stockmovementreason` gets `transfer` and `daily_reset`.
* `stock_level_settings` — "אופן ניהול מלאי": which levels hold stock, per company / shop, per
  category / product. No row = shop only (today's behaviour).
* `stock_alerts` — low / out at a location, with the suggested transfer.
* `stock_resets` / `stock_reset_items` — the daily reset's runs and what each left
  ("נשאר בסוף היום").
* `dashboard_access_profiles.area_ids` / `machine_ids` — a dashboard user scoped to points of sale
  or devices (the stock and block screens).

Idempotent: every column, index, table and enum value is looked at first. Never downgraded in place.

Revision ID: 7c4e2a9d1f63
Revises: 9e6a4c1f3b85
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "7c4e2a9d1f63"
down_revision: Union[str, Sequence[str], None] = "9e6a4c1f3b85"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LEVELS = "stock_levels"
MOVEMENTS = "stock_movements"
OLD_UNIQUE = "uq_stock_level_shop_product"
NEW_UNIQUE = "uq_stock_levels_location_product"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def _uniques(insp, table: str) -> set:
    return set() if insp is None else {u["name"] for u in insp.get_unique_constraints(table)}


def _has_table(insp, table: str) -> bool:
    return insp is not None and insp.has_table(table)


def _location_columns(insp, table: str, uuid) -> None:
    cols = _columns(insp, table)
    if "company_id" not in cols:
        op.add_column(table, sa.Column("company_id", uuid, sa.ForeignKey("companies.id"), nullable=True))
    if "level" not in cols:
        op.add_column(table, sa.Column("level", sa.String(16), nullable=False, server_default="shop"))
    if "target_id" not in cols:
        op.add_column(table, sa.Column("target_id", uuid, nullable=True))
    # Every row so far is its shop's stock.
    op.execute(f"UPDATE {table} SET target_id = shop_id WHERE target_id IS NULL")
    op.execute(
        f"UPDATE {table} t SET company_id = s.company_id FROM shops s "
        f"WHERE t.company_id IS NULL AND t.shop_id = s.id"
    )
    op.alter_column(table, "target_id", nullable=False)
    op.alter_column(table, "shop_id", nullable=True)
    indexes = _indexes(insp, table)
    if f"ix_{table}_company_id" not in indexes:
        op.create_index(f"ix_{table}_company_id", table, ["company_id"])


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)

    # ── the enum values (their own transaction: Postgres will not use a value added in the
    # transaction that adds it) ──
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE stockmovementreason ADD VALUE IF NOT EXISTS 'transfer'")
        op.execute("ALTER TYPE stockmovementreason ADD VALUE IF NOT EXISTS 'daily_reset'")

    # ── stock_levels ──
    _location_columns(insp, LEVELS, uuid)
    cols = _columns(insp, LEVELS)
    for name, column in (
        ("opening_quantity", sa.Column("opening_quantity", sa.Numeric(12, 3), nullable=True)),
        ("daily_reset", sa.Column("daily_reset", sa.Boolean(), nullable=False, server_default=sa.text("false"))),
        ("reset_mode", sa.Column("reset_mode", sa.String(16), nullable=False, server_default="set")),
        ("last_reset_at", sa.Column("last_reset_at", sa.DateTime(timezone=True), nullable=True)),
    ):
        if name not in cols:
            op.add_column(LEVELS, column)
    if insp is None or OLD_UNIQUE in _uniques(insp, LEVELS):
        op.drop_constraint(OLD_UNIQUE, LEVELS, type_="unique")
    if NEW_UNIQUE not in _indexes(insp, LEVELS):
        op.create_index(NEW_UNIQUE, LEVELS, ["level", "target_id", "product_id"], unique=True)

    # ── stock_movements ──
    _location_columns(insp, MOVEMENTS, uuid)
    if "transfer_id" not in _columns(insp, MOVEMENTS):
        op.add_column(MOVEMENTS, sa.Column("transfer_id", uuid, nullable=True))
    indexes = _indexes(insp, MOVEMENTS)
    if "ix_stock_movements_transfer_id" not in indexes:
        op.create_index("ix_stock_movements_transfer_id", MOVEMENTS, ["transfer_id"])
    if "ix_stock_movements_location" not in indexes:
        op.create_index("ix_stock_movements_location", MOVEMENTS, ["level", "target_id", "product_id"])

    # ── the managed levels ──
    if not _has_table(insp, "stock_level_settings"):
        op.create_table(
            "stock_level_settings",
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("scope_level", sa.String(16), nullable=False),
            sa.Column("scope_id", uuid, nullable=False),
            sa.Column("item_kind", sa.String(16), nullable=True),
            sa.Column("item_id", uuid, nullable=True),
            sa.Column("rule_key", sa.String(160), nullable=False, unique=True),
            sa.Column("levels", postgresql.JSONB(), nullable=False),
            sa.Column("updated_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_stock_level_settings_tenant_id", "stock_level_settings", ["tenant_id"])
        op.create_index("ix_stock_level_settings_scope", "stock_level_settings", ["scope_level", "scope_id"])

    # ── alerts ──
    if not _has_table(insp, "stock_alerts"):
        op.create_table(
            "stock_alerts",
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company_id", uuid, nullable=True),
            sa.Column("shop_id", uuid, nullable=True),
            sa.Column("area_id", uuid, nullable=True),
            sa.Column("machine_id", uuid, nullable=True),
            sa.Column("level", sa.String(16), nullable=False),
            sa.Column("target_id", uuid, nullable=False),
            sa.Column("product_id", uuid, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("product_name", sa.String(255), nullable=True),
            sa.Column("kind", sa.String(8), nullable=False),
            sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
            sa.Column("threshold", sa.Numeric(12, 3), nullable=True),
            sa.Column("suggest_level", sa.String(16), nullable=True),
            sa.Column("suggest_target_id", uuid, nullable=True),
            sa.Column("suggest_quantity", sa.Numeric(12, 3), nullable=True),
            sa.Column("raised_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_stock_alerts_tenant_id", "stock_alerts", ["tenant_id"])
        op.create_index("ix_stock_alerts_location", "stock_alerts", ["level", "target_id", "product_id"])
        op.create_index("ix_stock_alerts_shop_open", "stock_alerts", ["shop_id", "cleared_at"])

    # ── the daily reset ──
    if not _has_table(insp, "stock_resets"):
        op.create_table(
            "stock_resets",
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company_id", uuid, nullable=True),
            sa.Column("shop_id", uuid, nullable=True),
            sa.Column("level", sa.String(16), nullable=False),
            sa.Column("target_id", uuid, nullable=False),
            sa.Column("business_day", sa.Date(), nullable=False),
            sa.Column("run_key", sa.String(160), nullable=False, unique=True),
            sa.Column("trigger", sa.String(16), nullable=False),
            sa.Column("user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("user_name", sa.String(200), nullable=True),
            sa.Column("run_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("items", sa.Integer(), nullable=False, server_default="0"),
        )
        op.create_index("ix_stock_resets_tenant_id", "stock_resets", ["tenant_id"])
        op.create_index("ix_stock_resets_shop_day", "stock_resets", ["shop_id", "business_day"])
    if not _has_table(insp, "stock_reset_items"):
        op.create_table(
            "stock_reset_items",
            sa.Column("id", uuid, primary_key=True),
            sa.Column("reset_id", uuid, sa.ForeignKey("stock_resets.id", ondelete="CASCADE"), nullable=False),
            sa.Column("product_id", uuid, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
            sa.Column("product_name", sa.String(255), nullable=True),
            sa.Column("mode", sa.String(16), nullable=False),
            sa.Column("before_quantity", sa.Numeric(12, 3), nullable=False),
            sa.Column("opening_quantity", sa.Numeric(12, 3), nullable=False),
            sa.Column("delta", sa.Numeric(12, 3), nullable=False),
            sa.Column("from_level", sa.String(16), nullable=True),
            sa.Column("from_target_id", uuid, nullable=True),
            sa.Column("shortfall", sa.Numeric(12, 3), nullable=True),
            sa.Column("movement_id", uuid, nullable=True),
        )
        op.create_index("ix_stock_reset_items_reset_id", "stock_reset_items", ["reset_id"])
        op.create_index("ix_stock_reset_items_product_id", "stock_reset_items", ["product_id"])

    # ── a dashboard user scoped to points of sale / devices ──
    cols = _columns(insp, "dashboard_access_profiles")
    for name in ("area_ids", "machine_ids"):
        if name not in cols:
            op.add_column("dashboard_access_profiles", sa.Column(name, postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    # Never in place (another branch's data may sit on these columns); for a scratch database only.
    # The enum values stay (Postgres cannot drop one).
    op.drop_column("dashboard_access_profiles", "machine_ids")
    op.drop_column("dashboard_access_profiles", "area_ids")
    op.drop_table("stock_reset_items")
    op.drop_table("stock_resets")
    op.drop_table("stock_alerts")
    op.drop_table("stock_level_settings")
    op.execute(f"DELETE FROM {MOVEMENTS} WHERE shop_id IS NULL OR level <> 'shop'")
    op.execute(f"DELETE FROM {LEVELS} WHERE shop_id IS NULL OR level <> 'shop'")
    op.drop_index("ix_stock_movements_location", table_name=MOVEMENTS)
    op.drop_index("ix_stock_movements_transfer_id", table_name=MOVEMENTS)
    op.drop_column(MOVEMENTS, "transfer_id")
    op.drop_index(NEW_UNIQUE, table_name=LEVELS)
    op.create_unique_constraint(OLD_UNIQUE, LEVELS, ["shop_id", "product_id"])
    for table in (LEVELS, MOVEMENTS):
        op.drop_index(f"ix_{table}_company_id", table_name=table)
        op.alter_column(table, "shop_id", nullable=False)
        op.drop_column(table, "target_id")
        op.drop_column(table, "level")
        op.drop_column(table, "company_id")
    for name in ("last_reset_at", "reset_mode", "daily_reset", "opening_quantity"):
        op.drop_column(LEVELS, name)
