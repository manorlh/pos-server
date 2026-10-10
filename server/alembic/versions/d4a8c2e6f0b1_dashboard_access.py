"""הרשאות דשבורד: per dashboard user — sections, org scope, templates, audit

The owner, 07.10.2026: a new cloud user created for an organization is a "מנהל ארגון" who sees
only what is set for them — by default reports, products and Z — and the super admin opens the
rest (app/services/dashboard_access.py, app/services/dashboard_sections.py).

Three tables: `dashboard_access_templates`, `dashboard_access_profiles` (one per user) and
`dashboard_access_audit`.

Nobody loses access: every user that exists now gets a profile with `full_access` — everything
their role allows, exactly as before — and the built-in template "full" ("גישה מלאה לפי
תפקיד"). Only users created from now on start restricted. A super admin is never restricted and
gets no row.

Idempotent: a table the running API already made (`create_all` at start-up) is kept, only its
missing indexes are added, and a user who already has a profile keeps it. Downgrade drops the
three tables (everyone is back to "the role decides").

Revision ID: d4a8c2e6f0b1
Revises: e9a3c7f1b5d2
Create Date: 2026-10-08 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "d4a8c2e6f0b1"
down_revision = "e9a3c7f1b5d2"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def _index_names(table: str) -> set:
    return {ix["name"] for ix in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    if not _has_table("dashboard_access_templates"):
        op.create_table(
            "dashboard_access_templates",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("name", sa.String(120), nullable=False, unique=True),
            sa.Column("description", sa.String(500), nullable=True),
            sa.Column("sections", postgresql.JSONB(), nullable=False, server_default="{}"),
            sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )

    if not _has_table("dashboard_access_profiles"):
        op.create_table(
            "dashboard_access_profiles",
            sa.Column(
                "user_id", postgresql.UUID(as_uuid=True),
                sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True,
            ),
            sa.Column("full_access", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("sections", postgresql.JSONB(), nullable=False, server_default="{}"),
            sa.Column("org_wide", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("company_ids", postgresql.JSONB(), nullable=True),
            sa.Column("shop_ids", postgresql.JSONB(), nullable=True),
            sa.Column(
                "template_id", postgresql.UUID(as_uuid=True),
                sa.ForeignKey("dashboard_access_templates.id", ondelete="SET NULL"), nullable=True,
            ),
            sa.Column("builtin_template", sa.String(40), nullable=True),
            sa.Column("updated_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )

    if not _has_table("dashboard_access_audit"):
        op.create_table(
            "dashboard_access_audit",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "user_id", postgresql.UUID(as_uuid=True),
                sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True,
            ),
            sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("action", sa.String(40), nullable=False),
            sa.Column("before", postgresql.JSONB(), nullable=True),
            sa.Column("after", postgresql.JSONB(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    existing = _index_names("dashboard_access_audit")
    for name, column in (
        ("ix_dashboard_access_audit_user_id", "user_id"),
        ("ix_dashboard_access_audit_template_id", "template_id"),
        ("ix_dashboard_access_audit_created_at", "created_at"),
    ):
        if name not in existing:
            op.create_index(name, "dashboard_access_audit", [column])

    # Everyone who exists keeps exactly what their role gives them today.
    op.execute(
        sa.text(
            """
            INSERT INTO dashboard_access_profiles (user_id, full_access, org_wide, builtin_template)
            SELECT u.id, true, false, 'full'
            FROM users u
            WHERE u.role <> 'super_admin'
              AND NOT EXISTS (SELECT 1 FROM dashboard_access_profiles p WHERE p.user_id = u.id)
            """
        )
    )


def downgrade() -> None:
    for table in ("dashboard_access_audit", "dashboard_access_profiles", "dashboard_access_templates"):
        if _has_table(table):
            op.drop_table(table)
