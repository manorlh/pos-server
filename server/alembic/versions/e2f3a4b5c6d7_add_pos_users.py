"""add pos_users (per-shop till operators with bcrypt PIN)

Revision ID: e2f3a4b5c6d7
Revises: d1e2f3a4b5c6
Create Date: 2026-05-02 13:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "e2f3a4b5c6d7"
down_revision = "d1e2f3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pos_users",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=False),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("first_name", sa.String(100), nullable=True),
        sa.Column("last_name", sa.String(100), nullable=True),
        sa.Column("worker_number", sa.String(32), nullable=True),
        sa.Column("pin_hash", sa.String(255), nullable=False),
        sa.Column(
            "role",
            sa.Enum("cashier", "shop_manager", name="posuserrole"),
            nullable=False,
            server_default="cashier",
        ),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("shop_id", "username", name="uq_pos_user_shop_username"),
    )
    op.create_index("ix_pos_users_merchant_id", "pos_users", ["merchant_id"])
    op.create_index("ix_pos_users_shop_id", "pos_users", ["shop_id"])
    op.create_index("ix_pos_users_shop_updated", "pos_users", ["shop_id", "updated_at"])
    # Partial unique on (shop_id, worker_number) — only when worker_number is set.
    op.create_index(
        "uq_pos_user_shop_worker_number",
        "pos_users",
        ["shop_id", "worker_number"],
        unique=True,
        postgresql_where=sa.text("worker_number IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_pos_user_shop_worker_number", table_name="pos_users")
    op.drop_index("ix_pos_users_shop_updated", table_name="pos_users")
    op.drop_index("ix_pos_users_shop_id", table_name="pos_users")
    op.drop_index("ix_pos_users_merchant_id", table_name="pos_users")
    op.drop_table("pos_users")
    sa.Enum(name="posuserrole").drop(op.get_bind(), checkfirst=True)
