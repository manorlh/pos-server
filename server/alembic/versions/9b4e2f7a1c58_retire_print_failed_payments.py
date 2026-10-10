"""till parameters: retire "הדפסת עסקאות שלא הושלמו בדוחות" (`printFailedPayments`)

The owner, 09.10.2026: "בקופה בהדפסת משמרת אל תדפיס את עסקאות שלא הושלמו, אפשר להדפיס בנפרד".
The shift / Z paper now leaves "עסקאות שלא הושלמו" off unless the new built-in "הדפסת עסקאות
שלא הושלמו בדוח משמרת / Z" (`printFailedPaymentsWithReports`, off by default — created by
`ensure_builtin_parameters` at startup, as every built-in) puts it there; the till's screens
print it apart with their own button (docs/SPEC_FAILED_PAYMENTS.md §3.2).

The old switch (on by default) has nothing left to switch, so it stops being a built-in. An
existing definition is deactivated, not deleted: an inactive parameter is never sent to a till
and its values are kept (app/models/till_parameter.py), so nothing a super admin set is lost,
and the dashboard shows it as inactive. Its `updated_at` moves, so the tills' parameters
watermark does too and they drop the key at their next pull.

Data only, no schema; one statement, so it renders in offline (`--sql`) mode too. Downgrade
re-activates it.

Revision ID: 9b4e2f7a1c58
Revises: 5a7c9e1b3d2f
Create Date: 2026-10-09 20:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "9b4e2f7a1c58"
down_revision = "5a7c9e1b3d2f"
branch_labels = None
depends_on = None

KEY = "printFailedPayments"


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE till_parameters SET is_active = false, updated_at = now() "
            "WHERE key = :key AND is_active"
        ).bindparams(key=KEY)
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE till_parameters SET is_active = true, updated_at = now() "
            "WHERE key = :key AND NOT is_active"
        ).bindparams(key=KEY)
    )
