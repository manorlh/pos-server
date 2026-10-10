"""The till's unsynced offline Zs, as its heartbeat says

Revision ID: e7b9d1f3a5c8
Revises: d0c5e7a9f3b1
Create Date: 2026-10-06

docs/SPEC_OFFLINE_TILL_Z.md §4.4 ("אין דבר כזה זד שממוספר מחדש"): a Z number, once
produced and printed, is final — so the cloud must never make, number or switch a till's
Z while that till may hold Zs it closed with no connection.

* `pos_machines.offline_till_z_pending` — how many such Zs the till holds not uploaded yet
  (NULL: never said).
* `pos_machines.offline_till_z_conflict` — one is held in a conflict for support.
* `pos_machines.offline_till_z_reported_at` — when it last said.

Idempotent: each column is added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e7b9d1f3a5c8'
down_revision: Union[str, Sequence[str], None] = 'd0c5e7a9f3b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ('offline_till_z_pending', sa.Integer(), {}),
    ('offline_till_z_conflict', sa.Boolean(), dict(nullable=False, server_default=sa.text('false'))),
    ('offline_till_z_reported_at', sa.DateTime(timezone=True), {}),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table('pos_machines'):
        return
    have = {c['name'] for c in inspector.get_columns('pos_machines')}
    for name, kind, extra in COLUMNS:
        if name not in have:
            op.add_column('pos_machines', sa.Column(name, kind, **({'nullable': True} | extra)))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table('pos_machines'):
        return
    have = {c['name'] for c in inspector.get_columns('pos_machines')}
    for name, _kind, _extra in COLUMNS:
        if name in have:
            op.drop_column('pos_machines', name)
