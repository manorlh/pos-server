"""Device identity: the serial's source, the SIMs, the addresses — and the device search's indexes

Revision ID: d6f1b3a9c7e5
Revises: e7b3c9a1d5f2
Create Date: 2026-10-06

app/services/device_identity.py (the owner, 2026-10-06: "אפשר בענן לבצע חיפוש מכשיר לפי
סריאלי, קופה, סניף וכדומה"):
- `pos_machines.serial_source`: where the serial came from (ftpos | sunmi | build | ro.serialno);
- `cellular` (+ `cellular_reported_at`): the heartbeat's SIMs block as last sent;
- `sim_carriers`, `phone_numbers`: flattened from it for the search;
- `last_ip` (as the cloud saw the beat), `lan_ip` (the device's own);
- indexes for the search: those four, `app_version`, `last_heartbeat_at`, and
  `upper(serial_number) varchar_pattern_ops` for a serial searched by prefix in any case.
Additive and idempotent (a column or index already there is left as it is).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'd6f1b3a9c7e5'
down_revision: Union[str, Sequence[str], None] = 'e7b3c9a1d5f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "pos_machines"

COLUMNS = (
    ("serial_source", sa.String(32)),
    ("cellular", postgresql.JSONB(astext_type=sa.Text())),
    ("cellular_reported_at", sa.DateTime(timezone=True)),
    ("sim_carriers", sa.String(200)),
    ("phone_numbers", sa.String(200)),
    ("last_ip", sa.String(64)),
    ("lan_ip", sa.String(64)),
)

INDEXED = ("sim_carriers", "phone_numbers", "last_ip", "lan_ip", "app_version", "last_heartbeat_at")
SERIAL_UPPER = "ix_pos_machines_serial_number_upper"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    have = {c["name"] for c in inspector.get_columns(TABLE)}
    for name, type_ in COLUMNS:
        if name not in have:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))
    indexes = {i["name"] for i in sa.inspect(bind).get_indexes(TABLE)}
    for column in INDEXED:
        name = f"ix_{TABLE}_{column}"
        if name not in indexes:
            op.create_index(name, TABLE, [column])
    if SERIAL_UPPER not in indexes:
        op.execute(f"CREATE INDEX IF NOT EXISTS {SERIAL_UPPER} ON {TABLE} (upper(serial_number) varchar_pattern_ops)")


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {SERIAL_UPPER}")
    indexes = {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(TABLE)}
    for column in INDEXED:
        name = f"ix_{TABLE}_{column}"
        if name in indexes:
            op.drop_index(name, table_name=TABLE)
    have = {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}
    for name, _ in reversed(COLUMNS):
        if name in have:
            op.drop_column(TABLE, name)
