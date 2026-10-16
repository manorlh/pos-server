"""merge 17.10 release heads

Release 17.10 (release/2026-10-17-server) has four heads. Each branch revises main's head e5a9c3d1f7b2 (cash
stage 2) on its own, so each can also be merged alone:

- d9e4b2a7c1f8 — denied-actions UI: `till_roles.denied_ui` (add-only)
- b8f2c6e4a9d1 — PWA push: `push_subscriptions.device_key` and its index (add-only)
- f3a8c6e1d9b4 — the cash host kiosk: `pos_machines.cash_host_embedded` and `cash_relay_requests` (add-only)
- f3b8d2c6a9e1 — CashMag credits: `cash_station_txs` / `cash_credit_redemptions.station_id` nullable,
  `cash_station_txs.device`

None of them touches another's tables or rows. Nothing of its own.

Revision ID: 6b3b29c7bc5b
Revises: d9e4b2a7c1f8, b8f2c6e4a9d1, f3a8c6e1d9b4, f3b8d2c6a9e1
Create Date: 2026-10-16 04:29:24.109962

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6b3b29c7bc5b'
down_revision: Union[str, Sequence[str], None] = ('d9e4b2a7c1f8', 'b8f2c6e4a9d1', 'f3a8c6e1d9b4', 'f3b8d2c6a9e1')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
