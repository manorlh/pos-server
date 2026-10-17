"""app releases: a fourth platform, "windows7" — the Windows 7 till build

The Windows app has a second build for old PCs (Windows 7 / 8.1 x64, Celeron J1900, 4 GB): the same code on
Electron 22, till only (P:/specs/windows7-till.md). It asks `GET /sync/{m}/app-update?platform=windows7` and must
never be offered a standard (Electron 44) installer, which does not start on Windows 7 — so its releases are a
platform of their own. The CHECK `ck_app_releases_platform` is dropped and made again with "windows7".

Idempotent (the CHECK's text looked at first). SQLite (the CI) cannot alter a CHECK: the model's own constraint
(create_all) already has the value there, so nothing is done on it.

Revision ID: b7e3a9d1c5f2
Revises: c7d2f9a4e1b8
Create Date: 2026-10-17 12:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "b7e3a9d1c5f2"
down_revision: Union[str, None] = "c7d2f9a4e1b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RELEASES = "app_releases"
CK_PLATFORM = "ck_app_releases_platform"
PLATFORMS_SQL = "platform IN ('android', 'windows', 'kiosk_web', 'windows7')"
OLD_PLATFORMS_SQL = "platform IN ('android', 'windows', 'kiosk_web')"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _sqlite() -> bool:
    return not context.is_offline_mode() and op.get_bind().dialect.name == "sqlite"


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
    if _sqlite():
        return
    insp = _inspector()
    if insp is not None and not insp.has_table(RELEASES):
        return
    current = _check_sql(insp, RELEASES, CK_PLATFORM)
    if current is None or "windows7" not in current:
        if current is not None or insp is None:
            op.drop_constraint(CK_PLATFORM, RELEASES, type_="check")
        op.create_check_constraint(CK_PLATFORM, RELEASES, PLATFORMS_SQL)


def downgrade() -> None:
    if _sqlite():
        return
    # Only possible once no windows7 release is left.
    insp = _inspector()
    if insp is None or _check_sql(insp, RELEASES, CK_PLATFORM) is not None:
        op.drop_constraint(CK_PLATFORM, RELEASES, type_="check")
    op.create_check_constraint(CK_PLATFORM, RELEASES, OLD_PLATFORMS_SQL)
