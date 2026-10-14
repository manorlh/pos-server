"""till parameters: "לשונית 'הכל' בקטלוג ההזמנה" (`sellAllTab`) hidden by default

The owner, 14.10.2026: the order catalog's "הכל" tab is hidden by default for every customer;
whoever wants it sets the till parameter back to first or last at a level. New databases get the
default from the built-in definition (app/services/till_parameters.py); an existing one keeps its
saved definition (`ensure_builtin_parameters` never rewrites one), so the default moves here —
only while it is still the old built-in one ("first"), so a default a super admin chose is kept —
and the description is replaced only while it is still the old built-in text word for word (a
super admin's own wording stays). Values a level set (company, shop, point of sale, till) are not
touched: a level that set first or last keeps it.

Data only, no schema. Downgrade puts back the default and the description where this moved them.

Revision ID: 5d1f8b3e7a92
Revises: ba584f6fb704
Create Date: 2026-10-14 10:00:00.000000
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "5d1f8b3e7a92"
down_revision = "ba584f6fb704"
branch_labels = None
depends_on = None

KEY = "sellAllTab"
OLD_DEFAULT = "first"
NEW_DEFAULT = "hidden"

OLD_DESCRIPTION = (
    "איפה מופיעה לשונית \"הכל\" (כל הפריטים) בסרגל המחלקות של ההזמנה בקופה — בטלפון, בטאבלט, "
    "בהזמנת שולחן ובתבניות המעוצבות (\"עיצוב קופה\"). "
    "«ראשונה — כמו היום» (ברירת מחדל) — \"הכל\" לפני כל המחלקות. "
    "«אחרונה» — \"הכל\" אחרי המחלקה האחרונה. "
    "«מוסתרת — נפתחת המחלקה הראשונה» — אין לשונית \"הכל\", וההזמנה נפתחת על המחלקה "
    "הראשונה; החיפוש עדיין מחפש בכל המוצרים. "
    "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
)
NEW_DESCRIPTION = (
    "איפה מופיעה לשונית \"הכל\" (כל הפריטים) בסרגל המחלקות של ההזמנה בקופה — בטלפון, בטאבלט, "
    "בהזמנת שולחן ובתבניות המעוצבות (\"עיצוב קופה\"). "
    "«מוסתרת — נפתחת המחלקה הראשונה (ברירת מחדל)» — אין לשונית \"הכל\", וההזמנה נפתחת על המחלקה "
    "הראשונה; החיפוש עדיין מחפש בכל המוצרים. "
    "«ראשונה» — \"הכל\" לפני כל המחלקות. "
    "«אחרונה» — \"הכל\" אחרי המחלקה האחרונה. "
    "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
)


def _row(conn):
    row = conn.execute(
        sa.text("SELECT id, default_value, description FROM till_parameters WHERE key = :key"), {"key": KEY}
    ).first()
    if row is None:
        return None, None, None
    default = row[1]
    if isinstance(default, str):
        try:
            default = json.loads(default)
        except ValueError:
            pass
    return row[0], default, row[2]


def _move(conn, *, default_from, default_to, description_from, description_to) -> None:
    ident, default, description = _row(conn)
    if ident is None:  # not created yet: the built-in definition brings the new default
        return
    if default == default_from:
        conn.execute(
            sa.text(
                "UPDATE till_parameters SET default_value = CAST(:value AS JSONB), updated_at = now() WHERE id = :id"
            ),
            {"value": json.dumps(default_to, ensure_ascii=False), "id": ident},
        )
    if description == description_from:
        conn.execute(
            sa.text("UPDATE till_parameters SET description = :description WHERE id = :id"),
            {"description": description_to, "id": ident},
        )


def upgrade() -> None:
    _move(
        op.get_bind(),
        default_from=OLD_DEFAULT, default_to=NEW_DEFAULT,
        description_from=OLD_DESCRIPTION, description_to=NEW_DESCRIPTION,
    )


def downgrade() -> None:
    _move(
        op.get_bind(),
        default_from=NEW_DEFAULT, default_to=OLD_DEFAULT,
        description_from=NEW_DESCRIPTION, description_to=OLD_DESCRIPTION,
    )
