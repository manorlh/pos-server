"""add pairing_codes company_id

Revision ID: f7a8b9c0d1e3
Revises: f6a7b8c9d0e2
Create Date: 2026-06-20 14:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "f7a8b9c0d1e3"
down_revision = "f6a7b8c9d0e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pairing_codes",
        sa.Column("company_id", UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=True),
    )
    op.create_index("ix_pairing_codes_company_id", "pairing_codes", ["company_id"])
    op.execute(
        sa.text(
            """
            UPDATE pairing_codes pc
            SET company_id = s.company_id
            FROM shops s
            WHERE pc.shop_id = s.id AND pc.company_id IS NULL
            """
        )
    )


def downgrade() -> None:
    op.drop_index("ix_pairing_codes_company_id", table_name="pairing_codes")
    op.drop_column("pairing_codes", "company_id")
