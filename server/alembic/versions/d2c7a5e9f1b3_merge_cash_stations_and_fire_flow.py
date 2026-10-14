"""merge cash stations and the fire-flow item schedule

feat/cash-paylink merged with release/2026-10-14b-server again (after 668ec9f0): two heads on the
14.10d merge 4ff6c2ab6d7c —

- c4f1a9d7e2b6 — cash stations (P:/specs/cash-paylink.md): `cash_stations`, `cash_station_txs`,
  `cash_station_movements`, `cash_host_commands`, `pos_machines.is_cash_host` / `cash_status` /
  `cash_status_at`, the push type `cash` in saved preferences (add-only)
- c5e8a2f19d47 — the fire-flow item schedule

They touch different tables. Nothing of its own.

Revision ID: d2c7a5e9f1b3
Revises: c4f1a9d7e2b6, c5e8a2f19d47
Create Date: 2026-10-15 01:30:00.000000

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = 'd2c7a5e9f1b3'
down_revision: Union[str, Sequence[str], None] = ('c4f1a9d7e2b6', 'c5e8a2f19d47')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
