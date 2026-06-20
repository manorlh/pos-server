"""mobile QR pairing sessions and device pairing requests

Revision ID: d4e5f6a7b8c0
Revises: c3d4e5f6a7b9
Create Date: 2026-06-19 16:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, ENUM

revision = "d4e5f6a7b8c0"
down_revision = "c3d4e5f6a7b9"
branch_labels = None
depends_on = None

device_pairing_status = ENUM(
    "waiting", "claimed", "delivered", "expired",
    name="devicepairingstatus",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    ENUM(
        "waiting", "claimed", "delivered", "expired",
        name="devicepairingstatus",
    ).create(bind, checkfirst=True)

    op.create_table(
        "pairing_sessions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("jti", sa.String(64), nullable=False),
        sa.Column("distributor_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("default_company_id", UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=True),
        sa.Column("default_shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("machines_paired_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_pairing_sessions_jti", "pairing_sessions", ["jti"], unique=True)
    op.create_index("ix_pairing_sessions_distributor_id", "pairing_sessions", ["distributor_id"])
    op.create_index("ix_pairing_sessions_tenant_id", "pairing_sessions", ["tenant_id"])

    op.create_table(
        "device_pairing_requests",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("device_nonce", sa.String(128), nullable=False),
        sa.Column("status", device_pairing_status, nullable=False, server_default="waiting"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_info", sa.JSON(), nullable=True),
        sa.Column("machine_name", sa.String(255), nullable=True),
        sa.Column("pairing_session_id", UUID(as_uuid=True), sa.ForeignKey("pairing_sessions.id"), nullable=True),
        sa.Column("pos_machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=True),
        sa.Column("credentials_payload", sa.JSON(), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_device_pairing_requests_device_nonce", "device_pairing_requests", ["device_nonce"], unique=True)

    op.add_column(
        "pos_machines",
        sa.Column("pairing_session_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_pos_machines_pairing_session_id",
        "pos_machines",
        "pairing_sessions",
        ["pairing_session_id"],
        ["id"],
    )
    op.create_index("ix_pos_machines_pairing_session_id", "pos_machines", ["pairing_session_id"])


def downgrade() -> None:
    op.drop_index("ix_pos_machines_pairing_session_id", table_name="pos_machines")
    op.drop_constraint("fk_pos_machines_pairing_session_id", "pos_machines", type_="foreignkey")
    op.drop_column("pos_machines", "pairing_session_id")

    op.drop_index("ix_device_pairing_requests_device_nonce", table_name="device_pairing_requests")
    op.drop_table("device_pairing_requests")

    op.drop_index("ix_pairing_sessions_tenant_id", table_name="pairing_sessions")
    op.drop_index("ix_pairing_sessions_distributor_id", table_name="pairing_sessions")
    op.drop_index("ix_pairing_sessions_jti", table_name="pairing_sessions")
    op.drop_table("pairing_sessions")

    ENUM(
        "waiting", "claimed", "delivered", "expired",
        name="devicepairingstatus",
    ).drop(op.get_bind(), checkfirst=True)
