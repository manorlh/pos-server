"""till parameters: "קטן מאוד" on "גודל ריבוע מוצר"

`productTileSize` gets a smallest option, "קטן מאוד" (five tiles across a handheld). New
databases get it from the built-in definition (app/services/till_parameters.py, which also
adds the parameter's table, tablet and tablet-table siblings); an existing one keeps its
saved definition (`ensure_builtin_parameters` never rewrites one), so the option is added
here — once, first in the list, and only where it is missing.

Data only, no schema. Downgrade takes the option back off (values already set to it read as
"בינוני" on the till).

Revision ID: a7c9e1b3d5f6
Revises: 5f1c3a7e9d20
Create Date: 2026-10-06 00:40:00.000000
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "a7c9e1b3d5f6"
down_revision = "5f1c3a7e9d20"
branch_labels = None
depends_on = None

KEY = "productTileSize"
OPTION = "קטן מאוד"


def _options(conn):
    row = conn.execute(sa.text("SELECT id, enum_options FROM till_parameters WHERE key = :key"), {"key": KEY}).first()
    if row is None:
        return None, None
    options = row[1]
    if isinstance(options, str):
        options = json.loads(options)
    return row[0], list(options or [])


def upgrade() -> None:
    conn = op.get_bind()
    ident, options = _options(conn)
    if ident is None or OPTION in options:
        return
    conn.execute(
        sa.text("UPDATE till_parameters SET enum_options = CAST(:options AS JSONB) WHERE id = :id"),
        {"options": json.dumps([OPTION] + options, ensure_ascii=False), "id": ident},
    )


def downgrade() -> None:
    conn = op.get_bind()
    ident, options = _options(conn)
    if ident is None or OPTION not in options:
        return
    conn.execute(
        sa.text("UPDATE till_parameters SET enum_options = CAST(:options AS JSONB) WHERE id = :id"),
        {"options": json.dumps([o for o in options if o != OPTION], ensure_ascii=False), "id": ident},
    )
