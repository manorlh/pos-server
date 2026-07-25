"""add mqtt_connected to pos_machines

Revision ID: h4i5j6k7l8m9
Revises: g3h4i5j6k7l8
Create Date: 2026-07-04 19:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "h4i5j6k7l8m9"
down_revision = "g3h4i5j6k7l8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pos_machines",
        sa.Column("mqtt_connected", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pos_machines", "mqtt_connected")
