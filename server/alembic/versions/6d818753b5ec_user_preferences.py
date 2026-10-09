"""users: the dashboard user's own preferences ("דף פתיחה")

Revision ID: 6d818753b5ec
Revises: 6b1e9d4f2a87
Create Date: 2026-10-08

One nullable JSON column on `users`, `preferences`: what a signed-in person chose for
themselves in their profile, kept on the server so it follows them to every phone and
computer (never only in a browser's storage). Today one key:

* `homePage` — "דף פתיחה", where a sign-in lands: `board` (לוח בקרה, the default),
  `compare` (השוואות) or one of a few report pages (app/services/user_preferences.py).

Null for every existing user = the defaults; nothing is back-filled.

Idempotent: the column is added only when missing (a dev database may have it from a
previous run); offline (`--sql`) the plain statement.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '6d818753b5ec'
down_revision: Union[str, Sequence[str], None] = '6b1e9d4f2a87'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'users'
COLUMN = 'preferences'


def _offline() -> bool:
    return bool(op.get_context().as_sql)


def _has_column() -> bool:
    if _offline():
        return False
    return COLUMN in {c['name'] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column():
        op.add_column(
            TABLE,
            sa.Column(COLUMN, sa.JSON().with_variant(postgresql.JSONB(), 'postgresql'), nullable=True),
        )


def downgrade() -> None:
    if _offline() or _has_column():
        op.drop_column(TABLE, COLUMN)
