"""item blocks: a target (tills and kiosks / kiosks only / tills only), category blocks, one list

specs/item-blocks-targets.md. `sold_out_marks` gains:

* `target` ("all" | "kiosks" | "tills", default "all") — whom at the level. Backfilled to "kiosks"
  for the two older scopes (`kiosks` = the shop's kiosks, `kiosk` = one kiosk), whose `scope` stays
  as it was and stays readable (app/services/sold_out_rules.py `level_of`).
* `category_id` — a block on a whole category; `product_id` becomes nullable, and a CHECK keeps
  exactly one of the two.
* `kiosk_display` ("hide" | "grey" | NULL) — the kiosks' look for this block.
* `origin` — where it was set from.

"מוסתר בקיוסקים" (`kiosk_quick_hides`) folds into the same list: every row still in force is copied
under the SAME id as a shop-level, kiosks-only "חסום" with the look "hide" (a product as its global
product). The old table and its rows stay as they were — the record of who hid what; nothing reads
them any more.

Idempotent (columns, index and constraint are looked at first; the copy skips ids already there).

Revision ID: c7d1a9e4f2b6
Revises: b8e2d4f6a1c3
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c7d1a9e4f2b6"
down_revision: Union[str, Sequence[str], None] = "b8e2d4f6a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "sold_out_marks"
HIDES = "kiosk_quick_hides"
CHECK = "ck_sold_out_marks_item"
INDEX = "ix_sold_out_marks_shop_category"

BACKFILL_TARGET = (
    "UPDATE sold_out_marks SET target = 'kiosks' "
    "WHERE scope IN ('kiosks', 'kiosk') AND target <> 'kiosks'"
)

COPY_HIDES = """
INSERT INTO sold_out_marks (
    id, tenant_id, company_id, shop_id, product_id, category_id, scope, scope_id, target, kind,
    kiosk_display, origin, until, until_mode, source, note, created_by_user_id, created_by_name,
    created_at, updated_at
)
SELECT
    h.id, h.tenant_id, s.company_id, h.shop_id,
    CASE WHEN h.kind = 'product' THEN COALESCE(p.global_product_id, p.id) END,
    CASE WHEN h.kind = 'category' THEN c.id END,
    'shop', h.shop_id, 'kiosks', 'blocked',
    'hide', 'kiosk_hide', h.until, NULL, 'manual', h.note, h.created_by_user_id, h.created_by_name,
    h.created_at, CURRENT_TIMESTAMP
FROM kiosk_quick_hides h
JOIN shops s ON s.id = h.shop_id
LEFT JOIN products p ON h.kind = 'product' AND p.id = h.item_id
LEFT JOIN categories c ON h.kind = 'category' AND c.id = h.item_id
WHERE h.cleared_at IS NULL
  AND (h.until IS NULL OR h.until > CURRENT_TIMESTAMP)
  AND ((h.kind = 'product' AND p.id IS NOT NULL) OR (h.kind = 'category' AND c.id IS NOT NULL))
ON CONFLICT (id) DO NOTHING
"""


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    have = set() if insp is None else {c["name"] for c in insp.get_columns(TABLE)}
    if "target" not in have:
        op.add_column(TABLE, sa.Column("target", sa.String(8), nullable=False, server_default="all"))
    if "category_id" not in have:
        op.add_column(
            TABLE,
            sa.Column("category_id", uuid, sa.ForeignKey("categories.id", ondelete="CASCADE"), nullable=True),
        )
    if "kiosk_display" not in have:
        op.add_column(TABLE, sa.Column("kiosk_display", sa.String(8), nullable=True))
    if "origin" not in have:
        op.add_column(TABLE, sa.Column("origin", sa.String(16), nullable=True))
    op.alter_column(TABLE, "product_id", existing_type=uuid, nullable=True)

    indexes = set() if insp is None else {i["name"] for i in insp.get_indexes(TABLE)}
    if INDEX not in indexes:
        op.create_index(INDEX, TABLE, ["shop_id", "category_id"])
    checks = set() if insp is None else {c.get("name") for c in insp.get_check_constraints(TABLE)}
    if CHECK not in checks:
        op.create_check_constraint(CHECK, TABLE, "(product_id IS NULL) <> (category_id IS NULL)")

    op.execute(BACKFILL_TARGET)
    if insp is None or insp.has_table(HIDES):
        op.execute(COPY_HIDES)


def downgrade() -> None:
    # The copies of "מוסתר בקיוסקים" go (their originals are still in kiosk_quick_hides), and so do
    # the category blocks, which the older shape cannot hold.
    op.execute("DELETE FROM sold_out_marks WHERE origin = 'kiosk_hide'")
    op.execute("DELETE FROM sold_out_marks WHERE product_id IS NULL")
    op.drop_constraint(CHECK, TABLE, type_="check")
    op.drop_index(INDEX, table_name=TABLE)
    op.alter_column(TABLE, "product_id", existing_type=postgresql.UUID(as_uuid=True), nullable=False)
    for name in ("origin", "kiosk_display", "category_id", "target"):
        op.drop_column(TABLE, name)
