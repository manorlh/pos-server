"""Upsell rules: the kiosk as a place, the "transition" trigger, a picture of their own

Revision ID: e7b3c9a1d5f2
Revises: a3d7f1c9e5b2
Create Date: 2026-10-06

docs/SPEC_KIOSK.md §21 ("הגדלת מכירה" — one feature, three channels):
- `place` becomes the set of channels a rule is offered on (quick / tables / kiosk,
  comma-joined). Every rule keeps its meaning: before the kiosk had a place, the kiosk
  offered the rules for quick orders and for both places, so "both" becomes
  "quick,tables,kiosk" and "quick" "quick,kiosk"; "tables" stays.
- `trigger_type` "transition": `trigger_ids` are step codes (order_start, enter_category:<id>,
  to_pay, …).
- `image_url`: the window's own picture (a special).
Additive and idempotent; the constraints are replaced.
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'e7b3c9a1d5f2'
down_revision: Union[str, Sequence[str], None] = 'a3d7f1c9e5b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TRIGGERS = "('product', 'category', 'order', 'transition')"
PLACES = "('quick', 'tables', 'kiosk', 'quick,tables', 'quick,kiosk', 'tables,kiosk', 'quick,tables,kiosk', 'both')"


def upgrade() -> None:
    op.execute("ALTER TABLE upsell_rules ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)")
    op.execute("ALTER TABLE upsell_rules ALTER COLUMN place TYPE VARCHAR(24)")
    op.execute("ALTER TABLE upsell_rules DROP CONSTRAINT IF EXISTS ck_upsell_rules_place")
    op.execute("UPDATE upsell_rules SET place = 'quick,tables,kiosk' WHERE place = 'both'")
    op.execute("UPDATE upsell_rules SET place = 'quick,kiosk' WHERE place = 'quick'")
    op.execute(f"ALTER TABLE upsell_rules ADD CONSTRAINT ck_upsell_rules_place CHECK (place IN {PLACES})")
    op.execute("ALTER TABLE upsell_rules ALTER COLUMN place SET DEFAULT 'quick,tables,kiosk'")
    op.execute("ALTER TABLE upsell_rules DROP CONSTRAINT IF EXISTS ck_upsell_rules_trigger_type")
    op.execute(f"ALTER TABLE upsell_rules ADD CONSTRAINT ck_upsell_rules_trigger_type CHECK (trigger_type IN {TRIGGERS})")


def downgrade() -> None:
    # Never run in production (additive only); kept so the chain stays walkable.
    op.execute("ALTER TABLE upsell_rules DROP CONSTRAINT IF EXISTS ck_upsell_rules_trigger_type")
    op.execute("DELETE FROM upsell_rules WHERE trigger_type = 'transition'")
    op.execute(
        "ALTER TABLE upsell_rules ADD CONSTRAINT ck_upsell_rules_trigger_type "
        "CHECK (trigger_type IN ('product', 'category', 'order'))"
    )
    op.execute("ALTER TABLE upsell_rules DROP CONSTRAINT IF EXISTS ck_upsell_rules_place")
    op.execute(
        "UPDATE upsell_rules SET place = CASE "
        "WHEN place IN ('quick,tables', 'quick,tables,kiosk') THEN 'both' "
        "WHEN place IN ('quick', 'quick,kiosk') THEN 'quick' "
        "WHEN place IN ('tables', 'tables,kiosk') THEN 'tables' ELSE 'both' END"
    )
    op.execute("ALTER TABLE upsell_rules ALTER COLUMN place SET DEFAULT 'both'")
    op.execute("ALTER TABLE upsell_rules ADD CONSTRAINT ck_upsell_rules_place CHECK (place IN ('quick', 'tables', 'both'))")
    op.execute("ALTER TABLE upsell_rules DROP COLUMN IF EXISTS image_url")
