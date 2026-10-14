"""push alert types of the board's lights: on for users who had every type

P:/specs/manager-problems.md §2: three new phone-alert types — `z_shift` ("Z / משמרת"),
`card_transmission` ("שידור אשראי באיחור"), `till_printer` ("מדפסת קופה"). A push rule stores
the types its owner chose as a list, and the pipeline treats a type missing from it as off — so
without this, nobody who already has preferences would receive them.

"Every type" (the spec: "מופעלות כברירת מחדל למשתמשים קיימים שבחרו 'הכל'"): a rule whose list
holds each of the six types the phone alerts started with (09.10.2026). It gets the three new
types appended; a rule that left any of those six out keeps its choice. Data only, idempotent
(a type already on the list is not added twice); the downgrade removes nothing (a user may have
chosen them since).

Revision ID: 3c9e5a7b1d24
Revises: 78c88a7afc4f
Create Date: 2026-10-13

"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "3c9e5a7b1d24"
down_revision: Union[str, Sequence[str], None] = "78c88a7afc4f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORIGINAL = ("till_offline", "card_terminal", "large_void", "drawer_no_sale", "till_low_sales", "target_reached")
NEW = ("z_shift", "card_transmission", "till_printer")


def _list(raw):
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    return raw if isinstance(raw, list) else None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import JSONB as json_type
    else:
        json_type = sa.JSON
    rules = sa.table(
        "exception_alert_rules",
        sa.column("id"),
        sa.column("channel", sa.String),
        sa.column("categories", json_type),
        sa.column("deleted_at", sa.DateTime),
    )
    rows = bind.execute(
        sa.select(rules.c.id, rules.c.categories).where(rules.c.channel == "push", rules.c.deleted_at.is_(None))
    ).fetchall()
    for ident, raw in rows:
        chosen = _list(raw)
        if chosen is None or not all(c in chosen for c in ORIGINAL):
            continue
        missing = [c for c in NEW if c not in chosen]
        if not missing:
            continue
        bind.execute(rules.update().where(rules.c.id == ident).values(categories=[*chosen, *missing]))


def downgrade() -> None:
    pass
