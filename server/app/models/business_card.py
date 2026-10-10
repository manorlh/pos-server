"""
"כרטיסי ביקור דיגיטליים" (spec §25–28; app/services/business_cards.py).

* `BusinessCard` — one card: its target in the organisation (company / branch = shop / sales
  point = shop area / a person), its working draft (autosaved, optimistic `draft_version`), the
  revision the public link shows, and its lifecycle (draft → saved → published ⇄ paused,
  archived). Never deleted: QR codes in the wild keep resolving to a neutral answer.
* `BusinessCardRevision` — an immutable snapshot of the document: `saved` (an explicit save)
  or `published`. Publishing points the card at a revision; rollback publishes an older one.
* `BusinessCardSlug` — every public path a card ever had. The live one has `retired_at` NULL;
  a renamed path stays and redirects to the card's current one, and is never handed to another
  card (an old printed QR must not open someone else's card).
* `BusinessCardEnquiry` (`card_enquiries`, the plan's name) — the enquiry form's submissions,
  stored here (there is no CRM yet): "נשמר" is answered only after this row is committed. Contact details are as the visitor typed
  them; the IP is kept only as a keyed hash, for rate limiting.
* `BusinessCardDailyStat` — first-party, cookie-free counters per card and day (views, action
  clicks, shares, VCF downloads, enquiries). A click is not proof the call / message happened.
* `BusinessCardAuditEvent` — who did what to a card, with before/after where it matters.
"""
import uuid

