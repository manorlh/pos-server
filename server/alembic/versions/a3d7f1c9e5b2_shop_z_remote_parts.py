"""shop Z remote parts: a participant off the LAN closes through the cloud — docs/SPEC_INDEPENDENT_TILL.md §8.14

Revision ID: a3d7f1c9e5b2
Revises: e9c4a7b2d5f1
Create Date: 2026-10-06

In local mode the main till closes every participating till over the LAN. A till or kiosk at
another location ("מרוחק (דרך הענן)") cannot hear it there: the main till asks the cloud, the
machine closes and uploads its part (section + manifest), and the main till pulls it into the
local shop Z. One row per request: `shop_z_remote_parts`.

Additive: a new table. Idempotent (the auto-reloading API may create it first).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'a3d7f1c9e5b2'
down_revision: Union[str, Sequence[str], None] = 'e9c4a7b2d5f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "shop_z_remote_parts"
INDEXES = (
    ("ix_shop_z_remote_parts_machine_state", ["machine_id", "state"], False),
    ("ix_shop_z_remote_parts_shop_round", ["shop_id", "round_id"], False),
    ("uq_shop_z_remote_parts_request", ["request_id"], True),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("shop_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=False),
            sa.Column("machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
            sa.Column("main_machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=True),
            sa.Column("round_id", sa.String(64), nullable=False),
            sa.Column("request_id", sa.String(64), nullable=False),
            sa.Column("force", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("state", sa.String(16), nullable=False, server_default="requested"),
            sa.Column("outcome", sa.String(24), nullable=True),
            sa.Column("message", sa.Text(), nullable=True),
            sa.Column("report", postgresql.JSONB(), nullable=True),
            sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("reported_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("z_report_id", postgresql.UUID(as_uuid=True), nullable=True),
        )
        inspector = sa.inspect(bind)
    have = {ix["name"] for ix in inspector.get_indexes(TABLE)}
    for name, cols, unique in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, cols, unique=unique)


def downgrade() -> None:
    op.drop_table(TABLE)
