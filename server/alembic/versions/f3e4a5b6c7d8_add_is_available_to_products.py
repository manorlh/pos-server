"""add is_available to products

Revision ID: f3e4a5b6c7d8
Revises: e2f3a4b5c6d7
Create Date: 2026-05-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3e4a5b6c7d8"
down_revision: Union[str, None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "products",
        sa.Column("is_available", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.alter_column("products", "is_available", server_default=None)


def downgrade() -> None:
    op.drop_column("products", "is_available")
