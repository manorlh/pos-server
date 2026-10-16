"""merge 17.10b release heads

Release 17.10b (release/2026-10-17b-server) has three heads. Each branch revises main's head 6b3b29c7bc5b
(the 17.10 merge revision) on its own, so each can also be merged alone:

- e7c4a1b9d3f6 — table scope and labels: `pos_machines.table_scope`, `pos_users.table_scope`,
  `dining_tables.label` / `label_key`, `table_orders.table_label`, `table_scope_changes` (add-only)
- c5e1a8d3f7b9 — device license type: `pos_machines.license_product` / `license_product_history`,
  `pairing_codes.license_product`, and the backfill of fiscal machines' product (add-only + backfill)
- c4e8a2f6b19d — preset discounts: `transactions.preset_discount_*` and its index (add-only)

The license backfill writes only `pos_machines.license_product` / `license_product_history`, which neither
other branch touches. Nothing of its own.

Revision ID: b87054615214
Revises: e7c4a1b9d3f6, c5e1a8d3f7b9, c4e8a2f6b19d
Create Date: 2026-10-17 20:00:00

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = 'b87054615214'
down_revision: Union[str, Sequence[str], None] = ('e7c4a1b9d3f6', 'c5e1a8d3f7b9', 'c4e8a2f6b19d')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
