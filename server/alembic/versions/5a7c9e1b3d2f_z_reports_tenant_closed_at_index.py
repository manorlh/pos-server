"""Index z_reports (tenant_id, closed_at): Zs by the date they were produced

"תאריך הפקת Z" (app/services/z_by_date.py): the dashboard lists a tenant's Zs by the local day or
month they were produced — a range on `closed_at`, newest first — and that is now the Z list's
default. Until now only `tenant_id` was indexed, so every such read sorted all of a tenant's Zs.

Add-only: one index, no column, no data. Idempotent (the index is looked for first), so a database
whose tables the API's `create_all` already made at startup upgrades cleanly.

Revision ID: 5a7c9e1b3d2f, revises b8e2d4f6a1c3.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "5a7c9e1b3d2f"
down_revision: Union[str, Sequence[str], None] = "b8e2d4f6a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX = "ix_z_reports_tenant_closed_at"


def _has_index() -> bool:
    if context.is_offline_mode():
        return False
    return any(ix["name"] == INDEX for ix in sa.inspect(op.get_bind()).get_indexes("z_reports"))


def upgrade() -> None:
    if not _has_index():
        op.create_index(INDEX, "z_reports", ["tenant_id", "closed_at"])


def downgrade() -> None:
    if _has_index():
        op.drop_index(INDEX, table_name="z_reports")
