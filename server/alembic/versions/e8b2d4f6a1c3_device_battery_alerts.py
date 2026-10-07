"""Device low-battery alerts ("סוללה חלשה")

Revision ID: e8b2d4f6a1c3
Revises: f6c8e0a2b4d9
Create Date: 2026-10-07

docs/SPEC_KIOSK_INSIGHTS.md §6: a discharging device (handheld, tablet, kiosk with a battery)
crossing 15 / 10 / 5 % writes one row per threshold and discharge cycle — routed to the
shop's tills like the kiosk alerts, and the history of "תקינות מכשירים".

Idempotent: the auto-reloading dev API runs `create_all` at startup and may have made the
table before this runs — then only the missing indexes are added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e8b2d4f6a1c3"
down_revision: Union[str, Sequence[str], None] = "f6c8e0a2b4d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "device_battery_alerts"
INDEXES = (
    ("ix_device_battery_alerts_machine_raised", ["machine_id", "raised_at"]),
    ("ix_device_battery_alerts_tenant_open", ["tenant_id", "cleared_at"]),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        uuid = postgresql.UUID(as_uuid=True)
        op.create_table(
            TABLE,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="SET NULL"), nullable=True),
            sa.Column("machine_id", uuid, sa.ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False),
            sa.Column("cycle_id", uuid, nullable=False),
            sa.Column("level", sa.Integer(), nullable=False),
            sa.Column("percent", sa.Integer(), nullable=False),
            sa.Column("last_percent", sa.Integer(), nullable=True),
            sa.Column("severity", sa.String(16), nullable=False, server_default="warning"),
            sa.Column("raised_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("clear_reason", sa.String(16), nullable=True),
            sa.Column("cycle_ended_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acknowledged_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        inspector = sa.inspect(bind)
    have = {i["name"] for i in inspector.get_indexes(TABLE)}
    for name, columns in INDEXES:
        if name not in have:
            op.create_index(name, TABLE, columns)


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table(TABLE):
        op.drop_table(TABLE)