from sqlalchemy import (
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

CARD_TYPES = ("company", "branch", "point", "personal")
CARD_STATUSES = ("draft", "saved", "published", "paused", "archived")
REVISION_KINDS = ("saved", "published")
ENQUIRY_STATUSES = ("new", "handled", "archived")


class BusinessCard(Base):
    __tablename__ = "business_cards"
    __table_args__ = (
        Index("ix_business_cards_tenant_status", "tenant_id", "status"),
        Index("ix_business_cards_shop", "shop_id"),
        Index("ix_business_cards_company", "company_id"),
        UniqueConstraint("slug", name="uq_business_cards_slug"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    #: The organisation target: a company card has only `company_id`; a branch card also `shop_id`;
    #: a sales-point card also `area_id`; a personal card belongs to a company or a branch.
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id", ondelete="SET NULL"), nullable=True)
    #: company | branch | point | personal
    card_type = Column(String(16), nullable=False)
    #: Internal name (lists, search); the public title is a field of the document.
    name = Column(String(160), nullable=False)
    #: The live public path `/c/<slug>` (also in business_card_slugs, with its history).
    slug = Column(String(64), nullable=False)
    #: draft | saved | published | paused | archived
    status = Column(String(16), nullable=False, default="draft", server_default="draft")
    #: The card this one inherits from (company → branch → point; a person from either).
    parent_card_id = Column(UUID(as_uuid=True), ForeignKey("business_cards.id", ondelete="SET NULL"), nullable=True)
    #: A personal card's staff member (reassignable; leaving staff → reassign / pause / archive).
    owner_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    #: The working document (client/src/lib/businessCards.ts `CardDoc`), autosaved.
    draft = Column(JSONB, nullable=False, default=dict, server_default="{}")
    #: Optimistic concurrency for the draft: every write must name the version it edited.
    draft_version = Column(Integer, nullable=False, default=1, server_default="1")
    draft_updated_at = Column(DateTime(timezone=True), nullable=True)
    draft_updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    #: The revision the public link shows (no foreign key: revisions point at cards, and a
    #: cycle of keys would need ALTERs the SQLite test worlds cannot do).
    published_revision_id = Column(UUID(as_uuid=True), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=True)
    paused_at = Column(DateTime(timezone=True), nullable=True)
    archived_at = Column(DateTime(timezone=True), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class BusinessCardRevision(Base):
    __tablename__ = "business_card_revisions"
    __table_args__ = (UniqueConstraint("card_id", "number", name="uq_business_card_revisions_number"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    card_id = Column(UUID(as_uuid=True), ForeignKey("business_cards.id", ondelete="CASCADE"), nullable=False, index=True)
    #: 1, 2, 3… per card.
    number = Column(Integer, nullable=False)
    #: saved | published (a published one was, at some point, what the public link showed).
    kind = Column(String(16), nullable=False)
    content = Column(JSONB, nullable=False)
    #: sha256 of the canonical JSON — "has unpublished changes" is a hash comparison.
    content_hash = Column(String(64), nullable=False)
    note = Column(String(300), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    published_at = Column(DateTime(timezone=True), nullable=True)


class BusinessCardSlug(Base):
    __tablename__ = "business_card_slugs"

    slug = Column(String(64), primary_key=True)
    card_id = Column(UUID(as_uuid=True), ForeignKey("business_cards.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: NULL = the card's live path; set = an old path that redirects to the live one.
    retired_at = Column(DateTime(timezone=True), nullable=True)


class BusinessCardEnquiry(Base):
    __tablename__ = "card_enquiries"
    __table_args__ = (
        # The same submission (double tap, retry after a lost answer) is stored once.
        UniqueConstraint("card_id", "submission_id", name="uq_card_enquiries_submission"),
        Index("ix_card_enquiries_card_created", "card_id", "created_at"),
        Index("ix_card_enquiries_tenant_status", "tenant_id", "status"),
        Index("ix_card_enquiries_dedupe", "card_id", "dedupe_key", "created_at"),
        Index("ix_card_enquiries_ip", "card_id", "ip_hash", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    card_id = Column(UUID(as_uuid=True), ForeignKey("business_cards.id", ondelete="CASCADE"), nullable=False)
    #: The published revision the visitor filled the form on.
    revision_id = Column(UUID(as_uuid=True), ForeignKey("business_card_revisions.id", ondelete="SET NULL"), nullable=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    #: The browser's id for this submission (a retry sends the same one).
    submission_id = Column(String(64), nullable=False)
    name = Column(String(120), nullable=True)
    #: E.164, as normalised by app/services/notifications/phone.py.
    phone = Column(String(20), nullable=True)
    email = Column(String(254), nullable=True)
    topic = Column(String(120), nullable=True)
    message = Column(Text, nullable=True)
    lang = Column(String(8), nullable=True)
    #: qr | link | share | … (the `src` query parameter), and the card's / link's campaign.
    source = Column(String(32), nullable=True)
    campaign = Column(String(60), nullable=True)
    #: The privacy policy the visitor accepted, as shown (URL) — the consent record.
    consent_privacy_url = Column(String(500), nullable=True)
    consent_text = Column(String(300), nullable=True)
    consented_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: Keyed hash of contact + message: the same enquiry again within a day is a duplicate.
    dedupe_key = Column(String(64), nullable=False)
    #: Keyed hash of the IP, for rate limiting only.
    ip_hash = Column(String(64), nullable=True)
    #: new | handled | archived (the dashboard inbox).
    status = Column(String(16), nullable=False, default="new", server_default="new")
    #: Where the enquiry lives: "internal" (this table; no CRM is connected).
    delivery = Column(String(16), nullable=False, default="internal", server_default="internal")
    handled_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    handled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class BusinessCardDailyStat(Base):
    __tablename__ = "business_card_daily_stats"

    card_id = Column(UUID(as_uuid=True), ForeignKey("business_cards.id", ondelete="CASCADE"), primary_key=True)
    day = Column(Date, primary_key=True)
    #: view | action | share | copy_link | vcf | enquiry
    metric = Column(String(24), primary_key=True)
    #: The action type for `action`, "" otherwise.
    dimension = Column(String(32), primary_key=True, default="", server_default="")
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    count = Column(Integer, nullable=False, default=0, server_default="0")


class BusinessCardAuditEvent(Base):
    __tablename__ = "business_card_audit_events"
    __table_args__ = (Index("ix_business_card_audit_card", "card_id", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    card_id = Column(UUID(as_uuid=True), ForeignKey("business_cards.id", ondelete="CASCADE"), nullable=False)
    actor_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    #: create | save | publish | pause | resume | archive | restore | slug | rollback | duplicate | meta | enquiry
    action = Column(String(24), nullable=False)
    revision_number = Column(Integer, nullable=True)
    details = Column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
