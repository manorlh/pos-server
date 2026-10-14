"""dining_tables.label_only: a restored table shown by its name alone ("ש-12")

"שחזור שולחן עם התשלומים שלו" (P:/specs/table-restore-payments.md §1): a closed table restored while its
own number is taken opens as a new table beside it, labelled "ש-12". Its number is the cloud's
(it must have one), never shown: `labelOnly` in every table the tills and the dashboard read.
Existing tables are not label-only.

Revision ID: a7d3e1c9b5f2
Revises: 78c88a7afc4f
Create Date: 2026-10-14

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a7d3e1c9b5f2'
down_revision: Union[str, Sequence[str], None] = '78c88a7afc4f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'dining_tables',
        sa.Column('label_only', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    )


def downgrade() -> None:
    op.drop_column('dining_tables', 'label_only')
