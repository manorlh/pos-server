"""till parameters: "בתחילת הזמנה (לשבת/לקחת ואז שם)" on "הזמנה מהירה — מתי לשאול"

`orderDetailsAt` gets a third option, and it becomes the default: a new quick order starts
with its details — "לקחת או לשבת?", then the name — before its first item. New databases get both from the built-in definition
(app/services/till_parameters.py); an existing one keeps its saved definition
(`ensure_builtin_parameters` never rewrites one), so the option is added here — once, and
only where it is missing — and the default moves to it only where it is still the old
built-in default ("במעבר לתשלום"), so a default a super admin chose is kept.

Data only, no schema. Downgrade takes the option back off and restores the old default
(values already set to it stay as they are and read as the default on the till).

Revision ID: e4f6a8b0c2d4
Revises: 5c7e9a1b3d24
Create Date: 2026-10-05 23:45:00.000000
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "e4f6a8b0c2d4"
down_revision = "5c7e9a1b3d24"
branch_labels = None
depends_on = None

KEY = "orderDetailsAt"
OPTION = "בתחילת הזמנה (לשבת/לקחת ואז שם)"
OLD_DEFAULT = "במעבר לתשלום"


def _row(conn):
    row = conn.execute(
        sa.text("SELECT id, enum_options, default_value FROM till_parameters WHERE key = :key"), {"key": KEY}
    ).first()
    if row is None:
        return None, None, None
    options = row[1]
    if isinstance(options, str):
        options = json.loads(options)
    default = row[2]
    if isinstance(default, str):
        try:
            default = json.loads(default)
        except ValueError:
            pass
    return row[0], list(options or []), default


def upgrade() -> None:
    conn = op.get_bind()
    ident, options, default = _row(conn)
    if ident is None:
        return
    if OPTION not in options:
        conn.execute(
            sa.text("UPDATE till_parameters SET enum_options = CAST(:options AS JSONB) WHERE id = :id"),
            {"options": json.dumps([OPTION] + options, ensure_ascii=False), "id": ident},
        )
    if default == OLD_DEFAULT:
        conn.execute(
            sa.text("UPDATE till_parameters SET default_value = CAST(:value AS JSONB) WHERE id = :id"),
            {"value": json.dumps(OPTION, ensure_ascii=False), "id": ident},
        )


def downgrade() -> None:
    conn = op.get_bind()
    ident, options, default = _row(conn)
    if ident is None:
        return
    if default == OPTION:
        conn.execute(
            sa.text("UPDATE till_parameters SET default_value = CAST(:value AS JSONB) WHERE id = :id"),
            {"value": json.dumps(OLD_DEFAULT, ensure_ascii=False), "id": ident},
        )
    if OPTION in options:
        conn.execute(
            sa.text("UPDATE till_parameters SET enum_options = CAST(:options AS JSONB) WHERE id = :id"),
            {"options": json.dumps([o for o in options if o != OPTION], ensure_ascii=False), "id": ident},
        )
