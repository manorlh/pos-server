"""
Presentation profiles — what a digital menu or an online ordering site shows, for a company, a shop
or a point of sale (specs/digital-menu-ordering-cards-plan.md §6, app/services/presentation_profiles.py).

* `presentation_profiles` — one profile: its kind (`menu` / `online`), internal name, public title
  (per language), a stable public `slug`, its target (company / shop / point of sale), the service
  types (dine-in / takeaway), the price-list context, languages, priority, status (draft / saved /
  published / paused / archived), the published and the draft revision, the template it inherits
  from (`parent_profile_id`), how it was started (new / match kiosk / copy) and an optimistic
  `version` for its own fields.
* `presentation_revisions` — the content as JSON (theme, flow, texts, schedule, selection,
  product overrides, sections, display) with a state per editable field (inherit / local / hidden),
  a number, the revision it was based on, an optimistic `version`, and — once published — what it
  exposed (`exposure`: the products selected and allowed in the channel at that moment) and the
  order it froze. **A published revision never changes**; edits go to the draft.
* `presentation_audit` — who did what to a profile, before / after, with the revision.

Blocks, stock and availability live in their own tables: rolling back a design never touches them.
"""
import uuid

from sqlalchemy import (
    CheckConstraint, Column, DateTime, ForeignKey, Index, Integer, JSON, String, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

PROFILE_KINDS = ("menu", "online")
PROFILE_LEVELS = ("company", "shop", "area")
PROFILE_STATUSES = ("draft", "saved", "published", "paused", "archived")
REVISION_STATES = ("draft", "published", "retired")
SERVICE_TYPES = ("dine_in", "takeaway")


class PresentationProfile(Base):
    __tablename__ = "presentation_profiles"
    __table_args__ = (
        CheckConstraint("kind IN ('menu', 'online')", name="ck_presentation_profiles_kind"),
        CheckConstraint("target_level IN ('company', 'shop', 'area')", name="ck_presentation_profiles_level"),
        CheckConstraint(
            "status IN ('draft', 'saved', 'published', 'paused', 'archived')", name="ck_presentation_profiles_status",
        ),
        UniqueConstraint("slug", name="uq_presentation_profiles_slug"),
        Index("ix_presentation_profiles_tenant_kind", "tenant_id", "kind"),
        Index("ix_presentation_profiles_target", "tenant_id", "target_level", "target_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    kind = Column(String(8), nullable=False)
    internal_name = Column(String(120), nullable=False)
    #: `{lang: title}`.
    public_title = Column(JSON, nullable=False, default=dict)
    #: The stable public link's last part (`/m/…/p/{slug}`); never reused, fixed once published.
    slug = Column(String(80), nullable=False)
    target_level = Column(String(8), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False)
    #: The target's company, shop and point of sale (denormalised for the lists and the resolver).
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id", ondelete="CASCADE"), nullable=True)
    #: ["dine_in", "takeaway"] — a table number is part of dine-in, not a third type.
    service_types = Column(JSON, nullable=False, default=list)
    #: `{"mode": "target"}` (the target's own prices, a time menu's when one applies) or
    #: `{"mode": "catalog_menu", "menuId": …}` (that menu's prices).
    price_context = Column(JSON, nullable=False, default=dict)
    languages = Column(JSON, nullable=False, default=list)
    default_language = Column(String(8), nullable=False, default="he", server_default="he")
    #: Among profiles of one target and kind active at once, the higher wins (equal: refused at publish).
    priority = Column(Integer, nullable=False, default=0, server_default="0")
    status = Column(String(12), nullable=False, default="draft", server_default="draft")
    #: The company template (or shop profile) this one inherits from — published revisions only.
    parent_profile_id = Column(UUID(as_uuid=True), ForeignKey("presentation_profiles.id", ondelete="SET NULL"), nullable=True)
    published_revision_id = Column(UUID(as_uuid=True), nullable=True)
    draft_revision_id = Column(UUID(as_uuid=True), nullable=True)
    #: How it was started: `{"mode": "new" | "match_kiosk" | "copy", …source}`.
    created_from = Column(JSON, nullable=True)
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    updated_by_name = Column(String(200), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=True)
    archived_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class PresentationRevision(Base):
    __tablename__ = "presentation_revisions"
    __table_args__ = (
        CheckConstraint("state IN ('draft', 'published', 'retired')", name="ck_presentation_revisions_state"),
        UniqueConstraint("profile_id", "number", name="uq_presentation_revisions_number"),
        Index("ix_presentation_revisions_profile", "profile_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    profile_id = Column(UUID(as_uuid=True), ForeignKey("presentation_profiles.id", ondelete="CASCADE"), nullable=False)
    number = Column(Integer, nullable=False)
    state = Column(String(12), nullable=False, default="draft", server_default="draft")
    base_revision_id = Column(UUID(as_uuid=True), nullable=True)
    content = Column(JSON, nullable=False, default=dict)
    #: `{field: "inherit" | "local" | "hidden"}` — an empty value is never "hidden" by itself.
    field_states = Column(JSON, nullable=False, default=dict)
    #: At publication: `{"products": [ids], "categories": [ids], "includeFuture": [category ids], "order": …}`.
    exposure = Column(JSON, nullable=True)
    version = Column(Integer, nullable=False, default=1, server_default="1")
    note = Column(String(300), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    saved_at = Column(DateTime(timezone=True), nullable=True)
    saved_by_name = Column(String(200), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=True)
    published_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class PresentationAudit(Base):
    __tablename__ = "presentation_audit"
    __table_args__ = (Index("ix_presentation_audit_profile", "profile_id", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    profile_id = Column(UUID(as_uuid=True), ForeignKey("presentation_profiles.id", ondelete="CASCADE"), nullable=False)
    revision_id = Column(UUID(as_uuid=True), nullable=True)
    #: create / update / save / publish / pause / resume / archive / rollback / unarchive.
    action = Column(String(24), nullable=False)
    actor_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor_name = Column(String(200), nullable=True)
    before = Column(JSON, nullable=True)
    after = Column(JSON, nullable=True)
    reason = Column(String(300), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
