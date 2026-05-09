"""backfill_shop_product_assortment

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-04-03

Explicit assortment: preserve behavior for existing data by assigning every global
product to each shop under the same merchant (company.merchant_id = product.merchant_id).
"""
from typing import Sequence, Union

from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO shop_product_overrides (id, shop_id, global_product_id, price, is_listed)
        SELECT gen_random_uuid(), s.id, p.id, NULL, true
        FROM shops s
        JOIN companies c ON c.id = s.company_id
        JOIN products p ON p.merchant_id = c.merchant_id
          AND p.catalog_level = 'global'
          AND p.pos_machine_id IS NULL
        ON CONFLICT (shop_id, global_product_id) DO NOTHING
        """
    )


def downgrade() -> None:
    # Cannot safely remove rows — may have been edited after backfill.
    pass
