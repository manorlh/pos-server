"""Support produces a dead till's Z from the cloud; the till's document counters

Revision ID: a6c8e0b2d4f7
Revises: d6b2f8a4e1c7
Create Date: 2026-10-06

docs/SPEC_OFFLINE_TILL_Z.md §4.6 — the owner: "אין הקלדה ידנית, וברוב המוחלט הקופה עבדה
עם אינטרנט — תאפשר לייצר Z מהענן ע״י התמיכה כדי שיושלמו הנתונים".

* `pos_machines.support_z` / `support_z_at` — support produced this till's Z from the cloud
  (who, when, why, the basis, the Z, the numbers skipped); the till, if it ever comes back,
  is told and produces nothing for that period.
* `pos_machines.reported_document_counters` / `document_counters_reported_at` — the till's
  per-series document counters (320 / 330 / 400) as its heartbeat last said, so a
  replacement device never reissues a number the old one printed.

Idempotent: each column is added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'a6c8e0b2d4f7'
down_revision: Union[str, Sequence[str], None] = 'd6b2f8a4e1c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ('support_z', postgresql.JSONB()),
    ('support_z_at', sa.DateTime(timezone=True)),
    ('reported_document_counters', postgresql.JSONB()),
    ('document_counters_reported_at', sa.DateTime(timezone=True)),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table('pos_machines'):
        return
    have = {c['name'] for c in inspector.get_columns('pos_machines')}
    for name, kind in COLUMNS:
        if name not in have:
            op.add_column('pos_machines', sa.Column(name, kind, nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table('pos_machines'):
        return
    have = {c['name'] for c in inspector.get_columns('pos_machines')}
    for name, _kind in COLUMNS:
        if name in have:
            op.drop_column('pos_machines', name)
