"""App releases for two platforms, staged rollout, rollback and an install window

* `app_releases.platform` — "android" (the till APK, as every release so far) or
  "windows" (the Windows app's NSIS installer). NOT NULL, default "android", indexed.
* A version name is unique per platform: the global unique on `version_name`
  (`app_releases_version_name_key`, inspected rather than assumed) gives way to
  `uq_app_releases_platform_version_name (platform, version_name)`.
* `app_release_assignments.rollout_percent` (1..100, default 100) — staged rollout;
  `allow_downgrade` (default false) — a Windows rollback; `install_window_start` /
  `install_window_end` ("HH:MM", both or neither) — when an auto-install may run.

Idempotent and guarded: every column, index and constraint is looked at before it is
added or dropped (the auto-reloading dev API's `create_all` never adds columns, but a
fresh database may get the tables from the models first). Offline (`--sql`) everything
is emitted as if nothing were there yet.

Revision ID: e5b7d9f1a3c8
Revises: c4e8a2f6d1b9
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "e5b7d9f1a3c8"
down_revision: Union[str, Sequence[str], None] = "c4e8a2f6d1b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RELEASES = "app_releases"
ASSIGNMENTS = "app_release_assignments"

UQ_PLATFORM_VERSION = "uq_app_releases_platform_version_name"
CK_PLATFORM = "ck_app_releases_platform"
IX_PLATFORM = "ix_app_releases_platform"
CK_ROLLOUT = "ck_app_release_assignments_rollout_percent"
#: Postgres' own name for the old `unique=True` on `version_name` (used offline only;
#: online the constraint is found by its column).
OLD_UNIQUE = "app_releases_version_name_key"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _indexes(insp, table: str) -> list:
    return [] if insp is None else insp.get_indexes(table)


def _uniques(insp, table: str) -> list:
    return [] if insp is None else insp.get_unique_constraints(table)


def _checks(insp, table: str) -> set:
    if insp is None:
        return set()
    try:
        return {c["name"] for c in insp.get_check_constraints(table)}
    except NotImplementedError:  # pragma: no cover - dialects without reflection
        return set()


def upgrade() -> None:
    insp = _inspector()
    if insp is not None and not (insp.has_table(RELEASES) and insp.has_table(ASSIGNMENTS)):
        # f0a1b2c3d4e5 makes both tables; nothing to change without them.
        return

    # ── app_releases.platform ────────────────────────────────────────────────
    if "platform" not in _columns(insp, RELEASES):
        op.add_column(
            RELEASES,
            sa.Column("platform", sa.String(16), nullable=False, server_default="android"),
        )
    if IX_PLATFORM not in {i["name"] for i in _indexes(insp, RELEASES)}:
        op.create_index(IX_PLATFORM, RELEASES, ["platform"])
    if CK_PLATFORM not in _checks(insp, RELEASES):
        op.create_check_constraint(CK_PLATFORM, RELEASES, "platform IN ('android', 'windows')")

    # ── version_name unique per platform ─────────────────────────────────────
    if insp is None:
        op.drop_constraint(OLD_UNIQUE, RELEASES, type_="unique")
    else:
        for uq in _uniques(insp, RELEASES):
            if list(uq.get("column_names") or []) == ["version_name"] and uq.get("name"):
                op.drop_constraint(uq["name"], RELEASES, type_="unique")
        # A bare unique index on version_name alone (not backing a constraint) goes too.
        for ix in _indexes(sa.inspect(op.get_bind()), RELEASES):
            if (
                ix.get("unique")
                and list(ix.get("column_names") or []) == ["version_name"]
                and not ix.get("duplicates_constraint")
                and ix.get("name")
            ):
                op.drop_index(ix["name"], table_name=RELEASES)
    fresh = None if insp is None else sa.inspect(op.get_bind())
    if UQ_PLATFORM_VERSION not in {u.get("name") for u in _uniques(fresh, RELEASES)}:
        op.create_unique_constraint(UQ_PLATFORM_VERSION, RELEASES, ["platform", "version_name"])

    # ── app_release_assignments: stage, rollback, install window ─────────────
    columns = _columns(insp, ASSIGNMENTS)
    if "rollout_percent" not in columns:
        op.add_column(
            ASSIGNMENTS,
            sa.Column("rollout_percent", sa.Integer(), nullable=False, server_default="100"),
        )
    if "allow_downgrade" not in columns:
        op.add_column(
            ASSIGNMENTS,
            sa.Column("allow_downgrade", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    if "install_window_start" not in columns:
        op.add_column(ASSIGNMENTS, sa.Column("install_window_start", sa.String(5), nullable=True))
    if "install_window_end" not in columns:
        op.add_column(ASSIGNMENTS, sa.Column("install_window_end", sa.String(5), nullable=True))
    if CK_ROLLOUT not in _checks(insp, ASSIGNMENTS):
        op.create_check_constraint(CK_ROLLOUT, ASSIGNMENTS, "rollout_percent BETWEEN 1 AND 100")


def downgrade() -> None:
    op.drop_constraint(CK_ROLLOUT, ASSIGNMENTS, type_="check")
    op.drop_column(ASSIGNMENTS, "install_window_end")
    op.drop_column(ASSIGNMENTS, "install_window_start")
    op.drop_column(ASSIGNMENTS, "allow_downgrade")
    op.drop_column(ASSIGNMENTS, "rollout_percent")
    # Only possible while no version name is used on both platforms.
    op.drop_constraint(UQ_PLATFORM_VERSION, RELEASES, type_="unique")
    op.create_unique_constraint(OLD_UNIQUE, RELEASES, ["version_name"])
    op.drop_constraint(CK_PLATFORM, RELEASES, type_="check")
    op.drop_index(IX_PLATFORM, table_name=RELEASES)
    op.drop_column(RELEASES, "platform")
