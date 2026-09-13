"""add the shift supervisor role

אחמ"ש — a senior cashier who may authorise what a cashier may not: a refund, a discount,
closing the trading day. Deliberately carries no dashboard write access at all; the whole
role exists at the register, through the elevation flow.

`userrole` is a native Postgres enum, so the value has to be added to the type itself.
`ALTER TYPE … ADD VALUE` cannot be used in the same transaction that later references the
new label, so it runs in an autocommit block. `IF NOT EXISTS` makes a re-run harmless.

Nothing is back-filled: no existing user becomes a supervisor. The role is assigned
deliberately, by a manager staffing their own shop.

Revision ID: y1z2a3b4c5d6
Revises: x0y1z2a3b4c5
Create Date: 2026-09-13 21:00:00.000000
"""

from __future__ import annotations

from alembic import op


revision = "y1z2a3b4c5d6"
down_revision = "x0y1z2a3b4c5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'shift_supervisor'")


def downgrade() -> None:
    # Postgres cannot remove a value from an enum type. Reversing this means rebuilding
    # the type and rewriting every column that uses it, which is not something a
    # downgrade should do unattended while users may be holding the role. Any user who
    # is a shift supervisor must be reassigned first, by hand.
    pass
