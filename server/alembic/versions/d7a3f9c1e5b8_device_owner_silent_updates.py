"""Device owner, silent updates and cloud reboot ("עדכון שקט")

Revision ID: d7a3f9c1e5b8
Revises: e8b2d4f6a1c3
Create Date: 2026-10-07

docs/SPEC_UPDATES.md §5: the till reports on its heartbeat whether it is the device owner,
which install path its updates take (silent or a tap) and how its kiosk lock holds
(`pos_machines.device_management`, a cleaned JSON block, and when it said so); the dashboard's
"הפעל מחדש" waits for a device-owner till on `pos_machines.reboot_request`; and every Android
release keeps the SHA-256 of its signing certificate (`app_releases.signing_cert_sha256`), which
the Android Enterprise QR (factory-reset provisioning) carries as its signature checksum.

Idempotent: columns are added only where missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d7a3f9c1e5b8"
down_revision: Union[str, Sequence[str], None] = "e8b2d4f6a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("pos_machines", "device_management", lambda: postgresql.JSONB(astext_type=sa.Text())),
    ("pos_machines", "device_management_reported_at", lambda: sa.DateTime(timezone=True)),
    ("pos_machines", "reboot_request", lambda: postgresql.JSONB(astext_type=sa.Text())),
    ("app_releases", "signing_cert_sha256", lambda: sa.String(64)),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table, column, kind in COLUMNS:
        if not inspector.has_table(table):
            continue
        have = {c["name"] for c in inspector.get_columns(table)}
        if column not in have:
            op.add_column(table, sa.Column(column, kind(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table, column, _kind in reversed(COLUMNS):
        if inspector.has_table(table) and column in {c["name"] for c in inspector.get_columns(table)}:
            op.drop_column(table, column)
