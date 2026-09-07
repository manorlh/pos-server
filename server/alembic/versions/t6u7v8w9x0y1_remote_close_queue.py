"""remote close: queue offline tills, mark unattended Z reports

Two columns behind one change in behaviour: a remote close-day instruction now *waits*
for a terminal that is offline instead of failing the moment it is issued.

Before, `create_close_day_request` failed an item outright when the machine had not
heartbeated for ninety seconds. A manager clicking "close every till in the shop" got
`machine_offline` for the two that happened to be mid-reboot, nothing retried them, and
nothing told them later. The instruction is now delivered by *pull* — the till asks on
its next heartbeat, which it already sends on a timer — so being offline is a delay
rather than a failure.

* `close_day_requests.expires_at` — the horizon that makes waiting safe. Without one,
  an instruction issued tonight would still be sitting there for a terminal that
  reappears in March and would close a day whose Z nobody is expecting.
* `z_reports.unattended` — a close performed with nobody at the drawer. The till used
  to substitute the *expected* cash for the counted figure, so every unattended Z
  asserted a variance of exactly zero; a shop with a real shortfall got a document
  claiming it balanced. `actual_cash` is now left NULL and this flag records why.

Both nullable or defaulted, so existing rows keep their meaning: no request has a
deadline, and every Z already filed is treated as attended — which it was, since until
now the only unattended path was the one that faked the count.

Revision ID: t6u7v8w9x0y1
Revises: s5t6u7v8w9x0
Create Date: 2026-09-07 09:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "t6u7v8w9x0y1"
down_revision = "s5t6u7v8w9x0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "expires_at" not in {c["name"] for c in inspector.get_columns("close_day_requests")}:
        op.add_column(
            "close_day_requests",
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        )

    if "unattended" not in {c["name"] for c in inspector.get_columns("z_reports")}:
        op.add_column(
            "z_reports",
            sa.Column(
                "unattended",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )


def downgrade() -> None:
    op.drop_column("z_reports", "unattended")
    op.drop_column("close_day_requests", "expires_at")
