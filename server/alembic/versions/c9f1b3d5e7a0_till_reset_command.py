"""A reset of a till's data, ordered from the cloud by support

Revision ID: c9f1b3d5e7a0
Revises: b7d9f1a3c5e8
Create Date: 2026-10-06

docs/SPEC_OFFLINE_TILL_Z.md §4.7 — the owner: "איפוס זדים קורה רק מהענן ובאמצעות סופר אדמין
בתמיכה". The till has no reset of its own any more; support orders one from the machine
page and the till carries it out under its guards and reports back.

* `pos_machines.till_reset` — the last command: kind, reason, who, when, its status
  (pending / done / refused / failed / expired) and what the till reported.

Idempotent: added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c9f1b3d5e7a0'
down_revision: Union[str, Sequence[str], None] = 'b7d9f1a3c5e8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table('pos_machines'):
        return
    if 'till_reset' not in {c['name'] for c in inspector.get_columns('pos_machines')}:
        op.add_column('pos_machines', sa.Column('till_reset', postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table('pos_machines') and 'till_reset' in {
        c['name'] for c in inspector.get_columns('pos_machines')
    }:
        op.drop_column('pos_machines', 'till_reset')
