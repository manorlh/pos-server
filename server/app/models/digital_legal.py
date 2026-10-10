"""
"משפטי ונגישות" — the legal pages and consent records of the public digital channels (digital menu,
online ordering, business cards). P:\\specs\\digital-menu-ordering-cards-plan.md §17; owner spec §21.

* `LegalDocument` — one row per version of a business's legal page: the accessibility statement
  ("הצהרת נגישות"), the privacy policy, the terms of use and ordering ("תקנון") and the cookie
  policy. A company writes them; a shop may override any of them. A version is a draft until the
  business confirms "נבדק" and publishes it; a published version never changes (the next edit is a
  new draft). The public pages read only published versions. In the pattern of
  `club_document_versions`.
* `CookieConsentRecord` — the cookie banner's log: an anonymous visitor id (only its keyed hash),
  the cookie policy version shown, the choices per category, grant / update / revoke, and when.
  Append-only.
* `MarketingConsentRecord` — "דיוור שיווקי" consent (חוק התקשורת §30א) given on the ordering
  checkout or an enquiry form: the contact only as a keyed hash, the exact text shown and its
  version, granted or withdrawn. Append-only, and deliberately separate from transactional
  messages ("ההזמנה מוכנה" never reads it).
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

KIND_ACCESSIBILITY = "accessibility"
KIND_PRIVACY = "privacy"
KIND_TERMS = "terms"
KIND_COOKIES = "cookies"
LEGAL_KINDS = (KIND_ACCESSIBILITY, KIND_PRIVACY, KIND_TERMS, KIND_COOKIES)

STATUS_DRAFT = "draft"
STATUS_PUBLISHED = "published"
STATUS_ARCHIVED = "archived"

#: `scope_key` of a company-level document (a shop's override carries the shop id).
COMPANY_SCOPE = "company"
#: A draft's `version` (the number is given at publication): one draft per scope, kind and language.
DRAFT_VERSION = 0


class LegalDocument(Base):
    __tablename__ = "legal_documents"
    __table_args__ = (
        UniqueConstraint("company_id", "scope_key", "kind", "lang", "version", name="uq_legal_documents_version"),
        Index("ix_legal_documents_lookup", "company_id", "kind", "lang", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False)
    #: NULL = the company's own document; a shop id = that shop's override.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    #: "company" or the shop id — so the unique key also holds for company rows (NULL ≠ NULL).
    scope_key = Column(String(40), nullable=False)
    kind = Column(String(20), nullable=False)
    lang = Column(String(8), nullable=False, default="he", server_default="he")
    #: 0 while a draft; 1, 2, … from publication.
    version = Column(Integer, nullable=False, default=DRAFT_VERSION, server_default="0")
    #: draft | published | archived — one published per (scope, kind, lang).
    status = Column(String(12), nullable=False, default=STATUS_DRAFT, server_default=STATUS_DRAFT)
    title = Column(String(200), nullable=False)
    #: Limited markdown with `{{field}}` placeholders (app/services/digital_legal/templates.py).
    body = Column(Text, nullable=False)
    #: The structured values the placeholders take (coordinator, dates, business identity…).
    fields = Column(JSONB, nullable=False, default=dict, server_default="{}")
    #: The template this draft started from, and that template's version.
    template_key = Column(String(40), nullable=True)
    template_version = Column(Integer, nullable=True)
    #: Optimistic concurrency of the draft: each save sends the number it read.
    edit_seq = Column(Integer, nullable=False, default=0, server_default="0")
    #: "נבדק" — the business confirmed a review (by its lawyer) before publication.
    reviewed = Column(Boolean, nullable=False, default=False, server_default="false")
    reviewed_by = Column(UUID(as_uuid=True), nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    review_note = Column(String(300), nullable=True)
    published_by = Column(UUID(as_uuid=True), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    updated_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class CookieConsentRecord(Base):
    __tablename__ = "cookie_consent_records"
    __table_args__ = (Index("ix_cookie_consent_records_visitor", "company_id", "anon_hash", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False)
    #: Keyed hash of the visitor's random id (the id itself is never stored).
    anon_hash = Column(String(64), nullable=False)
    #: The published cookie policy version the banner showed (0 = none published).
    policy_version = Column(Integer, nullable=False, default=0, server_default="0")
    #: {"essential": true, "analytics": bool, "marketing": bool}
    choices = Column(JSONB, nullable=False, default=dict, server_default="{}")
    #: grant | update | revoke
    action = Column(String(10), nullable=False)
    #: Where the choice was made: menu | online | card | legal | other.
    surface = Column(String(12), nullable=False, default="other", server_default="other")
    ip_hash = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class MarketingConsentRecord(Base):
    __tablename__ = "marketing_consent_records"
    __table_args__ = (Index("ix_marketing_consent_subject", "company_id", "channel", "subject_hash", "occurred_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    #: sms | email | whatsapp — consent is per channel.
    channel = Column(String(10), nullable=False)
    #: phone | email — what `subject_hash` is a keyed hash of.
    subject_kind = Column(String(8), nullable=False)
    subject_hash = Column(String(64), nullable=False)
    granted = Column(Boolean, nullable=False)
    #: The exact text next to the box, and its version.
    text_snapshot = Column(Text, nullable=False)
    text_version = Column(String(20), nullable=False)
    #: checkout | enquiry | dashboard | unsubscribe
    source = Column(String(12), nullable=False)
    #: The order / enquiry this came with (opaque, for the audit trail).
    source_ref = Column(String(80), nullable=True)
    ip_hash = Column(String(64), nullable=True)
    actor_user_id = Column(UUID(as_uuid=True), nullable=True)
    occurred_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
