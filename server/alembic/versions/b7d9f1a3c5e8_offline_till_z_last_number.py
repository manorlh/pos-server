"""The last till Z number the till reported on its heartbeat

Revision ID: b7d9f1a3c5e8
Revises: a6c8e0b2d4f7
Create Date: 2026-10-06

docs/SPEC_OFFLINE_TILL_Z.md §4.6: support's Z of a dead till is numbered after the highest
of the cloud's run and the last number the device itself reported — the numbers between
were printed on the device with no connection and are never reused.

* `pos_machines.offline_till_z_last_number` — `offlineTillZ.lastNumber` as last said.

Idempotent: added only when missing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b7d9f1a3c5e8'
down_revision: Union[str, Sequence[str], None] = 'a6c8e0b2d4f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table('pos_machines'):
        return
    if 'offline_till_z_last_number' not in {c['name'] for c in inspector.get_columns('pos_machines')}:
        op.add_column('pos_machines', sa.Column('offline_till_z_last_number', sa.Integer(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table('pos_machines') and 'offline_till_z_last_number' in {
        c['name'] for c in inspector.get_columns('pos_machines')
    }:
        op.drop_column('pos_machines', 'offline_till_z_last_number')
