"""presentation profiles: the digital menu's and the online ordering site's profiles, revisions and audit

specs/digital-menu-ordering-cards-plan.md §6, app/services/presentation_profiles.py.

* `presentation_profiles` — kind (menu / online), names, a stable public slug, the target (company /
  shop / point of sale), service types, price-list context, languages, priority, status, the
  published and the draft revision, the template it inherits from, an optimistic version.
* `presentation_revisions` — the content (JSON) and a state per field (inherit / local / hidden), a
  number, the revision it was based on, an optimistic version, and what publication exposed.
* `presentation_audit` — every write, before / after.

New tables only (add-only, idempotent: each looked at first).

Revision ID: 2e5378a4c106
Revises: 701a25694d3c
Create Date: 2026-10-10
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "2e5378a4c106"
down_revision: Union[str, Sequence[str], None] = "701a25694d3c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PROFILES = "presentation_profiles"
REVISIONS = "presentation_revisions"
AUDIT = "presentation_audit"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _indexes(insp, table):
    return set() if insp is None or not insp.has_table(table) else {i["name"] for i in insp.get_indexes(table)}


def upgrade() -> None:
    insp = _inspector()
    uuid_t = postgresql.UUID(as_uuid=True)
    if insp is None or not insp.has_table(PROFILES):
        op.create_table(
            PROFILES,
            sa.Column("id", uuid_t, primary_key=True),
            sa.Column("tenant_id", uuid_t, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("kind", sa.String(8), nullable=False),
            sa.Column("internal_name", sa.String(120), nullable=False),
            sa.Column("public_title", sa.JSON(), nullable=False),
            sa.Column("slug", sa.String(80), nullable=False),
            sa.Column("target_level", sa.String(8), nullable=False),
            sa.Column("target_id", uuid_t, nullable=False),
            sa.Column("company_id", uuid_t, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=True),
            sa.Column("shop_id", uuid_t, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=True),
            sa.Column("area_id", uuid_t, sa.ForeignKey("shop_areas.id", ondelete="CASCADE"), nullable=True),
            sa.Column("service_types", sa.JSON(), nullable=False),
            sa.Column("price_context", sa.JSON(), nullable=False),
            sa.Column("languages", sa.JSON(), nullable=False),
            sa.Column("default_language", sa.String(8), nullable=False, server_default="he"),
            sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(12), nullable=False, server_default="draft"),
            sa.Column("parent_profile_id", uuid_t, sa.ForeignKey("presentation_profiles.id", ondelete="SET NULL"), nullable=True),
            sa.Column("published_revision_id", uuid_t, nullable=True),
            sa.Column("draft_revision_id", uuid_t, nullable=True),
            sa.Column("created_from", sa.JSON(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("created_by_user_id", uuid_t, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("updated_by_name", sa.String(200), nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("kind IN ('menu', 'online')", name="ck_presentation_profiles_kind"),
            sa.CheckConstraint("target_level IN ('company', 'shop', 'area')", name="ck_presentation_profiles_level"),
            sa.CheckConstraint(
                "status IN ('draft', 'saved', 'published', 'paused', 'archived')", name="ck_presentation_profiles_status",
            ),
            sa.UniqueConstraint("slug", name="uq_presentation_profiles_slug"),
        )
    have = _indexes(insp, PROFILES)
    if "ix_presentation_profiles_tenant_kind" not in have:
        op.create_index("ix_presentation_profiles_tenant_kind", PROFILES, ["tenant_id", "kind"])
    if "ix_presentation_profiles_target" not in have:
        op.create_index("ix_presentation_profiles_target", PROFILES, ["tenant_id", "target_level", "target_id"])

    if insp is None or not insp.has_table(REVISIONS):
        op.create_table(
            REVISIONS,
            sa.Column("id", uuid_t, primary_key=True),
            sa.Column("tenant_id", uuid_t, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("profile_id", uuid_t, sa.ForeignKey("presentation_profiles.id", ondelete="CASCADE"), nullable=False),
            sa.Column("number", sa.Integer(), nullable=False),
            sa.Column("state", sa.String(12), nullable=False, server_default="draft"),
            sa.Column("base_revision_id", uuid_t, nullable=True),
            sa.Column("content", sa.JSON(), nullable=False),
            sa.Column("field_states", sa.JSON(), nullable=False),
            sa.Column("exposure", sa.JSON(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("note", sa.String(300), nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("saved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("saved_by_name", sa.String(200), nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("published_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.CheckConstraint("state IN ('draft', 'published', 'retired')", name="ck_presentation_revisions_state"),
            sa.UniqueConstraint("profile_id", "number", name="uq_presentation_revisions_number"),
        )
    if "ix_presentation_revisions_profile" not in _indexes(insp, REVISIONS):
        op.create_index("ix_presentation_revisions_profile", REVISIONS, ["profile_id"])

    if insp is None or not insp.has_table(AUDIT):
        op.create_table(
            AUDIT,
            sa.Column("id", uuid_t, primary_key=True),
            sa.Column("tenant_id", uuid_t, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("profile_id", uuid_t, sa.ForeignKey("presentation_profiles.id", ondelete="CASCADE"), nullable=False),
            sa.Column("revision_id", uuid_t, nullable=True),
            sa.Column("action", sa.String(24), nullable=False),
            sa.Column("actor_user_id", uuid_t, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("actor_name", sa.String(200), nullable=True),
            sa.Column("before", sa.JSON(), nullable=True),
            sa.Column("after", sa.JSON(), nullable=True),
            sa.Column("reason", sa.String(300), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    if "ix_presentation_audit_profile" not in _indexes(insp, AUDIT):
        op.create_index("ix_presentation_audit_profile", AUDIT, ["profile_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_presentation_audit_profile", table_name=AUDIT)
    op.drop_table(AUDIT)
    op.drop_index("ix_presentation_revisions_profile", table_name=REVISIONS)
    op.drop_table(REVISIONS)
    op.drop_index("ix_presentation_profiles_target", table_name=PROFILES)
    op.drop_index("ix_presentation_profiles_tenant_kind", table_name=PROFILES)
    op.drop_table(PROFILES)
