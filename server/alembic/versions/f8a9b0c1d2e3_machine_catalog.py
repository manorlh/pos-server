"""a catalog per till: "all shop products" (as today) or a whitelist of the shop's products

A till can now sell a chosen subset of its shop's catalog. The rule lives in
`app/services/machine_catalog.py`:

* `pos_machines.catalog_mode` — ``'all'`` or ``'selected'``. NOT NULL with a server
  default of ``'all'``, so every existing till is in "all" mode after the upgrade and
  sells exactly what it sold before. Nothing is backfilled and no till re-pulls.
* `pos_machines.catalog_mode_updated_at` — stamped on each change of mode so the
  catalog watermark moves; NULL on every existing till ("never changed").
* `machine_catalog_items` (till × product) with a NOT NULL `is_included`. Removing a
  product from a till's list writes ``false`` rather than deleting the row, so the
  tills' delta pull and the watermark see the change. `ON DELETE CASCADE` on both
  foreign keys: an entry must never be what blocks deleting a till or a product.

Idempotent like its neighbours: the columns are `ADD COLUMN IF NOT EXISTS`, and the
table and its indexes are created only if absent (the app's `create_all` may already
have made them).

Downgrade drops the table and both columns. Every till goes back to selling its shop's
whole catalog, which is the only behaviour the previous code knows; the whitelists are
lost with the table.

Deploy order: run this before the new code, which reads `catalog_mode` on every
catalog pull. The old code never reads the new column or table, so running it early is
harmless.

Revision ID: f8a9b0c1d2e3
Revises: e7f8a9b0c1d2
Create Date: 2026-09-26 20:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "f8a9b0c1d2e3"
down_revision = "e7f8a9b0c1d2"
branch_labels = None
depends_on = None


TABLE = "machine_catalog_items"
UNIQUE = "uq_machine_catalog_item"

#: Both statements a constant so the test can read exactly what runs.
ADD_MODE = """
    ALTER TABLE pos_machines
        ADD COLUMN IF NOT EXISTS catalog_mode VARCHAR(16) NOT NULL DEFAULT 'all'"""

ADD_MODE_UPDATED_AT = """
    ALTER TABLE pos_machines
        ADD COLUMN IF NOT EXISTS catalog_mode_updated_at TIMESTAMP WITH TIME ZONE"""


def _index(column: str) -> str:
    # The names SQLAlchemy gives `index=True`, so the migration and `create_all` agree.
    return f"ix_{TABLE}_{column}"


def upgrade() -> None:
    op.execute(ADD_MODE)
    op.execute(ADD_MODE_UPDATED_AT)

    offline = context.is_offline_mode()
    tables = set() if offline else set(sa.inspect(op.get_bind()).get_table_names())
    if TABLE not in tables:
        op.create_table(
            TABLE,
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "machine_id",
                UUID(as_uuid=True),
                sa.ForeignKey("pos_machines.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "product_id",
                UUID(as_uuid=True),
                sa.ForeignKey("products.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "is_included", sa.Boolean(), nullable=False, server_default=sa.text("true")
            ),
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
            sa.UniqueConstraint("machine_id", "product_id", name=UNIQUE),
        )
    indexes = (
        set()
        if offline or TABLE not in tables
        else {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(TABLE)}
    )
    for column in ("machine_id", "product_id"):
        if _index(column) not in indexes:
            op.create_index(_index(column), TABLE, [column])


def downgrade() -> None:
    op.drop_table(TABLE)
    op.drop_column("pos_machines", "catalog_mode_updated_at")
    op.drop_column("pos_machines", "catalog_mode")
