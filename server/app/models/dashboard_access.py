"""
"הרשאות דשבורד" — what one dashboard (cloud) user may see and do, per user.

Not "תפקידים והרשאות בקופה": that is the till users' (pos_users) authority at the register.
This is the cloud dashboard's: which sections ("לשוניות") a person signed in at the dashboard
may open, at view or edit, and which part of the organization their data comes from.

Three tables:

* `dashboard_access_profiles` — one row per user. `full_access` is "everything the role
  allows" (every user that existed before profiles did, so nobody lost anything); otherwise
  `sections` is the grant, `{"reports": "view", "products": "edit", ...}`. The org scope
  narrows (or, for a company-level manager, sets) which companies / shops the user's data
  comes from: `org_wide` = every company of the user's organizations, `company_ids` = those
  companies and their subsidiaries, `shop_ids` = only these shops. The organizations
  themselves are the user's tenant memberships (`tenant_memberships`), as before.
* `dashboard_access_templates` — "פרופיל הרשאות": a named set of sections the super admin
  defines once and applies to many users. Applying copies the sections; a later change to
  the template does not reach users silently.
* `dashboard_access_audit` — every change to a profile, a template or a membership, with
  who made it and the before / after.

The rules are in app/services/dashboard_access.py; the section catalogue and which API route
belongs to which section in app/services/dashboard_sections.py.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class DashboardAccessTemplate(Base):
    __tablename__ = "dashboard_access_templates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(120), nullable=False, unique=True)
    description = Column(String(500), nullable=True)
    #: `{section_id: "view" | "edit"}` — only known sections are kept.
    sections = Column(JSONB, nullable=False, default=dict, server_default="{}")
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class DashboardAccessProfile(Base):
    __tablename__ = "dashboard_access_profiles"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    #: Everything the user's role allows — today's behaviour, and the migration's mapping of
    #: every existing user. A super admin turns it off to grant sections one by one.
    full_access = Column(Boolean, nullable=False, default=False, server_default="false")
    #: `{section_id: "view" | "edit"}`; read only when `full_access` is off.
    sections = Column(JSONB, nullable=False, default=dict, server_default="{}")
    #: A company-level manager covers every company of their organizations.
    org_wide = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Company ids (strings) — those companies and their subsidiaries. Null/empty = the role's own.
    company_ids = Column(JSONB, nullable=True)
    #: Shop ids (strings) — only these shops, inside the companies above. Null/empty = all of them.
    shop_ids = Column(JSONB, nullable=True)
    #: The template last applied ("מנהל ארגון" is built in and has no row: `builtin_template`).
    template_id = Column(UUID(as_uuid=True), ForeignKey("dashboard_access_templates.id", ondelete="SET NULL"), nullable=True)
    builtin_template = Column(String(40), nullable=True)
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class DashboardAccessAudit(Base):
    __tablename__ = "dashboard_access_audit"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: The user whose access changed (null for a template change).
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    template_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    actor_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    #: "profile.create" | "profile.update" | "template.create" | "template.update" |
    #: "template.delete" | "membership.add" | "membership.remove"
    action = Column(String(40), nullable=False)
    before = Column(JSONB, nullable=True)
    after = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)
