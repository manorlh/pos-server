"""Card transmission items: `assumed` — card sales a batch carried that the terminal never named

Revision ID: b5e1c7a3d9f4
Revises: 9c4e2a7b5d13
Create Date: 2026-10-07

docs/SPEC_REPORTS.md §7 / docs/SHIFTS_API.md §4.1: a terminal that confirms a batch without
listing its sales (no `queriedTransactions`) leaves the till to assume its pending card sales
went in it. The till now reports those uids (`assumedTerminalTransactionIds`); the cloud keeps
them as items marked `assumed`, so the legs are marked transmitted — not verified — instead of
staying "untransmitted" on the cloud for ever.

Idempotent: the auto-reloading dev API may have added the column (create_all does not add
columns, but a parallel run may) — only what is missing is added.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b5e1c7a3d9f4"
down_revision: Union[str, Sequence[str], None] = "9c4e2a7b5d13"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "card_transmission_items"
COLUMN = "assumed"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        return
    have = {c["name"] for c in inspector.get_columns(TABLE)}
    if COLUMN not in have:
        op.add_column(
            TABLE,
            sa.Column(COLUMN, sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table(TABLE) and COLUMN in {c["name"] for c in inspector.get_columns(TABLE)}:
        op.drop_column(TABLE, COLUMN)
