"""add tip fields to transactions and z_reports

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-06-27 14:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "f2a3b4c5d6e7"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column("tip_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
    )
    op.add_column(
        "transactions",
        sa.Column("tip_payment_method", sa.String(10), nullable=True),
    )
    op.add_column(
        "z_reports",
        sa.Column("total_tips", sa.Numeric(12, 2), nullable=True),
    )
    op.add_column(
        "z_reports",
        sa.Column("total_cash_tips", sa.Numeric(12, 2), nullable=True),
    )
    op.add_column(
        "z_reports",
        sa.Column("total_card_tips", sa.Numeric(12, 2), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("z_reports", "total_card_tips")
    op.drop_column("z_reports", "total_cash_tips")
    op.drop_column("z_reports", "total_tips")
    op.drop_column("transactions", "tip_payment_method")
    op.drop_column("transactions", "tip_amount")
