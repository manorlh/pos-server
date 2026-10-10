"""A replaced till, documented; the cloud's data confirmed before a cloud Z

Revision ID: f5d7b9c1e3a2
Revises: e4c8a2f6d0b3
Create Date: 2026-10-06

docs/SPEC_OFFLINE_TILL_Z.md §4.6 — the owner: "תיעוד שהוחלפה קופה, אבל אפשר להוציא Z מהענן
עם הנתונים הקיימים", and "התראה לפני ביצוע, וגם שיציג מצב".

* `pairing_codes.replacement_reason` — why the till is being replaced, given with the code;
* `pos_machines.replacements` — every replacement of the till ("הוחלפה קופה"): the old and
  the new device, who, when, why, and whether support produced its Z first;
* `pos_machines.replacement_note_pending` — the last replacement, until the next Z of the
  till says it ("המכשיר הוחלף בתאריך …");
* `z_runs.cloud_data_confirmation` — who confirmed "אני מאשר שהנתונים בענן הם הנתונים
  הקיימים" for a cloud run, when, and the state of the tills it took.

Idempotent: added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'f5d7b9c1e3a2'
down_revision: Union[str, Sequence[str], None] = 'e4c8a2f6d0b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ('pairing_codes', 'replacement_reason', lambda: sa.String(500)),
    ('pos_machines', 'replacements', postgresql.JSONB),
    ('pos_machines', 'replacement_note_pending', postgresql.JSONB),
    ('z_runs', 'cloud_data_confirmation', postgresql.JSONB),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, column, kind in COLUMNS:
        if not inspector.has_table(table):
            continue
        if column not in {c['name'] for c in inspector.get_columns(table)}:
            op.add_column(table, sa.Column(column, kind(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, column, _ in reversed(COLUMNS):
        if inspector.has_table(table) and column in {c['name'] for c in inspector.get_columns(table)}:
            op.drop_column(table, column)
