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

Safe to deploy while the previous build still serves (stock locations themselves stay off until
`STOCK_LOCATIONS_ENABLED`):

* a BEFORE INSERT trigger fills `target_id` (and `company_id`) from `shop_id`, so a row written by
  the previous build — which knows nothing of locations — is its shop's location;
* the backfill runs in batches, each committed on its own (no long lock on a big movements table);
* `target_id NOT NULL` goes through a NOT VALID check constraint validated without blocking writes;
* every index is built CONCURRENTLY outside the transaction (an invalid leftover is rebuilt), the
  new unique index before the old unique constraint goes.

Idempotent: every column, index, trigger, table and enum value is looked at first. The downgrade
(a scratch database) folds points of sale and devices back into their shop rows — never deletes
stock — and refuses while a company warehouse holds any.

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


BATCH = 5000
TRIGGER_FN = "stock_location_defaults"


def _add_location_columns(insp, table: str, uuid) -> None:
    """Nullable / constant-default columns: metadata only, no table rewrite."""
    cols = _columns(insp, table)
    if "company_id" not in cols:
        op.add_column(table, sa.Column("company_id", uuid, sa.ForeignKey("companies.id"), nullable=True))
    if "level" not in cols:
        op.add_column(table, sa.Column("level", sa.String(16), nullable=False, server_default="shop"))
    if "target_id" not in cols:
        op.add_column(table, sa.Column("target_id", uuid, nullable=True))
    op.alter_column(table, "shop_id", nullable=True)


def _defaults_trigger(table: str) -> None:
    """A row the previous build writes (no location) is its shop's: target_id / company_id from shop_id."""
    op.execute(f"DROP TRIGGER IF EXISTS {table}_location_defaults ON {table}")
    op.execute(
        f"CREATE TRIGGER {table}_location_defaults BEFORE INSERT ON {table} "
        f"FOR EACH ROW EXECUTE FUNCTION {TRIGGER_FN}()"
    )


def _backfill(table: str) -> None:
    """Every row so far is its shop's stock — in batches, each committed by itself."""
    sql = (
        f"UPDATE {table} t SET target_id = t.shop_id, "
        f"company_id = COALESCE(t.company_id, (SELECT s.company_id FROM shops s WHERE s.id = t.shop_id)) "
        f"WHERE t.id IN (SELECT id FROM {table} WHERE target_id IS NULL LIMIT {BATCH})"
    )
    if context.is_offline_mode():
        op.execute(sql.replace(f" LIMIT {BATCH}", ""))
        return
    with op.get_context().autocommit_block():
        bind = op.get_bind()
        while True:
            if bind.execute(sa.text(sql)).rowcount == 0:
                break


def _target_not_null(table: str) -> None:
    """NOT NULL without a scan under an exclusive lock: a validated check constraint first."""
    if context.is_offline_mode():
        op.alter_column(table, "target_id", nullable=False)
        return
    bind = op.get_bind()
    nullable = bind.execute(sa.text(
        "SELECT is_nullable FROM information_schema.columns WHERE table_name = :t AND column_name = 'target_id'"
    ), {"t": table}).scalar()
    if nullable != "YES":
        return
    check = f"ck_{table}_target_id_not_null"
    exists = bind.execute(sa.text("SELECT 1 FROM pg_constraint WHERE conname = :c"), {"c": check}).scalar()
    if not exists:
        op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {check} CHECK (target_id IS NOT NULL) NOT VALID")
    op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {check}")
    op.alter_column(table, "target_id", nullable=False)
    op.execute(f"ALTER TABLE {table} DROP CONSTRAINT {check}")


