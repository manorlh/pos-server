"""app release files can be deleted ("מחיקת קובץ" in "עדכוני גרסה")

* `app_releases.file_deleted_at` / `file_deleted_by` — the stored file was deleted by a super
  admin; the row stays (tills' status rows point at it) and is never offered again.
* `app_release_file_deletions` — the audit: one row per deleted file.

Add-only and idempotent (the API's create_all may have made any of it first).

Revision ID: c4e7a2f9b1d8
Revises: e8c1f4a7b2d9
Create Date: 2026-10-17 12:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c4e7a2f9b1d8"
down_revision: Union[str, Sequence[str], None] = "e8c1f4a7b2d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

AUDIT = "app_release_file_deletions"


def _offline() -> bool:
    try:
        return context.is_offline_mode()
    except (NameError, AttributeError):  # run by hand (a test) outside alembic's environment
        try:
            return bool(op.get_context().as_sql)
        except Exception:  # noqa: BLE001
            return False


def _has_table(name: str) -> bool:
    if _offline():
        return False
    return sa.inspect(op.get_bind()).has_table(name)


def _columns(table: str) -> set:
    if _offline():
        return set()
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set:
    if _offline():
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    columns = _columns("app_releases")
    if "file_deleted_at" not in columns:
        op.add_column("app_releases", sa.Column("file_deleted_at", sa.DateTime(timezone=True), nullable=True))
    if "file_deleted_by" not in columns:
        op.add_column(
            "app_releases",
            sa.Column("file_deleted_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        )
    if not _has_table(AUDIT):
        op.create_table(
            AUDIT,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("release_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("app_releases.id"), nullable=False),
            sa.Column("platform", sa.String(16), nullable=False),
            sa.Column("version_name", sa.String(64), nullable=False),
            sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("mode", sa.String(16), nullable=False, server_default="single"),
            sa.Column("retired", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("devices_on_version", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("storage_result", sa.String(32), nullable=False),
            sa.Column("deleted_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    if f"ix_{AUDIT}_release_id" not in _indexes(AUDIT):
        op.create_index(f"ix_{AUDIT}_release_id", AUDIT, ["release_id"])


def downgrade() -> None:
    if _has_table(AUDIT):
        op.drop_table(AUDIT)
    columns = _columns("app_releases")
    for column in ("file_deleted_by", "file_deleted_at"):
        if column in columns:
            op.drop_column("app_releases", column)
