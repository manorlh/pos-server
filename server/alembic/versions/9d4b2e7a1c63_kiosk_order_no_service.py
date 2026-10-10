"""kiosk orders: no service type ("ללא סוג שירות")

The kiosk's `general.serviceMode = "none"`: the customer is not asked and the order carries no
service at all, so `kiosk_orders.service_type` (paid kiosk orders and the orders a customer pays
at the till alike) may be null. Every row so far keeps its take_away / eat_in.

Idempotent: making a nullable column nullable again changes nothing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '9d4b2e7a1c63'
down_revision: Union[str, Sequence[str], None] = 'c7e2f4a9d1b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column('kiosk_orders', 'service_type', existing_type=sa.String(length=16), nullable=True)


def downgrade() -> None:
    # Never run against live data (an order with no service has no word to put back): fill
    # the nulls with take_away first, as every reader before this one read a missing value.
    op.execute("UPDATE kiosk_orders SET service_type = 'take_away' WHERE service_type IS NULL")
    op.alter_column('kiosk_orders', 'service_type', existing_type=sa.String(length=16), nullable=False)
