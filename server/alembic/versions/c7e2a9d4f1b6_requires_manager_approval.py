"""Products and categories that need a manager's code to be sold

Revision ID: c7e2a9d4f1b6
Revises: c3f8a1d6e94b
Create Date: 2026-10-08

Re-chained at the integration merge (integration/fri, 09.10.2026): written on 8c4a2f6e1b93, now
after the integration head c3f8a1d6e94b (voucher distribution) so the chain stays linear. The
upgrade itself is unchanged.

The owner: "תוסיף אופציה בהגדרה לסיסמה לקטגוריה או לפריט מסויים שחייב סיסמת מנהל, תבנה את זה
בהרשאות" — in every sale, nothing to do with vouchers.

* `products.requires_manager_approval` — "מחייב אישור מנהל במכירה" on the product itself;
* `categories.requires_manager_approval` — the same on a category: every product under it, and
  under every category beneath it, is restricted too (app/services/restricted_items.py).

The till asks for a manager's code (permission `SELL_RESTRICTED_ITEMS`, which needs no
migration: a code added to the catalogue answers from each role's template); kiosks leave
such products and categories out.

Idempotent: each column is added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c7e2a9d4f1b6'
down_revision: Union[str, Sequence[str], None] = 'c3f8a1d6e94b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMN = 'requires_manager_approval'
TABLES = ('products', 'categories')


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table in TABLES:
        if not inspector.has_table(table):
            continue
        if COLUMN not in {c['name'] for c in inspector.get_columns(table)}:
            op.add_column(
                table,
                sa.Column(COLUMN, sa.Boolean(), nullable=False, server_default=sa.text('false')),
            )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table in reversed(TABLES):
        if inspector.has_table(table) and COLUMN in {c['name'] for c in inspector.get_columns(table)}:
            op.drop_column(table, COLUMN)
