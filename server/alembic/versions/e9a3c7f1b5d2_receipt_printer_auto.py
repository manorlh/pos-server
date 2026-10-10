"""till parameters: "אוטומטי" on "מדפסת חשבוניות", and the default

docs/SPEC_KIOSK.md §14.7 — the owner, 07.10.2026: a USB receipt printer plugged into a till is
detected by itself, as on the kiosk. `receiptPrinter` gets a first option, "אוטומטי": a USB
printer attached to a regular till and approved prints the receipts, else as "מובנית בקופה"
(pos-android domain/UsbPrinterAuto.kt `tillReceiptOnUsb`). It becomes the default, so every till
nobody set a receipt printer for takes its USB printer by itself; a value someone set (at the
company, shop, area or till — "מובנית בקופה" too) keeps winning.

New databases get both from the built-in definition (app/services/till_parameters.py); an
existing one keeps its saved definition (`ensure_builtin_parameters` never rewrites one), so the
option is added here — once, first in the list — and the default moved only while it is still
the old built-in default (a super admin's own choice of default stays).

Data only, no schema. Downgrade puts the default back where this moved it and takes the option
off (values already set to it read as "מובנית בקופה" on the till).

Revision ID: e9a3c7f1b5d2
Revises: c7e2f4a9d1b6
Create Date: 2026-10-07 23:00:00.000000
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "e9a3c7f1b5d2"
down_revision = "c7e2f4a9d1b6"
branch_labels = None
depends_on = None

KEY = "receiptPrinter"
OPTION = "אוטומטי"
OLD_DEFAULT = "מובנית בקופה"


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
