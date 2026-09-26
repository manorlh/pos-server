"""lock a product per company, per shop and per till: availability becomes four levels

A product's availability ("locked": shown on the till, not sellable — not hidden) is
now decided at four levels, nearest wins: machine → shop → the shop's own company →
the product's own `products.is_available`. The rule lives in
`app/services/product_availability.py`. This migration adds the two missing levels and
makes the shop level able to say "not set".

* `company_product_overrides` (company × product) and `machine_product_overrides`
  (till × product), each with a tri-state `is_available`: NULL = not set, true =
  available, false = locked. Clearing a level writes NULL rather than deleting the row,
  so the tills' delta pull and the catalog watermark still see the change.
  `ON DELETE CASCADE` on every FK: a setting about a product, company or till must
  never be what blocks deleting it.
* `shop_product_overrides.is_available` loses its NOT NULL. Until now every assigned
  shop row carried `true`, which under the new rule would be an explicit "available
  here" and make any company lock unreachable. So `true` becomes NULL (inherit),
  and `false` stays as an explicit lock.

  **Only where the product's own flag is true.** Until now the till sync ignored
  `products.is_available` on shop rows entirely (`isAvailable` was the shop row alone),
  so on a product whose own flag is false a shop's `true` meant "sell it anyway", not
  "same as the product". Turning those into NULL would lock them on the till today.
  They are kept as an explicit `true`, so no till's answer changes on upgrade.

No `updated_at` is touched: with no company or till levels yet, every row resolves to
exactly what the till already has, so there is nothing for the tills to re-pull.

Idempotent in the way its neighbours are: tables and indexes are created only if
absent (the app's `create_all` may already have made them), and the shop-level
conversion runs only while the column is still NOT NULL — a second run must not turn a
shop's deliberate "available here", set after the first, back into "inherit". That
check is inside the statement itself, so the offline `--sql` rendering is guarded too.

Deploy order matters: the app now inserts NULL into `shop_product_overrides
.is_available`, which the old NOT NULL column rejects. Run this before the new code.

Revision ID: d6e7f8a9b0c1
Revises: c5d6e7f8a9b0
Create Date: 2026-09-26 10:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "d6e7f8a9b0c1"
down_revision = "c5d6e7f8a9b0"
branch_labels = None
depends_on = None


#: (table, owner column, owner table, unique constraint)
_LEVELS = (
    ("company_product_overrides", "company_id", "companies", "uq_company_product_override"),
    ("machine_product_overrides", "machine_id", "pos_machines", "uq_machine_product_override"),
)


#: `true` → NULL on shop rows whose product's own flag is true; `false`, and `true` on a
#: product whose own flag is false, are kept. A constant so the test can run exactly
#: this statement against rows (tests/test_product_availability.py).
TRUE_TO_INHERIT = """
                UPDATE shop_product_overrides
                   SET is_available = NULL
                  FROM products p
                 WHERE p.id = shop_product_overrides.global_product_id
                   AND shop_product_overrides.is_available IS TRUE
                   AND p.is_available IS TRUE"""


#: Downgrade: every unset shop row gets what it resolves to without a till level.
INHERIT_TO_EXPLICIT = """
        UPDATE shop_product_overrides
           SET is_available = COALESCE(c.is_available, p.is_available, TRUE)
          FROM shops s
          JOIN products p ON TRUE
          LEFT JOIN company_product_overrides c
            ON c.company_id = s.company_id AND c.product_id = p.id
         WHERE s.id = shop_product_overrides.shop_id
           AND p.id = shop_product_overrides.global_product_id
           AND shop_product_overrides.is_available IS NULL"""


def _index(table: str, column: str) -> str:
    # The names SQLAlchemy gives `index=True`, so the migration and `create_all` agree.
    return f"ix_{table}_{column}"


def upgrade() -> None:
    offline = context.is_offline_mode()
    if offline:
        # `alembic upgrade --sql` has no database to inspect; emit every statement.
        tables: set[str] = set()
    else:
        tables = set(sa.inspect(op.get_bind()).get_table_names())

    for table, owner, owner_table, unique in _LEVELS:
        if table not in tables:
            op.create_table(
                table,
                sa.Column("id", UUID(as_uuid=True), primary_key=True),
                sa.Column(
                    owner,
                    UUID(as_uuid=True),
                    sa.ForeignKey(f"{owner_table}.id", ondelete="CASCADE"),
                    nullable=False,
                ),
                sa.Column(
                    "product_id",
                    UUID(as_uuid=True),
                    sa.ForeignKey("products.id", ondelete="CASCADE"),
                    nullable=False,
                ),
                sa.Column("is_available", sa.Boolean(), nullable=True),
                sa.Column(
                    "created_at",
                    sa.DateTime(timezone=True),
                    nullable=False,
                    server_default=sa.text("now()"),
                ),
                sa.Column(
                    "updated_at",
                    sa.DateTime(timezone=True),
                    nullable=False,
                    server_default=sa.text("now()"),
                ),
                sa.UniqueConstraint(owner, "product_id", name=unique),
            )
        indexes = (
            set()
            if offline or table not in tables
            else {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}
        )
        for column in (owner, "product_id"):
            if _index(table, column) not in indexes:
                op.create_index(_index(table, column), table, [column])

    # The shop level becomes tri-state. Guarded on the column still being NOT NULL, so
    # it converts exactly once; see the module docstring for why `true` only becomes
    # NULL where the product's own flag is true.
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'shop_product_overrides'
                   AND column_name = 'is_available'
                   AND is_nullable = 'NO'
            ) THEN
                ALTER TABLE shop_product_overrides ALTER COLUMN is_available DROP NOT NULL;
                {TRUE_TO_INHERIT};
            END IF;
        END
        $$
        """
    )


def downgrade() -> None:
    # Before this revision the shop row alone was the till's answer, so fold into every
    # unset shop row what it resolves to without a till level: the shop's own company's
    # setting, else the product's flag. Till-level settings cannot be represented and
    # are lost with their table.
    op.execute(INHERIT_TO_EXPLICIT)
    op.alter_column("shop_product_overrides", "is_available", nullable=False)
    for table, owner, _owner_table, _unique in reversed(_LEVELS):
        op.drop_table(table)
