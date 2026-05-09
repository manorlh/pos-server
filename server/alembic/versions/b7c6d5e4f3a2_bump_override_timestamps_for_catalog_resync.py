"""bump shop_product_overrides.updated_at so POS delta sync picks up rows again

Revision ID: b7c6d5e4f3a2
Revises: a8f9e7d6c5b4
Create Date: 2026-05-02

After fixing merged catalog isAvailable (assortment-only), machines that only
delta-sync would otherwise omit unchanged rows and keep stale SQLite flags.
Touching every override refreshes effective updatedAt for merged products.

"""

from alembic import op
import sqlalchemy as sa


revision = "b7c6d5e4f3a2"
down_revision = "a8f9e7d6c5b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("UPDATE shop_product_overrides SET updated_at = NOW()"))


def downgrade() -> None:
    pass
