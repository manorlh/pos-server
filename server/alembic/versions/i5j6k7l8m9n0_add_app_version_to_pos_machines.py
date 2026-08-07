"""add app_version to pos_machines

Revision ID: i5j6k7l8m9n0
Revises: h4i5j6k7l8m9
Create Date: 2026-08-07 13:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "i5j6k7l8m9n0"
down_revision = "h4i5j6k7l8m9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pos_machines",
        sa.Column("app_version", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pos_machines", "app_version")
