"""the drawer: "בתשלום מזומן — לשאול", and opening it on another till (job kind `drawer`)

P:/specs/bill-print-other-till.md §9 (the owner, 14.10.2026: "בהגדרות הדפסה אפשר לשאול האם לפתוח מגירה,
דינמי. גם למדפסת מובנית שנשלח אליה בקשה להדפסה, או פתיחת מגירה מהמסופון שוב בהרשאת מנהל"):

* `kitchen_print_jobs.kind` takes `drawer`: "פתיחת מגירה ב<קופה>" goes the relay's way, like a
  `document` (app/services/remote_print.py).
* `cashDrawer` gets the option "בתשלום מזומן — לשאול" (§9א). New databases get it from the built-in
  definition (app/services/till_parameters.py); an existing one keeps its saved definition
  (`ensure_builtin_parameters` never rewrites one), so it is added here — once, after "בתשלום מזומן".
  The default is not touched.

Idempotent. Downgrade takes the option off (a value set to it reads as "בתשלום מזומן" on the till) and
the kind's word back (relayed drawer jobs live seconds: gone).

Revision ID: e7b2d9f4a6c3
Revises: c4d8e2f6a1b9
Create Date: 2026-10-14
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e7b2d9f4a6c3'
down_revision: Union[str, Sequence[str], None] = 'c4d8e2f6a1b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

KINDS = "kind IN ('ticket', 'test', 'document', 'drawer')"
OLD_KINDS = "kind IN ('ticket', 'test', 'document')"
KEY = "cashDrawer"
OPTION = "בתשלום מזומן — לשאול"
AFTER = "בתשלום מזומן"


def _options(conn):
    row = conn.execute(sa.text("SELECT id, enum_options FROM till_parameters WHERE key = :key"), {"key": KEY}).first()
    if row is None:
        return None, None
    options = row[1]
    if isinstance(options, str):
        options = json.loads(options)
    return row[0], list(options or [])


def with_option(options):
    """The list with "לשאול" once, right after "בתשלום מזומן" (else last)."""
    if OPTION in options:
        return list(options)
    out = list(options)
    out.insert(out.index(AFTER) + 1 if AFTER in out else len(out), OPTION)
    return out


def _write(conn, ident, options) -> None:
    conn.execute(
        sa.text("UPDATE till_parameters SET enum_options = CAST(:options AS JSONB), updated_at = now() WHERE id = :id"),
        {"options": json.dumps(options, ensure_ascii=False), "id": ident},
    )


def upgrade() -> None:
    op.execute("ALTER TABLE kitchen_print_jobs DROP CONSTRAINT IF EXISTS ck_kitchen_print_jobs_kind")
    op.create_check_constraint('ck_kitchen_print_jobs_kind', 'kitchen_print_jobs', KINDS)
    conn = op.get_bind()
    ident, options = _options(conn)
    if ident is not None and OPTION not in options:
        _write(conn, ident, with_option(options))


def downgrade() -> None:
    conn = op.get_bind()
    ident, options = _options(conn)
    if ident is not None and OPTION in options:
        _write(conn, ident, [o for o in options if o != OPTION])
    op.execute("DELETE FROM kitchen_print_jobs WHERE kind = 'drawer'")
    op.execute("ALTER TABLE kitchen_print_jobs DROP CONSTRAINT IF EXISTS ck_kitchen_print_jobs_kind")
    op.create_check_constraint('ck_kitchen_print_jobs_kind', 'kitchen_print_jobs', OLD_KINDS)
