"""add pos_machines.token_version (machine tokens stop expiring)

Machine tokens used to carry a 365-day expiry. That was never a security control —
a terminal is not a person, it does not sign in each morning, and the only thing an
expiry guaranteed was an outage: a till whose token lapsed at 6am on a Sunday is a
till that cannot trade, with nobody on site to re-pair it. Meanwhile the expiry did
nothing an attacker cares about, because a stolen token is used the same day.

Tokens are now minted without an `exp` claim. That is safe only because revocation
was already checked on every single request — both machine-token dependencies load
the row and refuse an inactive machine — and this column closes the one hole left in
that: without it, a terminal soft-deleted and later re-paired would become active
again and start accepting the tokens it held before. The version makes revocation
permanent.

Nullable-free but defaulted, and no backfill needed: every existing machine becomes
version 1, and tokens already in the field carry no `tv` claim at all, which the
middleware reads as 1. So every terminal paired today keeps working, unchanged,
until somebody actually unpairs it.

Revision ID: r4s5t6u7v8w9
Revises: q3r4s5t6u7v8
Create Date: 2026-09-01 14:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "r4s5t6u7v8w9"
down_revision = "q3r4s5t6u7v8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "token_version" not in {c["name"] for c in inspector.get_columns("pos_machines")}:
        op.add_column(
            "pos_machines",
            sa.Column(
                "token_version",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("1"),
            ),
        )


def downgrade() -> None:
    # Rolling back also restores expiring tokens, so any terminal unpaired while this
    # was live keeps working again on its old token until the row is deactivated.
    # Deactivating the machine remains the way to lock one out on the old code.
    op.drop_column("pos_machines", "token_version")
