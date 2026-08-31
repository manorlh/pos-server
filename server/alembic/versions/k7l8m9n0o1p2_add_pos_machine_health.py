"""add device identity and health columns to pos_machines

Serial, battery and clock skew become real columns rather than keys inside
`device_info`, because the questions they exist to answer are fleet-wide filters:
"which tills are running flat", "which till has a drifting clock", "which
physical box is on that counter". None of those are queryable out of a JSON blob.

Revision ID: k7l8m9n0o1p2
Revises: j6k7l8m9n0o1
Create Date: 2026-08-27 09:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "k7l8m9n0o1p2"
down_revision = "j6k7l8m9n0o1"
branch_labels = None
depends_on = None


# All columns are nullable with no server_default. For battery_percent that is
# load-bearing: NULL means "the device could not read it", which is a different
# fact from 0, and backfilling a default would destroy the distinction on every
# existing row.
_NEW_COLUMNS = (
    ("serial_number", sa.Column("serial_number", sa.String(length=64), nullable=True)),
    ("battery_percent", sa.Column("battery_percent", sa.SmallInteger(), nullable=True)),
    ("battery_status", sa.Column("battery_status", sa.String(length=16), nullable=True)),
    # BigInteger, not Integer: the value is signed device-minus-server milliseconds,
    # and a terminal that booted with an unset clock is out by decades — which
    # overflows a 32-bit integer in ms.
    ("clock_skew_ms", sa.Column("clock_skew_ms", sa.BigInteger(), nullable=True)),
    (
        "last_health_report_at",
        sa.Column("last_health_report_at", sa.DateTime(timezone=True), nullable=True),
    ),
)

_SERIAL_INDEX = "ix_pos_machines_serial_number"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("pos_machines")}
    for name, column in _NEW_COLUMNS:
        if name not in existing:
            op.add_column("pos_machines", column)

    existing_indexes = {ix["name"] for ix in inspector.get_indexes("pos_machines")}
    if _SERIAL_INDEX not in existing_indexes:
        # Support is handed a serial off the back of a unit and has to find the
        # machine row; that lookup should not be a fleet-wide scan.
        op.create_index(_SERIAL_INDEX, "pos_machines", ["serial_number"])


def downgrade() -> None:
    op.drop_index(_SERIAL_INDEX, table_name="pos_machines")
    for name, _ in reversed(_NEW_COLUMNS):
        op.drop_column("pos_machines", name)
