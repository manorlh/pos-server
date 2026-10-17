"""shifts.total_device_cash — "מזומן במכשיר", the cash a cash device took (not in the drawer)

Cash paid into a cash device (a CashMag recycler or a PayLink station, the leg's
`nayax_meta.cashDevice`) is cash takings — `total_cash` keeps it, the fiscal figures do not move — but
it is in the device, never in the till's drawer: a Z's / shift's expected cash leaves it out
(app/services/z_builder.py). The cloud counts it from the shift's documents like every other X figure
(app/services/shift_totals.py `device_cash`). Nullable, nothing backfilled: a shift closed before reads
its till's frozen `till.totalDeviceCash` if any, else none.

Revision ID: d4e8b2a6c9f1
Revises: 3d3e57627db5
Create Date: 2026-10-17 21:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4e8b2a6c9f1"
down_revision: Union[str, Sequence[str], None] = "3d3e57627db5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("shifts", sa.Column("total_device_cash", sa.Numeric(12, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("shifts", "total_device_cash")
