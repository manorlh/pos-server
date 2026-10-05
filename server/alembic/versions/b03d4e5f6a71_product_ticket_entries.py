"""products: ticket_entries (entry tickets — N separate tickets per unit)

Revision ID: b03d4e5f6a71
Revises: af2c3d4e5f60
"""
from alembic import op
import sqlalchemy as sa

revision = "b03d4e5f6a71"
down_revision = "af2c3d4e5f60"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("products", sa.Column("ticket_entries", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("products", "ticket_entries")
