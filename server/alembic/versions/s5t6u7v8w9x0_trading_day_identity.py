"""trading day: identity by id, one open day per machine, sequence number

Fixes a data-loss path. `trading_days` was keyed `UNIQUE (machine_id, day_date)`, and
`get_or_create_trading_day` fell back to that pair with no status filter — so a second
shift on the same calendar date resolved to the morning's day, which was already closed
and already had a Z. Its sales attached there, its own Z came back `duplicate` with HTTP
200, the till read that as success, and purged the shift's documents. Two Z reports on
one date is ordinary retail (shift changeover), not an edge case.

Three changes:

* drop `uq_trading_day_machine_date` — a calendar date is not an identity;
* add `uq_trading_day_one_open`, a *partial* unique index on `machine_id` where the day
  is open. That is the invariant that actually matters and that nothing enforced: a till
  may have many days on one date, but only ever one open at a time;
* add `sequence_number`, a per-machine counter assigned by the till, so "day 7 is
  missing" is answerable. Nullable — days that predate this have none, and backfilling a
  guess would invent fiscal ordering that never existed.

The partial index is created **last and without a data fix-up on purpose**. If a machine
somehow holds two open days, this migration fails loudly rather than silently closing one
— a close with no Z behind it is a fabricated fiscal document, and that is not a decision
a migration gets to make. The operator closes the stale day properly, then re-runs.
(Checked before writing this: no machine in the target database has more than one open
day, and there are no duplicate `(machine, date)` pairs.)

Revision ID: s5t6u7v8w9x0
Revises: r4s5t6u7v8w9
Create Date: 2026-09-06 01:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "s5t6u7v8w9x0"
down_revision = "r4s5t6u7v8w9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    columns = {c["name"] for c in inspector.get_columns("trading_days")}
    if "sequence_number" not in columns:
        op.add_column(
            "trading_days", sa.Column("sequence_number", sa.Integer(), nullable=True)
        )

    constraints = {c["name"] for c in inspector.get_unique_constraints("trading_days")}
    if "uq_trading_day_machine_date" in constraints:
        op.drop_constraint(
            "uq_trading_day_machine_date", "trading_days", type_="unique"
        )

    clashes = bind.execute(
        sa.text(
            "SELECT machine_id, count(*) FROM trading_days WHERE status = 'open' "
            "GROUP BY machine_id HAVING count(*) > 1"
        )
    ).fetchall()
    if clashes:
        raise RuntimeError(
            "Cannot enforce one open trading day per machine: "
            f"{len(clashes)} machine(s) currently hold more than one open day "
            f"({[str(row[0]) for row in clashes]}). Close the stale days through the "
            "normal Z path first — this migration will not fabricate a close."
        )

    indexes = {i["name"] for i in inspector.get_indexes("trading_days")}
    if "uq_trading_day_one_open" not in indexes:
        op.create_index(
            "uq_trading_day_one_open",
            "trading_days",
            ["machine_id"],
            unique=True,
            postgresql_where=sa.text("status = 'open'"),
        )


def downgrade() -> None:
    op.drop_index("uq_trading_day_one_open", table_name="trading_days")
    # Restoring the old unique constraint can fail where the new model was used as
    # intended — two shifts on one date is exactly what it forbade. Left to the
    # operator rather than silently dropping rows to make it fit.
    op.create_unique_constraint(
        "uq_trading_day_machine_date", "trading_days", ["machine_id", "day_date"]
    )
    op.drop_column("trading_days", "sequence_number")
