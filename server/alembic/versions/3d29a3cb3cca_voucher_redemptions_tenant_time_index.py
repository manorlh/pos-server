"""prepaid voucher redemptions: an index on (tenant_id, redeemed_at) for the board's vouchers card

Revision ID: 3d29a3cb3cca
Revises: e5b8d2c6a1f9
Create Date: 2026-10-09

Re-chained at the integration merge (integration/fri, 09.10.2026): written on 6d818753b5ec,
now after feat/insights-actions' e5b8d2c6a1f9, which already follows 6d818753b5ec there, so the
chain stays linear. An index only; the upgrade itself is unchanged.

The control board's "שוברים" card (`GET /reports/prepaid-vouchers`) reads a tenant's
redemptions over a period — a day, or a range up to the reports' 366 days — every time the
board refreshes. Until now the table had single-column indexes only (voucher, batch, till,
tenant), so a period was a scan of the tenant's every redemption.

Idempotent: created only when missing (a dev database may have it from a previous run);
offline (`--sql`) the plain statement.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '3d29a3cb3cca'
down_revision: Union[str, Sequence[str], None] = 'e5b8d2c6a1f9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'prepaid_voucher_redemptions'
INDEX = 'ix_prepaid_voucher_redemptions_tenant_redeemed'


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _has_index() -> bool:
    if _offline():
        return False
    return INDEX in {ix['name'] for ix in sa.inspect(op.get_bind()).get_indexes(TABLE)}


def upgrade() -> None:
    if not _has_index():
        op.create_index(INDEX, TABLE, ['tenant_id', 'redeemed_at'])


def downgrade() -> None:
    if _offline() or _has_index():
        op.drop_index(INDEX, table_name=TABLE)
