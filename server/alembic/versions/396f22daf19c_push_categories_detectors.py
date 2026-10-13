"""push alert types of the new detectors: on for users who had every type

P:/specs/push-more.md §C (feat/push-detectors, #88): three new phone-alert types —
`shop_open` ("הסניף לא פתח"), `sales_pace` ("קצב מכירות נמוך"), `daily_summary` ("סיכום יום").
Like 3c9e5a7b1d24 and 8d4f2a6c1e93: a push rule stores the types its owner chose, and a type
missing from it is off — so a rule whose list holds each of the six types the phone alerts
started with ("בחרו 'הכל'") gets the three appended; a rule that left any of those six out keeps
its choice. Whether one is sent at all stays the organization's: each detector is off until a
level switches it on, so nothing new is sent before a manager does.

`payment_reversals` (table-restore-payments, #93) stays opt-in by design: not added here.

Data only, idempotent (a type already on the list is not added twice); the downgrade removes
nothing (a user may have chosen them since).

Revision ID: 396f22daf19c
Revises: 9f55dd368692
Create Date: 2026-10-14

"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "396f22daf19c"
down_revision: Union[str, Sequence[str], None] = "9f55dd368692"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORIGINAL = ("till_offline", "card_terminal", "large_void", "drawer_no_sale", "till_low_sales", "target_reached")
NEW = ("shop_open", "sales_pace", "daily_summary")


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
