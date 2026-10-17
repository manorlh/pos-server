"""merge area management and device terminal type

Two heads on b87054615214 (the 17.10b merge revision), each mergeable alone:

- a3d7e1c9b5f2 — area management (P:/specs/chain-areas.md): `shop_product_overrides.area_ids`, `pos_users.area_ids`,
  `area_product_overrides.price`, `price_policies`, `price_changes`, `price_schedules`, `kiosk_settings.area_id` and
  its level check (add-only but for the widened check)
- c7d2f9a4e1b8 — device terminal type: pairing code terminal options (add-only)

They touch different tables. Nothing of its own.

Revision ID: d5e8b2c4a7f1
Revises: a3d7e1c9b5f2, c7d2f9a4e1b8
Create Date: 2026-10-17 23:30:00

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "d5e8b2c4a7f1"
down_revision: Union[str, Sequence[str], None] = ("a3d7e1c9b5f2", "c7d2f9a4e1b8")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
