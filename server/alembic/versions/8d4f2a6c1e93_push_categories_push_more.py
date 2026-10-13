"""push alert types of push-more: on for users who had every type

P:/specs/push-more.md §A, §B: ten new phone-alert types — `device_battery` ("סוללה חלשה"),
`discounts`, `cash_difference`, `high_tip`, `high_sale`, `after_hours`, `sensitive_actions`,
`staff_actions`, `stock`, `slow_order`. Whether one is sent at all is the organization's
("שלח התראה לטלפון" of each kind's exception rule, per level — off by default but the battery);
a user's own list decides whether it reaches them, and a type missing from it is off. So, like
3c9e5a7b1d24: a rule whose list holds each of the six types the phone alerts started with gets
them appended; a rule that left any of those six out keeps its choice. Data only, idempotent;
the downgrade removes nothing.

Revision ID: 8d4f2a6c1e93
Revises: 3c9e5a7b1d24
Create Date: 2026-10-13

"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "8d4f2a6c1e93"
down_revision: Union[str, Sequence[str], None] = "3c9e5a7b1d24"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORIGINAL = ("till_offline", "card_terminal", "large_void", "drawer_no_sale", "till_low_sales", "target_reached")
NEW = (
    "device_battery", "discounts", "cash_difference", "high_tip", "high_sale", "after_hours",
    "sensitive_actions", "staff_actions", "stock", "slow_order",
)


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
