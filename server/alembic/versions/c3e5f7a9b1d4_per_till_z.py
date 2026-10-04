"""per-till Z

"Z סניפי / Z לכל קופה" on a shop or point of sale: a till under "Z לכל קופה" gets a Z of
its own, numbered by its own counter from 1 (`z_reports.machine_sequence_number`,
`pos_machines.next_z_number`); the run records the mode it was started under.

Revision ID: c3e5f7a9b1d4
Revises: b2d4f6a8c0e1
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c3e5f7a9b1d4'
down_revision: Union[str, Sequence[str], None] = 'b2d4f6a8c0e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('z_reports', sa.Column('machine_sequence_number', sa.Integer(), nullable=True))
    op.create_index(
        'uq_z_reports_machine_sequence',
        'z_reports',
        ['machine_id', 'machine_sequence_number'],
        unique=True,
    )
    op.add_column('pos_machines', sa.Column('next_z_number', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('z_runs', sa.Column('z_scope', sa.String(16), nullable=False, server_default='shop'))


def downgrade() -> None:
    op.drop_column('z_runs', 'z_scope')
    op.drop_column('pos_machines', 'next_z_number')
    op.drop_index('uq_z_reports_machine_sequence', table_name='z_reports')
    op.drop_column('z_reports', 'machine_sequence_number')
