"""Offline till Z, the card transmission at a Z, and the forced remote Z close

Revision ID: d8f2a4c6e0b1
Revises: c3e5a7b9d1f2
Create Date: 2026-10-05

docs/SPEC_OFFLINE_TILL_Z.md:

* `z_reports.built_offline` / `uploaded_at` / `offline_report` / `offline_discrepancies` —
  a till Z closed at the till with no connection to the cloud (`zMode = till`, till
  parameter `tillZOffline`), uploaded later: when it came up, the figures the till
  printed, and where the cloud's own figures differ.
* `z_reports.card_transmission` — the card batch transmission (doPeriodic) the till ran
  before the Z, with the terminal's answer, online or offline.
* `z_runs.force_close` / `till_z_requests.force_close` — a remote Z close asked "even
  mid-sale": the till parks an open basket and closes.

Idempotent: the auto-reloading API may have created a column already — each column is
added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'd8f2a4c6e0b1'
down_revision: Union[str, Sequence[str], None] = 'c3e5a7b9d1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

FLAG = dict(nullable=False, server_default=sa.text('false'))

COLUMNS = {
    'z_reports': (
        ('built_offline', sa.Boolean(), FLAG),
        ('uploaded_at', sa.DateTime(timezone=True), {}),
        ('offline_report', postgresql.JSONB(), {}),
        ('offline_discrepancies', postgresql.JSONB(), {}),
        ('card_transmission', postgresql.JSONB(), {}),
    ),
    'z_runs': (
        ('force_close', sa.Boolean(), FLAG),
    ),
    'till_z_requests': (
        ('force_close', sa.Boolean(), FLAG),
    ),
}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, columns in COLUMNS.items():
        if not inspector.has_table(table):
            continue
        have = {c['name'] for c in inspector.get_columns(table)}
        for name, kind, extra in columns:
            if name not in have:
                op.add_column(table, sa.Column(name, kind, **({'nullable': True} | extra)))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, columns in COLUMNS.items():
        if not inspector.has_table(table):
            continue
        have = {c['name'] for c in inspector.get_columns(table)}
        for name, _kind, _extra in columns:
            if name in have:
                op.drop_column(table, name)
