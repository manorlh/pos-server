"""kiosk notes and the kiosk tap per dish: products / categories .kiosk_notes, .kiosk_open

"הערה בקיוסק" (owner 17.10, "הערות זה פר פריט"): the kiosk offers a note on a dish only where the dish
allows it. Two nullable booleans; NULL inherits (product → its category → the parent categories) and
nothing set anywhere means no note (app/services/kiosk_notes.py).

"בקיוסק: פתיחת חלון" (owner 17.10): a tap on the dish at the kiosk — NULL as the kiosk's "הוספה מהירה",
"window" always opens its window, "direct" puts it straight in when nothing must be chosen
(app/services/kiosk_tap.py). Same inheritance. Nothing is backfilled.

Revision ID: c7d2e9f4a1b8
Revises: f1a7c3e9b2d6
Create Date: 2026-10-17 16:30:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c7d2e9f4a1b8"
down_revision: Union[str, Sequence[str], None] = "f1a7c3e9b2d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("products", sa.Column("kiosk_notes", sa.Boolean(), nullable=True))
    op.add_column("categories", sa.Column("kiosk_notes", sa.Boolean(), nullable=True))
    op.add_column("products", sa.Column("kiosk_open", sa.String(length=16), nullable=True))
    op.add_column("categories", sa.Column("kiosk_open", sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column("categories", "kiosk_open")
    op.drop_column("products", "kiosk_open")
    op.drop_column("categories", "kiosk_notes")
    op.drop_column("products", "kiosk_notes")
