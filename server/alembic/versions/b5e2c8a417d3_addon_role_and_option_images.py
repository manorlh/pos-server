"""products.addon_role; modifier_options.image_url; prep_note_presets.image_url

"תוספת" (app/services/addon_role.py): a product's add-on role — none (as every product so far) /
addon_only / both — NOT NULL with a server default of 'none', so every existing row reads as before.
And a picture for a modifier option and for a note chip (background removed, as a product's) —
nullable, nothing else touched.

Idempotent: each column is looked at first (the API's create_all may have made it before this runs).
Downgrade drops only these three columns.

Revision ID: b5e2c8a417d3, revises a1eece573e4e (11.10.2026; was written on 7c3a9d2e5b14).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "b5e2c8a417d3"
down_revision: Union[str, Sequence[str], None] = "a1eece573e4e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("products", "addon_role", lambda: sa.Column(
        "addon_role", sa.String(length=16), nullable=False, server_default="none",
    )),
    ("modifier_options", "image_url", lambda: sa.Column("image_url", sa.String(length=500), nullable=True)),
    ("prep_note_presets", "image_url", lambda: sa.Column("image_url", sa.String(length=500), nullable=True)),
)


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except NameError:  # run by hand (a test) outside alembic's environment: online
        return False


def _has_column(table: str, column: str) -> bool:
    if _offline():
        return False
    insp = sa.inspect(op.get_bind())
    return insp.has_table(table) and column in {c["name"] for c in insp.get_columns(table)}


def _has_table(table: str) -> bool:
    if _offline():
        return True
    return sa.inspect(op.get_bind()).has_table(table)


def upgrade() -> None:
    for table, column, make in COLUMNS:
        if not _has_table(table) or _has_column(table, column):
            continue
        op.add_column(table, make())


def downgrade() -> None:
    for table, column, _make in reversed(COLUMNS):
        if _has_column(table, column):
            op.drop_column(table, column)
