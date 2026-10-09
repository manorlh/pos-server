"""events: the live screen's sales target ("מצב אירוע חי")

Revision ID: 3bab01c8184e
Revises: 6b1e9d4f2a87
Create Date: 2026-10-09

`report_events.live_target` — the net sales target (₪) typed on the event's live screen, used
when no targets module supplies one (app/services/report_events/targets.py). Not part of the
frozen report.

Idempotent: added only when missing (the auto-reloading API's `create_all` does not add columns,
but a dev database may have it from a previous run); offline (`--sql`) the plain statement.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "3bab01c8184e"
down_revision: Union[str, Sequence[str], None] = "6b1e9d4f2a87"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "report_events"


def _has_column(name: str) -> bool:
    if op.get_context().as_sql:
        return False
    return name in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column("live_target"):
        op.add_column(TABLE, sa.Column("live_target", sa.Numeric(12, 2), nullable=True))


def downgrade() -> None:
    op.drop_column(TABLE, "live_target")
