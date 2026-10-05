"""Remote app updates for tills ("עדכון קופות")

* `app_releases` — one uploaded APK each (global; the file is on local disk).
* `app_release_assignments` — a release sent to a tenant, company, shop, area or till.
* `app_release_machine_status` — each till's last report about each release.

Parent is the offline authorizations (d0e1f2a3b4c5).

Revision ID: f0a1b2c3d4e5
Revises: d0e1f2a3b4c5
Create Date: 2026-10-03 23:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f0a1b2c3d4e5"
down_revision = "d0e1f2a3b4c5"
branch_labels = None
depends_on = None


def _existing_tables() -> set:
    if context.is_offline_mode():
        return set()
    return set(sa.inspect(op.get_bind()).get_table_names())


def _existing_indexes(table: str, tables: set) -> set:
    if context.is_offline_mode() or table not in tables:
        return set()
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _ensure_index(table: str, tables: set, name: str, columns: list) -> None:
    if name not in _existing_indexes(table, tables):
        op.create_index(name, table, columns)


def upgrade() -> None:
    # The app's `create_all` on start-up may have made the tables (and their indexes)
    # already from the models, as for the offline authorizations (d0e1f2a3b4c5); only
    # what is missing is created.
    tables = _existing_tables()
    if "app_releases" not in tables:
        _create_app_releases()
    if "app_release_assignments" not in tables:
        _create_app_release_assignments()
    if "app_release_machine_status" not in tables:
        _create_app_release_machine_status()
    tables = _existing_tables()
    _ensure_index(
        "app_release_assignments", tables, "ix_app_release_assignments_target", ["level", "target_id"]
    )
    _ensure_index(
        "app_release_assignments", tables, "ix_app_release_assignments_release_id", ["release_id"]
    )
    _ensure_index(
        "app_release_assignments", tables, "ix_app_release_assignments_tenant_id", ["tenant_id"]
    )
    _ensure_index(
        "app_release_machine_status", tables, "ix_app_release_machine_status_machine_id", ["machine_id"]
    )
    _ensure_index(
        "app_release_machine_status", tables, "ix_app_release_machine_status_release_id", ["release_id"]
    )


def _create_app_releases() -> None:
    op.create_table(
        "app_releases",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("version_code", sa.Integer(), nullable=False),
        sa.Column("version_name", sa.String(64), nullable=False, unique=True),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("file_path", sa.String(1000), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("uploaded_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def _create_app_release_assignments() -> None:
    op.create_table(
        "app_release_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "release_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("app_releases.id"), nullable=False
        ),
        sa.Column("level", sa.String(16), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("auto_install", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "level IN ('tenant', 'company', 'shop', 'area', 'machine')",
            name="ck_app_release_assignments_level",
        ),
    )


def _create_app_release_machine_status() -> None:
    op.create_table(
        "app_release_machine_status",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False
        ),
        sa.Column(
            "release_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("app_releases.id"), nullable=False
        ),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("message", sa.String(500), nullable=True),
        sa.Column("version_name", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("machine_id", "release_id", name="uq_app_release_machine_status"),
        sa.CheckConstraint(
            "status IN ('downloading', 'downloaded', 'installing', 'installed', 'failed', 'declined')",
            name="ck_app_release_machine_status_status",
        ),
    )


def downgrade() -> None:
    op.drop_index("ix_app_release_machine_status_release_id", table_name="app_release_machine_status")
    op.drop_index("ix_app_release_machine_status_machine_id", table_name="app_release_machine_status")
    op.drop_table("app_release_machine_status")
    op.drop_index("ix_app_release_assignments_tenant_id", table_name="app_release_assignments")
    op.drop_index("ix_app_release_assignments_release_id", table_name="app_release_assignments")
    op.drop_index("ix_app_release_assignments_target", table_name="app_release_assignments")
    op.drop_table("app_release_assignments")
    op.drop_table("app_releases")
