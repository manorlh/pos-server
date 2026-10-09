"""kitchen_printers.print_width_dots: a printer's print width ("רוחב הדפסה")

Revision ID: 8c2e4a6f0b13
Revises: e4f6a8b0c2d4
Create Date: 2026-10-06

How many dots wide the printer's head prints (576, 512, 432, 384). Null — the existing
printers and the default — is "by the paper" (58 mm → 384, 80 mm → 576), as before. An
80 mm printer whose head prints 512 dots (an SNBC BTP-S80, a 180-dpi head) wraps each row
of a 576-dot raster onto the next: a skewed ticket cut off on the right.

Additive and idempotent: the column is added only when it is missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '8c2e4a6f0b13'
down_revision: Union[str, Sequence[str], None] = 'e4f6a8b0c2d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'kitchen_printers'
COLUMN = 'print_width_dots'


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if COLUMN not in {c['name'] for c in inspector.get_columns(TABLE)}:
        op.add_column(TABLE, sa.Column(COLUMN, sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column(TABLE, COLUMN)
