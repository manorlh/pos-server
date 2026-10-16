"""till roles: "כשאין הרשאה" per role (till_roles.denied_ui)

"כשאין הרשאה" (P:/specs/denied-actions-ui.md): what the till does with an option the operator's role
denies — show (today), hide, or ask a manager's code. Set per level by the till parameter
`deniedActionUi` (no column: a built-in till parameter), per role by this column, per employee inside
`pos_users.permission_overrides` (`deniedUi`, no column).

* `till_roles.denied_ui` VARCHAR(8) NULL — show | hide | code; NULL = as the level says.

Add-only and idempotent (the column looked at first: the API's create_all may have made it). No row
changes: every role stays NULL, so every till behaves exactly as before.

Revision ID: d9e4b2a7c1f8
Revises: e5a9c3d1f7b2
Create Date: 2026-10-16 10:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "d9e4b2a7c1f8"
down_revision: Union[str, Sequence[str], None] = "e5a9c3d1f7b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "till_roles"
COLUMN = "denied_ui"


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _state() -> tuple:
    """(the table exists, the column exists) — offline: the table is there, the column is not."""
    if _offline():
        return True, False
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(TABLE):
        return False, False
    return True, COLUMN in {c["name"] for c in inspector.get_columns(TABLE)}


def upgrade() -> None:
    table, column = _state()
    if table and not column:
        op.add_column(TABLE, sa.Column(COLUMN, sa.String(8), nullable=True))


def downgrade() -> None:
    if _offline():
        op.drop_column(TABLE, COLUMN)
        return
    table, column = _state()
    if table and column:
        op.drop_column(TABLE, COLUMN)
