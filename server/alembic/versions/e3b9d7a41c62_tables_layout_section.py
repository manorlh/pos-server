"""dashboard section `tables_layout` ("עריכת מפה ושולחנות"): whoever edited the map keeps it

P:/specs/live-tables-cloud.md §2 "הרשאות" (the owner, 14.10.2026: "אפשר לתת למנהל לערוך מפה ואפשר גם לא —
דינמי"): editing the floor — zones, tables, the map's sketch, table types — leaves the section `tables`
for a section of its own, so a manager may run the open tables without editing the map.

Nobody loses what they had: every user's profile and every saved template that grants `tables` at edit
gets `tables_layout` at edit too. A profile that already names `tables_layout` is left as it is (run
twice: the same). Full access ("גישה מלאה", no sections) needs nothing. The built-in templates are in
code (app/services/dashboard_sections.py): the branch / area manager's has `tables`, not the map.

Data only. The downgrade leaves the key: an older build drops sections it does not know.

Revision ID: e3b9d7a41c62
Revises: b637e9784d58
Create Date: 2026-10-14

"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e3b9d7a41c62'
down_revision: Union[str, Sequence[str], None] = 'b637e9784d58'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: The tables that hold a grant of sections, and their keys.
_GRANTS = (("dashboard_access_profiles", "user_id"), ("dashboard_access_templates", "id"))
_JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def with_layout(sections):
    """The grant with the map's editing, for one that edits the tables and does not name it; else None."""
    if isinstance(sections, str):
        try:
            sections = json.loads(sections)
        except ValueError:
            return None
    if not isinstance(sections, dict) or sections.get("tables") != "edit" or "tables_layout" in sections:
        return None
    return {**sections, "tables_layout": "edit"}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for name, key in _GRANTS:
        if not inspector.has_table(name):
            continue
        grants = sa.table(name, sa.column(key), sa.column("sections", _JSON))
        for ident, sections in bind.execute(sa.select(grants.c[key], grants.c.sections)).all():
            updated = with_layout(sections)
            if updated is not None:
                bind.execute(sa.update(grants).where(grants.c[key] == ident).values(sections=updated))


def downgrade() -> None:
    # The extra key is harmless: an older build keeps only the sections it knows.
    pass
