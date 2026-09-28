"""z_run_items.claimed_shift_id and shift_close_requests.claimed_shift_id

A remote close (a Z run's item, or a standalone close request) can name a shift the
cloud has not seen yet: the till reports its open shift on every heartbeat, and the
open event itself may still be queued offline. That id was written into
`z_run_items.close_shift_id` / `shift_close_requests.shift_id`, both foreign keys to
`shifts` — so on Postgres the run or request failed with a foreign-key violation (500)
exactly when it was needed.

The claim now lives in a column without a foreign key; the keyed column is filled in
once the shift exists. Nothing to backfill: a row could never have been written with a
shift that did not exist.

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-09-28 20:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f5a6b7c8d9e0"
down_revision = "e4f5a6b7c8d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("z_run_items", sa.Column("claimed_shift_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column(
        "shift_close_requests", sa.Column("claimed_shift_id", postgresql.UUID(as_uuid=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("shift_close_requests", "claimed_shift_id")
    op.drop_column("z_run_items", "claimed_shift_id")
