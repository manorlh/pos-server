"""kiosk_devices.home_role — a till that may work as a kiosk ("מצב עבודה")

Revision ID: b7d3f1a9c5e8
Revises: a6c2e8f4b0d7
Create Date: 2026-10-10

P:/specs/kiosk-landscape-till-mode.md §5.10 (the owner: both directions, by the role given): a till
whose owner allowed the kiosk mode (`kioskTillModeEnabled`) gets a kiosk-mode row when it first asks
for it, marked `home_role = 'till'`. NULL — every existing row — is a kiosk by role, as always. Add-only
(a nullable column), idempotent.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b7d3f1a9c5e8'
down_revision: Union[str, Sequence[str], None] = 'a6c2e8f4b0d7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("kiosk_devices")}
    if "home_role" not in columns:
        op.add_column("kiosk_devices", sa.Column("home_role", sa.String(length=16), nullable=True))


def downgrade() -> None:
    # Never run in production (additive only); kept so the chain stays walkable.
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("kiosk_devices")}
    if "home_role" in columns:
        op.drop_column("kiosk_devices", "home_role")
