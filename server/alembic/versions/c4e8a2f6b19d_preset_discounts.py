"""הנחות קבועות: the preset discount on a sale document

P:/specs/preset-discounts.md §5 (app/services/preset_discounts.py): `transactions.preset_discount_id`
(indexed — the tracking report filters by it), `preset_discount_name`, `preset_discount_for`,
`preset_discount_for_kind`, `preset_discount_for_ref`. All nullable; set only when the basket
discount is a preset's (`basket_discount_kind` "preset"). The presets themselves live in each
layer's settings JSON (`presetDiscounts`, `presetDiscountButtons`) — no table.

Revision ID: c4e8a2f6b19d
Revises: 6b3b29c7bc5b
Create Date: 2026-10-16
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c4e8a2f6b19d"
down_revision: Union[str, None] = "6b3b29c7bc5b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("preset_discount_id", 64),
    ("preset_discount_name", 60),
    ("preset_discount_for", 200),
    ("preset_discount_for_kind", 16),
    ("preset_discount_for_ref", 100),
)
INDEX = "ix_transactions_preset_discount_id"


def upgrade() -> None:
    bind = op.get_bind()
    have = {c["name"] for c in sa.inspect(bind).get_columns("transactions")} if not op.get_context().as_sql else set()
    for name, length in COLUMNS:
        if name not in have:
            op.add_column("transactions", sa.Column(name, sa.String(length), nullable=True))
    indexes = {i["name"] for i in sa.inspect(bind).get_indexes("transactions")} if not op.get_context().as_sql else set()
    if INDEX not in indexes:
        op.create_index(INDEX, "transactions", ["preset_discount_id"])


def downgrade() -> None:
    op.drop_index(INDEX, table_name="transactions")
    for name, _length in reversed(COLUMNS):
        op.drop_column("transactions", name)
