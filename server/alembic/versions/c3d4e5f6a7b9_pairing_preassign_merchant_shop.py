"""pairing pre-assign merchant and shop on pairing codes

Revision ID: c3d4e5f6a7b9
Revises: b2c3d4e5f6a8
Create Date: 2026-06-18 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "c3d4e5f6a7b9"
down_revision = "b2c3d4e5f6a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pairing_codes", sa.Column("merchant_id", UUID(as_uuid=True), nullable=True))
    op.add_column("pairing_codes", sa.Column("shop_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_pairing_codes_merchant_id",
        "pairing_codes",
        "merchants",
        ["merchant_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_pairing_codes_shop_id",
        "pairing_codes",
        "shops",
        ["shop_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_pairing_codes_shop_id", "pairing_codes", type_="foreignkey")
    op.drop_constraint("fk_pairing_codes_merchant_id", "pairing_codes", type_="foreignkey")
    op.drop_column("pairing_codes", "shop_id")
    op.drop_column("pairing_codes", "merchant_id")
