"""till parameters: retire "מזומן עם חישוב עודף בפאנל ההזמנה (טאבלט)" (`cashChangeInPanel`)

The tablet quick order lost its in-panel cash box ("התקבל מזומן", its round amounts and
"מדויק"): cash with change is now the payment screen's own cash step, reached from one of the
two quick-pay buttons the new built-ins "כפתור תשלום מהיר 1 / 2" choose (`quickPayButton1`,
`quickPayButton2` — created by `ensure_builtin_parameters` at startup, as every built-in).

The switch for the box has nothing left to switch, so it stops being a built-in. An existing
definition is deactivated, not deleted: an inactive parameter is never sent to a till and its
values are kept (app/models/till_parameter.py), so nothing a super admin set is lost, and the
dashboard shows it as inactive. Its `updated_at` moves, so the tills' parameters watermark
does too and they drop the key at their next pull.

Data only, no schema. Downgrade re-activates it.

Revision ID: 3f8b6d2a9c41
Revises: 7d2b9e4a1c63
Create Date: 2026-10-06 18:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "3f8b6d2a9c41"
down_revision = "7d2b9e4a1c63"
branch_labels = None
depends_on = None

KEY = "cashChangeInPanel"


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE till_parameters SET is_active = false, updated_at = now() "
            "WHERE key = :key AND is_active"
        ),
        {"key": KEY},
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE till_parameters SET is_active = true, updated_at = now() "
            "WHERE key = :key AND NOT is_active"
        ),
        {"key": KEY},
    )
