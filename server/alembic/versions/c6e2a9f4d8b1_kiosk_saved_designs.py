"""kiosk saved designs

"עיצובים שמורים לקיוסק" (P:/specs/kiosk-saved-designs.md): `kiosk_designs` (a named partial kiosk config
layer per company or shop), its audit `kiosk_design_audit`, and the assignment on every kiosk settings layer
(`kiosk_settings.design_id`, `kiosk_settings.design_off`). Add-only.

Revision ID: c6e2a9f4d8b1
Revises: a1d5e8c3b7f2
Create Date: 2026-10-17 15:00:00

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c6e2a9f4d8b1"
down_revision: Union[str, Sequence[str], None] = "a1d5e8c3b7f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "kiosk_designs",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
        sa.Column("company_id", UUID, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
        sa.Column("shop_id", UUID, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("groups", JSONB, nullable=False),
        sa.Column("overrides", JSONB, nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_by_user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by_user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_kiosk_designs_tenant_id", "kiosk_designs", ["tenant_id"])
    op.create_index("ix_kiosk_designs_company", "kiosk_designs", ["company_id", "shop_id"])
    op.create_table(
        "kiosk_design_audit",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("tenant_id", UUID, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
        sa.Column("design_id", UUID, nullable=True),
        sa.Column("company_id", UUID, nullable=True),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("design_name", sa.String(80), nullable=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_name", sa.String(200), nullable=True),
        sa.Column("detail", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_kiosk_design_audit_tenant_id", "kiosk_design_audit", ["tenant_id"])
    op.create_index("ix_kiosk_design_audit_design_id", "kiosk_design_audit", ["design_id"])
    with op.batch_alter_table("kiosk_settings") as batch:
        batch.add_column(sa.Column("design_id", UUID, nullable=True))
        batch.add_column(sa.Column("design_off", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.create_foreign_key(
            "fk_kiosk_settings_design_id", "kiosk_designs", ["design_id"], ["id"], ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("kiosk_settings") as batch:
        batch.drop_constraint("fk_kiosk_settings_design_id", type_="foreignkey")
        batch.drop_column("design_off")
        batch.drop_column("design_id")
    op.drop_index("ix_kiosk_design_audit_design_id", table_name="kiosk_design_audit")
    op.drop_index("ix_kiosk_design_audit_tenant_id", table_name="kiosk_design_audit")
    op.drop_table("kiosk_design_audit")
    op.drop_index("ix_kiosk_designs_company", table_name="kiosk_designs")
    op.drop_index("ix_kiosk_designs_tenant_id", table_name="kiosk_designs")
    op.drop_table("kiosk_designs")
