"""tables: the LAN mode's option on the existing "ניהול שולחנות" parameter

docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §2.8ב — `tablesMode` gets a fourth option,
"רשת מקומית (קופה ראשית)": the tables of a shop held by one till on the LAN. New
databases get it from the built-in definition (app/services/till_parameters.py); an
existing one keeps its saved definition (`ensure_builtin_parameters` never rewrites
one), so the option is added here — once, and only where it is missing. The new
`tablesHostTill` parameter is created by `ensure_builtin_parameters` as usual.

Data only, no schema. Downgrade takes the option back off (values already set to it
stay as they are and read as "off").

Revision ID: d3e5f7a9b1c2
Revises: a8e4c2f7d9b1
Create Date: 2026-10-04 04:05:00.000000
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "d3e5f7a9b1c2"
down_revision = "a8e4c2f7d9b1"
branch_labels = None
depends_on = None

KEY = "tablesMode"
OPTION = "רשת מקומית (קופה ראשית)"


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
    options.append(OPTION)
    conn.execute(
        sa.text("UPDATE till_parameters SET enum_options = CAST(:options AS JSONB) WHERE id = :id"),
        {"options": json.dumps(options, ensure_ascii=False), "id": ident},
    )


def downgrade() -> None:
    conn = op.get_bind()
    ident, options = _options(conn)
    if ident is None or OPTION not in options:
        return
    options = [o for o in options if o != OPTION]
    conn.execute(
        sa.text("UPDATE till_parameters SET enum_options = CAST(:options AS JSONB) WHERE id = :id"),
        {"options": json.dumps(options, ensure_ascii=False), "id": ident},
    )
