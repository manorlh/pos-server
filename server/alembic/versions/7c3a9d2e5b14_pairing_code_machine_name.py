"""pairing_codes.machine_name: the optional name typed in the add-device form

"שם המכשיר — לא חובה" (docs/SPEC_PAIRING_QR.md §4): the dashboard's add-device form may carry a name for
the new till; it rides on the pairing code and becomes the machine's name when a device redeems it.

One nullable column, nothing else touched. Idempotent: the column is looked at first (the API's create_all
may have made it before this runs). Downgrade drops only this column.

Revision ID: 7c3a9d2e5b14, revises 4b6d1b7b3549.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "7c3a9d2e5b14"
down_revision: Union[str, Sequence[str], None] = "4b6d1b7b3549"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "pairing_codes"
COLUMN = "machine_name"


def _has_column() -> bool:
    if context.is_offline_mode():
        return False
    insp = sa.inspect(op.get_bind())
    return insp.has_table(TABLE) and COLUMN in {c["name"] for c in insp.get_columns(TABLE)}


def upgrade() -> None:
    if _has_column():
        return
    op.add_column(TABLE, sa.Column(COLUMN, sa.String(length=100), nullable=True))


def downgrade() -> None:
    if _has_column():
        op.drop_column(TABLE, COLUMN)