def _index_concurrently(name: str, table: str, columns: list, unique: bool = False) -> None:
    """CREATE INDEX CONCURRENTLY outside the transaction; an invalid leftover (a failed build) is rebuilt."""
    if context.is_offline_mode():
        op.create_index(name, table, columns, unique=unique)
        return
    bind = op.get_bind()
    state = bind.execute(sa.text(
        "SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = :n"
    ), {"n": name}).scalar()
    if state is True:
        return
    with op.get_context().autocommit_block():
        if state is False:
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
        op.create_index(name, table, columns, unique=unique, postgresql_concurrently=True)


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)

    # ── the enum values (their own transaction: Postgres will not use a value added in the
    # transaction that adds it) ──
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE stockmovementreason ADD VALUE IF NOT EXISTS 'transfer'")
        op.execute("ALTER TYPE stockmovementreason ADD VALUE IF NOT EXISTS 'daily_reset'")

    # ── the location columns, and the trigger that keeps the previous build's inserts whole ──
    op.execute(f"""
        CREATE OR REPLACE FUNCTION {TRIGGER_FN}() RETURNS trigger AS $$
        BEGIN
            IF NEW.target_id IS NULL THEN
                NEW.target_id := NEW.shop_id;
            END IF;
            IF NEW.company_id IS NULL AND NEW.shop_id IS NOT NULL THEN
                NEW.company_id := (SELECT company_id FROM shops WHERE id = NEW.shop_id);
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)
    for table in (LEVELS, MOVEMENTS):
        _add_location_columns(insp, table, uuid)
        _defaults_trigger(table)
    if "transfer_id" not in _columns(insp, MOVEMENTS):
        op.add_column(MOVEMENTS, sa.Column("transfer_id", uuid, nullable=True))
    cols = _columns(insp, LEVELS)
    for name, column in (
        ("opening_quantity", sa.Column("opening_quantity", sa.Numeric(12, 3), nullable=True)),
        ("daily_reset", sa.Column("daily_reset", sa.Boolean(), nullable=False, server_default=sa.text("false"))),
        ("reset_mode", sa.Column("reset_mode", sa.String(16), nullable=False, server_default="set")),
        ("last_reset_at", sa.Column("last_reset_at", sa.DateTime(timezone=True), nullable=True)),
    ):
        if name not in cols:
            op.add_column(LEVELS, column)

    # ── the backfill (batched), then NOT NULL (no blocking scan) ──
    for table in (LEVELS, MOVEMENTS):
        _backfill(table)
        _target_not_null(table)

    # ── the indexes, concurrently; the new unique before the old one goes ──
    for table in (LEVELS, MOVEMENTS):
        _index_concurrently(f"ix_{table}_company_id", table, ["company_id"])
    _index_concurrently(NEW_UNIQUE, LEVELS, ["level", "target_id", "product_id"], unique=True)
    _index_concurrently("ix_stock_movements_transfer_id", MOVEMENTS, ["transfer_id"])
    _index_concurrently("ix_stock_movements_location", MOVEMENTS, ["level", "target_id", "product_id"])
    insp = _inspector()  # fresh: the indexes above were built outside the first transaction
    if insp is None or OLD_UNIQUE in _uniques(insp, LEVELS):
        op.drop_constraint(OLD_UNIQUE, LEVELS, type_="unique")

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
    # For a scratch database. Stock is never deleted: every point of sale's and device's quantity is
    # added into its shop's row (created when missing) and their movements become the shop's; a
    # company warehouse cannot be folded into one shop, so the downgrade refuses while one holds stock.
    # The enum values stay (Postgres cannot drop one).
    op.execute(f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM {LEVELS} WHERE shop_id IS NULL AND quantity <> 0) THEN
                RAISE EXCEPTION 'stock is held at a company warehouse: move it to a shop before downgrading';
            END IF;
        END $$
    """)
    op.execute(f"""
        INSERT INTO {LEVELS} (id, tenant_id, company_id, shop_id, level, target_id, product_id, quantity, updated_at)
        SELECT md5(random()::text || clock_timestamp()::text || x.shop_id::text || x.product_id::text)::uuid,
               x.tenant_id, x.company_id, x.shop_id, 'shop', x.shop_id, x.product_id, 0, now()
        FROM (
            SELECT shop_id, product_id, (array_agg(tenant_id))[1] AS tenant_id, (array_agg(company_id))[1] AS company_id
            FROM {LEVELS} WHERE shop_id IS NOT NULL AND level <> 'shop' GROUP BY shop_id, product_id
        ) x
        WHERE NOT EXISTS (
            SELECT 1 FROM {LEVELS} s WHERE s.level = 'shop' AND s.target_id = x.shop_id AND s.product_id = x.product_id
        )
    """)
    op.execute(f"""
        UPDATE {LEVELS} s SET quantity = s.quantity + x.q, updated_at = now()
        FROM (
            SELECT shop_id, product_id, SUM(quantity) AS q FROM {LEVELS}
            WHERE shop_id IS NOT NULL AND level <> 'shop' GROUP BY shop_id, product_id
        ) x
        WHERE s.level = 'shop' AND s.target_id = x.shop_id AND s.product_id = x.product_id
    """)
    op.execute(f"DELETE FROM {LEVELS} WHERE level <> 'shop' OR shop_id IS NULL")
    op.execute(f"UPDATE {MOVEMENTS} SET level = 'shop', target_id = shop_id WHERE shop_id IS NOT NULL AND level <> 'shop'")
    op.execute(f"DELETE FROM {MOVEMENTS} WHERE shop_id IS NULL")  # a company warehouse at 0 (checked above)
    for table in (LEVELS, MOVEMENTS):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_location_defaults ON {table}")
    op.execute(f"DROP FUNCTION IF EXISTS {TRIGGER_FN}()")
    op.drop_column("dashboard_access_profiles", "machine_ids")
    op.drop_column("dashboard_access_profiles", "area_ids")
    op.drop_table("stock_reset_items")
    op.drop_table("stock_resets")
    op.drop_table("stock_alerts")
    op.drop_table("stock_level_settings")
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
