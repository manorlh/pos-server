"""record who approved a document, and make a per-action grant single-use

Three nullable columns. Nothing is backfilled and nothing is required, because in
every case null is a true statement about the row rather than a gap in it.

`elevated_sessions.per_action_consumed_at` — when this grant's one per-action use was
spent. Until now `PER_ACTION_SCOPES` was declared and never enforced anywhere on the
server: a grant for `refund` stayed good for the whole idle window, and "one PIN, one
refund" existed only in the Android client's in-memory bookkeeping. Any older or
modified APK simply did not honour it. This column is what makes the rule true on the
server. Null on every existing row, which reads correctly as "not yet spent" — those
grants are minutes from expiring in any case.

`transactions.approved_by_user_id` — the cloud `users` row that authorised a refund or
a discount, verified server-side before it is written (see `app.services.approvals`).
Null is the overwhelmingly common case and is not missing data: most documents need no
approval at all, and a till operated by a manager or supervisor who already holds the
authority produces no second name. `cashier_id` already says who rang it up; this says
who allowed it.

`z_reports.approved_by_user_id` — the same, for the close of the day, taken from a live
elevation grant presented with the Z. Null here means the till's own operator closed
their own day, which is the ordinary close and must keep working: the operator is a
`pos_users` row (admin / manager / cashier), a different enum from the cloud roles
elevation grants come from, so the server can never demand a token unconditionally
without locking a manager-operated till out of closing.

No index on either `approved_by_user_id`. The lookup that exists today runs document →
approver, which the column serves directly; the reverse feed ("everything Yossi
approved") has no caller yet, and building an index across a live `transactions` table
for a query nobody makes is a lock bought for nothing. Add it when something asks.

Revision ID: z2a3b4c5d6e7
Revises: y1z2a3b4c5d6
Create Date: 2026-09-14 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "z2a3b4c5d6e7"
down_revision = "y1z2a3b4c5d6"
branch_labels = None
depends_on = None


#: (table, column, foreign-key constraint name or None)
_ADDITIONS = (
    ("elevated_sessions", "per_action_consumed_at", None),
    (
        "transactions",
        "approved_by_user_id",
        "fk_transactions_approved_by_user_id_users",
    ),
    ("z_reports", "approved_by_user_id", "fk_z_reports_approved_by_user_id_users"),
)


def _column(name: str) -> sa.Column:
    if name == "per_action_consumed_at":
        return sa.Column("per_action_consumed_at", sa.DateTime(timezone=True), nullable=True)
    return sa.Column(name, UUID(as_uuid=True), nullable=True)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    for table, column, fk_name in _ADDITIONS:
        if column in {c["name"] for c in inspector.get_columns(table)}:
            continue
        op.add_column(table, _column(column))
        if fk_name:
            op.create_foreign_key(fk_name, table, "users", [column], ["id"])


def downgrade() -> None:
    # Dropping `per_action_consumed_at` un-spends every live grant, which is the
    # correct reading of a rollback: the rule it enforced no longer exists.
    for table, column, fk_name in reversed(_ADDITIONS):
        if fk_name:
            op.drop_constraint(fk_name, table, type_="foreignkey")
        op.drop_column(table, column)
