"""pairing tenant scope — store tenant on codes and backfill machines

Revision ID: cc33dd44ee55
Revises: aa11bb22cc33
Create Date: 2026-05-30 15:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "cc33dd44ee55"
down_revision = "aa11bb22cc33"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pairing_codes", sa.Column("tenant_id", UUID(as_uuid=True), nullable=True))
    op.create_index("ix_pairing_codes_tenant_id", "pairing_codes", ["tenant_id"])
    op.create_foreign_key(
        "fk_pairing_codes_tenant_id",
        "pairing_codes",
        "tenants",
        ["tenant_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.execute(
        """
        UPDATE pairing_codes pc
        SET tenant_id = u.tenant_id
        FROM users u
        WHERE pc.distributor_id = u.id
          AND pc.tenant_id IS NULL
          AND u.tenant_id IS NOT NULL
        """
    )

    op.execute(
        """
        UPDATE pos_machines pm
        SET tenant_id = pc.tenant_id
        FROM pairing_codes pc
        WHERE pc.pos_machine_id = pm.id
          AND pm.tenant_id IS NULL
          AND pc.tenant_id IS NOT NULL
        """
    )

    op.execute(
        """
        UPDATE pos_machines pm
        SET tenant_id = u.tenant_id
        FROM users u
        WHERE pm.distributor_id = u.id
          AND pm.tenant_id IS NULL
          AND u.tenant_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_constraint("fk_pairing_codes_tenant_id", "pairing_codes", type_="foreignkey")
    op.drop_index("ix_pairing_codes_tenant_id", table_name="pairing_codes")
    op.drop_column("pairing_codes", "tenant_id")
