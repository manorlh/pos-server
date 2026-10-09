"""The "web_app" release platform: the signed r2m-app screens bundle (web-till spec v2 §8.1)

* `app_releases.platform` may be "web_app" — one zip of every role's screens (till, kiosk,
  KDS, board, customer display) for every host, signed with Ed25519
  (app/services/web_bundles.py). The CHECK `ck_app_releases_platform` is dropped and made
  again with the fourth value.
* `app_releases.protocol` (nullable Integer) — the till engine protocol the bundle speaks
  (`manifest.protocol`); null for every other platform.
* `app_releases.shell_api` (nullable JSONB) — the shell API the bundle needs from each shell
  (`manifest.shellApi`); null for every other platform.

Add-only (two nullable columns, a wider CHECK). Idempotent: the auto-reloading dev API's
`create_all` never adds columns, but a re-run finds them and the CHECK already wide.

Revision ID: db2bc1f604fe
Revises: b8e2d4f6a1c3
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "db2bc1f604fe"
down_revision: Union[str, Sequence[str], None] = "b8e2d4f6a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RELEASES = "app_releases"
CK_PLATFORM = "ck_app_releases_platform"
PLATFORMS_SQL = "platform IN ('android', 'windows', 'kiosk_web', 'web_app')"
OLD_PLATFORMS_SQL = "platform IN ('android', 'windows', 'kiosk_web')"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _check_sql(insp, table: str, name: str):
    """The CHECK's text when it exists, "" when it exists without text, None when absent."""
    if insp is None:
        return None
    try:
        for ck in insp.get_check_constraints(table):
            if ck.get("name") == name:
                return ck.get("sqltext") or ""
    except NotImplementedError:  # pragma: no cover - dialects without reflection
        return None
    return None


def upgrade() -> None:
    insp = _inspector()
    if insp is not None and not insp.has_table(RELEASES):
        return
    have = set() if insp is None else {c["name"] for c in insp.get_columns(RELEASES)}
    if "protocol" not in have:
        op.add_column(RELEASES, sa.Column("protocol", sa.Integer(), nullable=True))
    if "shell_api" not in have:
        op.add_column(RELEASES, sa.Column("shell_api", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    current = _check_sql(insp, RELEASES, CK_PLATFORM)
    if current is None or "web_app" not in current:
        if current is not None or insp is None:
            op.drop_constraint(CK_PLATFORM, RELEASES, type_="check")
        op.create_check_constraint(CK_PLATFORM, RELEASES, PLATFORMS_SQL)


def downgrade() -> None:
    insp = _inspector()
    # Only possible once no web_app release is left.
    if _check_sql(insp, RELEASES, CK_PLATFORM) is not None or insp is None:
        op.drop_constraint(CK_PLATFORM, RELEASES, type_="check")
    op.create_check_constraint(CK_PLATFORM, RELEASES, OLD_PLATFORMS_SQL)
    have = None if insp is None else {c["name"] for c in insp.get_columns(RELEASES)}
    for column in ("shell_api", "protocol"):
        if have is None or column in have:
            op.drop_column(RELEASES, column)
