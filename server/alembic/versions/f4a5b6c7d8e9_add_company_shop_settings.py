"""add settings JSONB to companies and shops

Revision ID: f4a5b6c7d8e9
Revises: ee55ff66aa77
Create Date: 2026-05-30 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "f4a5b6c7d8e9"
down_revision = "ee55ff66aa77"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "companies",
        sa.Column("settings", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.add_column(
        "companies",
        sa.Column(
            "settings_updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.add_column(
        "shops",
        sa.Column("settings", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.add_column(
        "shops",
        sa.Column(
            "settings_updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    op.drop_column("shops", "settings_updated_at")
    op.drop_column("shops", "settings")
    op.drop_column("companies", "settings_updated_at")
    op.drop_column("companies", "settings")
