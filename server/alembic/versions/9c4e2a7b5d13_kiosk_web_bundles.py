"""Kiosk web bundles: a third release platform and the kiosk's web-renderer status

* `app_releases.platform` may be "kiosk_web" — a zip of the kiosk's screens built as static
  files (`manifest.json` + the files), shown by the Android kiosk in a WebView. The CHECK
  `ck_app_releases_platform` is dropped and made again with the third value.
* `app_releases.bridge_api` (nullable Integer) — the bridge API version a bundle needs from
  the kiosk's APK (`manifest.bridgeApi`); null for Android / Windows releases.
* `kiosk_web_device_status` — one row per machine: what the kiosk shows now (native / web),
  what its config asks, its active / previous / pending bundle and why it fell back.

Idempotent: the auto-reloading dev API's `create_all` may make the new table before this
runs, so the table, the column and the constraint are each looked at first.

Revision ID: 9c4e2a7b5d13
Revises: d7a3f9c1e5b8
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "9c4e2a7b5d13"
down_revision: Union[str, Sequence[str], None] = "d7a3f9c1e5b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RELEASES = "app_releases"
STATUS = "kiosk_web_device_status"
CK_PLATFORM = "ck_app_releases_platform"
PLATFORMS_SQL = "platform IN ('android', 'windows', 'kiosk_web')"
OLD_PLATFORMS_SQL = "platform IN ('android', 'windows')"


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

    # ── app_releases: bridge_api, and "kiosk_web" in the platform CHECK ──────
    if insp is None or insp.has_table(RELEASES):
        have = set() if insp is None else {c["name"] for c in insp.get_columns(RELEASES)}
        if "bridge_api" not in have:
            op.add_column(RELEASES, sa.Column("bridge_api", sa.Integer(), nullable=True))
        current = _check_sql(insp, RELEASES, CK_PLATFORM)
        if current is None or "kiosk_web" not in current:
            if current is not None:
                op.drop_constraint(CK_PLATFORM, RELEASES, type_="check")
            op.create_check_constraint(CK_PLATFORM, RELEASES, PLATFORMS_SQL)

    # ── kiosk_web_device_status ──────────────────────────────────────────────
    if insp is None or not insp.has_table(STATUS):
        op.create_table(
            STATUS,
            sa.Column(
                "machine_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("pos_machines.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("renderer", sa.String(16), nullable=False),
            sa.Column("configured", sa.String(16), nullable=True),
            sa.Column("bundle_version", sa.String(64), nullable=True),
            sa.Column("bundle_version_code", sa.Integer(), nullable=True),
            sa.Column("bundle_source", sa.String(16), nullable=True),
            sa.Column("previous_version", sa.String(64), nullable=True),
            sa.Column("pending_version", sa.String(64), nullable=True),
            sa.Column("apk_bridge_api", sa.Integer(), nullable=True),
            sa.Column("fallback_reason", sa.String(32), nullable=True),
            sa.Column("message", sa.String(500), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )


def downgrade() -> None:
    insp = _inspector()
    if insp is None or insp.has_table(STATUS):
        op.drop_table(STATUS)
    # Only possible once no kiosk_web release is left.
    if _check_sql(insp, RELEASES, CK_PLATFORM) is not None or insp is None:
        op.drop_constraint(CK_PLATFORM, RELEASES, type_="check")
    op.create_check_constraint(CK_PLATFORM, RELEASES, OLD_PLATFORMS_SQL)
    if insp is None or "bridge_api" in {c["name"] for c in insp.get_columns(RELEASES)}:
        op.drop_column(RELEASES, "bridge_api")
