"""prepaid voucher redemptions: reversed_at

A redemption taken at the payment screen ("שובר" as a tender) is undone when the
cashier abandons that payment: the goods go back on the voucher and the row stays, marked
reversed, for the record.

Revision ID: af2c3d4e5f60
Revises: ae1b2c3d4e5f
"""
from alembic import op
import sqlalchemy as sa

revision = "af2c3d4e5f60"
down_revision = "ae1b2c3d4e5f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "prepaid_voucher_redemptions",
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("prepaid_voucher_redemptions", "reversed_at")
