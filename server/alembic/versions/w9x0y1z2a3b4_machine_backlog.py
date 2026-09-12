"""store the terminal's reported outbox backlog

The till has always sent `pendingCount` on every heartbeat, and the server has always
thrown it away — accepted and logged, with a comment explaining that it is a live number
which is stale the moment it lands.

That reasoning is right about using it as *truth*, and nothing here changes that: the
close-day gate still counts the real documents. It is wrong about showing it. A status
light needs a last-known reading exactly the way the battery percentage is a last-known
reading, and the dashboard cannot otherwise distinguish a healthy terminal from one
sitting on a day of unsent sales.

* `pending_count` — the whole outbox depth, as reported.
* `pending_documents` — undelivered *sales* only. The outbox also carries trading-day
  rows, Z reports and close-day acknowledgements; a till stuck on one acknowledgement is
  not a till holding unsynced takings, and a light that cannot tell them apart is a light
  the shop learns to ignore.
* `pending_count_at` — when the reading was taken. Stored with the counts rather than
  inferred from `last_heartbeat_at`, so a count reported by an older build that has since
  gone quiet cannot be mistaken for a fresh one.

All nullable, and null is meaningful: it means the terminal has never reported, which is
not zero. A till that predates `pendingDocuments` simply keeps sending the total, and the
resolver falls back to it.

Revision ID: w9x0y1z2a3b4
Revises: v8w9x0y1z2a3
Create Date: 2026-09-09 23:55:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "w9x0y1z2a3b4"
down_revision = "v8w9x0y1z2a3"
branch_labels = None
depends_on = None


_COLUMNS = (
    ("pending_count", sa.Column("pending_count", sa.Integer(), nullable=True)),
    ("pending_documents", sa.Column("pending_documents", sa.Integer(), nullable=True)),
    (
        "pending_count_at",
        sa.Column("pending_count_at", sa.DateTime(timezone=True), nullable=True),
    ),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {c["name"] for c in inspector.get_columns("pos_machines")}
    for name, column in _COLUMNS:
        if name not in existing:
            op.add_column("pos_machines", column)


def downgrade() -> None:
    for name, _column in reversed(_COLUMNS):
        op.drop_column("pos_machines", name)
