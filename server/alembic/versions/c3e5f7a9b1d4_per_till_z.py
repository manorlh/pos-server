"""per-till Z — superseded

Was "Z לכל קופה" on a shop or point of sale (`z_reports.machine_sequence_number`,
`pos_machines.next_z_number`, `z_runs.z_scope`). Replaced, before it reached any
production database, by "Z on the till" (`zMode = till`, a2b3c4d5e6f7_till_z): the
revision stays in the chain and does nothing.

Revision ID: c3e5f7a9b1d4
Revises: b2d4f6a8c0e1
Create Date: 2026-10-04
"""
from typing import Sequence, Union

revision: str = 'c3e5f7a9b1d4'
down_revision: Union[str, Sequence[str], None] = 'b2d4f6a8c0e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
