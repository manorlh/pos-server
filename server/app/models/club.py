"""
The customer club ("מועדון לקוחות", docs/SPEC_NOTIFICATIONS_CLUB.md part ג).

Scope: one club per **company** (`ClubProgram.company_id`), usable in that company's
shops and in the shops of its subsidiaries. Every row carries `tenant_id` and
`company_id`; nothing is shared between companies or tenants.

**Why a separate `ClubCustomer` and not `customers`.** `customers` are the tax-invoice
customers (name, ח.פ., address) and are synced *in full* to every till of the tenant. A
club member is a private person identified by a phone number; shipping every member's
phone to every till would break the data-minimisation rule (§26/§32: the till looks a
member up, it never holds the list). `ClubCustomer.tax_customer_id` can link the two.

* `ClubCustomer` — the person (Customer). May exist without a membership.
* `ClubMembership` — the club relationship (Membership), its status and the member's
  opaque QR token.
* `ClubConsentEvent` — append-only consent history, each with the document version and
  the exact text shown.
* `ClubSuppression` — a number that must not receive a category (opt-out, provider
  blacklist). Checked again at send time.
* `ClubOtpChallenge` — a locally managed OTP: only a keyed hash of the code is stored.
* `ClubLandingPage`, `ClubDocumentVersion`, `ClubSourceToken` — the public sign-up page,
  its versioned terms / privacy / consent texts, and the opaque QR source tokens.
* `ClubBenefitGrant` — the one sign-up benefit (unique key). Redemption is P1.
* `ClubSaleLink` — the customer and membership a sale was made for.
* `ClubAuditEvent` — who looked up / revealed / changed what (no personal data inside).
* `ClubPointsLedger`, `ClubRedemptionReservation` — **P1 models only**: nothing writes
  them in P0.
"""
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

MEMBERSHIP_PENDING = "pending_phone_verification"
MEMBERSHIP_ACTIVE = "active"
MEMBERSHIP_SUSPENDED = "suspended"
MEMBERSHIP_CLOSED = "closed"
MEMBERSHIP_STATUSES = (MEMBERSHIP_PENDING, MEMBERSHIP_ACTIVE, MEMBERSHIP_SUSPENDED, MEMBERSHIP_CLOSED)

DOC_TERMS = "terms"
DOC_PRIVACY = "privacy"
DOC_MARKETING_SMS = "marketing_sms"
DOC_MARKETING_EMAIL = "marketing_email"
DOC_KINDS = (DOC_TERMS, DOC_PRIVACY, DOC_MARKETING_SMS, DOC_MARKETING_EMAIL)

OTP_PENDING = "pending"
OTP_VERIFIED = "verified"
OTP_REGISTERED = "registered"
OTP_EXPIRED = "expired"
OTP_LOCKED = "locked"
OTP_INVALIDATED = "invalidated"


class ClubProgram(Base):
    __tablename__ = "club_programs"
    __table_args__ = (UniqueConstraint("company_id", name="uq_club_programs_company"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False)
    name = Column(String(120), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    #: Next member number (shown to the member; not a secret, not a key to anything).
    next_member_number = Column(Integer, nullable=False, default=1001, server_default="1001")
    settings = Column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ClubDocumentVersion(Base):
    """Terms / privacy policy / consent wording — one row per published version."""

    __tablename__ = "club_document_versions"
    __table_args__ = (UniqueConstraint("club_id", "kind", "version", name="uq_club_document_versions"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    club_id = Column(UUID(as_uuid=True), ForeignKey("club_programs.id", ondelete="CASCADE"), nullable=False)
    kind = Column(String(20), nullable=False)
    version = Column(Integer, nullable=False)
    #: draft | active | archived — one active per (club, kind).
    status = Column(String(10), nullable=False, default="draft", server_default="draft")
    title = Column(String(200), nullable=False)
    #: The text shown (a consent label, or the document itself).
    body = Column(Text, nullable=False)
    #: Optional link to the full document hosted by the business.
    url = Column(String(500), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ClubLandingPage(Base):
    __tablename__ = "club_landing_pages"
    __table_args__ = (UniqueConstraint("club_id", name="uq_club_landing_pages_club"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False)
    club_id = Column(UUID(as_uuid=True), ForeignKey("club_programs.id", ondelete="CASCADE"), nullable=False)
    is_published = Column(Boolean, nullable=False, default=False, server_default="false")
    business_name = Column(String(120), nullable=True)
    logo_url = Column(String(500), nullable=True)
    headline = Column(String(120), nullable=True)
    intro = Column(String(500), nullable=True)
    #: Real benefits, as the business wrote them: ["10% הנחה בכל קנייה", …]. Empty = none shown.
    benefits = Column(JSONB, nullable=False, default=list, server_default="[]")
    email_enabled = Column(Boolean, nullable=False, default=False, server_default="false")
    birthday_enabled = Column(Boolean, nullable=False, default=False, server_default="false")
    last_name_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    #: The one sign-up benefit (if any) granted on registration.
    signup_benefit_enabled = Column(Boolean, nullable=False, default=False, server_default="false")
    signup_benefit_title = Column(String(120), nullable=True)
    signup_benefit_valid_days = Column(Integer, nullable=True)
    success_message = Column(String(300), nullable=True)
    updated_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ClubSourceToken(Base):
    """The opaque token in a sign-up QR (receipt / till / kiosk / poster)."""

    __tablename__ = "club_source_tokens"
    __table_args__ = (UniqueConstraint("token", name="uq_club_source_tokens_token"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False)
    club_id = Column(UUID(as_uuid=True), ForeignKey("club_programs.id", ondelete="CASCADE"), nullable=False)
    token = Column(String(64), nullable=False)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    #: receipt | till | kiosk | poster | link
    source_kind = Column(String(16), nullable=False, default="link", server_default="link")
    label = Column(String(120), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ClubCustomer(Base):
    __tablename__ = "club_customers"
    __table_args__ = (
        # The normalised phone is unique inside the club's company, not system-wide.
        UniqueConstraint("tenant_id", "company_id", "phone_hash", name="uq_club_customers_phone"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    first_name = Column(String(60), nullable=False)
    last_name = Column(String(60), nullable=True)
    #: E.164, encrypted at rest; `phone_hash` is the keyed lookup hash.
    phone_ciphertext = Column(Text, nullable=False)
    phone_hash = Column(String(64), nullable=False)
    phone_masked = Column(String(32), nullable=False)
    phone_verified_at = Column(DateTime(timezone=True), nullable=True)
    email = Column(String(200), nullable=True)
    birth_day = Column(SmallInteger, nullable=True)
    birth_month = Column(SmallInteger, nullable=True)
    language = Column(String(8), nullable=False, default="he", server_default="he")
    source_shop_id = Column(UUID(as_uuid=True), nullable=True)
    signup_source = Column(String(16), nullable=True)
    tax_customer_id = Column(UUID(as_uuid=True), ForeignKey("customers.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ClubMembership(Base):
    __tablename__ = "club_memberships"
    __table_args__ = (
        UniqueConstraint("club_id", "customer_id", name="uq_club_memberships_customer"),
        UniqueConstraint("qr_token", name="uq_club_memberships_qr_token"),
        UniqueConstraint("club_id", "member_number", name="uq_club_memberships_number"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    club_id = Column(UUID(as_uuid=True), ForeignKey("club_programs.id"), nullable=False)
    customer_id = Column(UUID(as_uuid=True), ForeignKey("club_customers.id"), nullable=False, index=True)
    member_number = Column(Integer, nullable=False)
    status = Column(String(32), nullable=False, default=MEMBERSHIP_PENDING, server_default=MEMBERSHIP_PENDING)
    status_reason = Column(String(200), nullable=True)
    #: Opaque, random: what the member's QR carries for a lookup at the till. It is not
    #: a key to the member's data nor an authority to redeem anything (§24).
    qr_token = Column(String(64), nullable=False)
    #: Opaque, random: the unsubscribe link's token (marketing opt-out only).
    unsubscribe_token = Column(String(64), nullable=False, unique=True)
    source_token_id = Column(UUID(as_uuid=True), nullable=True)
    source_shop_id = Column(UUID(as_uuid=True), nullable=True)
    joined_at = Column(DateTime(timezone=True), nullable=True)
    status_changed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ClubConsentEvent(Base):
    """Append-only. The current consent is the latest event per (customer, kind)."""

    __tablename__ = "club_consent_events"
    __table_args__ = (
        Index("ix_club_consent_events_customer", "customer_id", "kind", "occurred_at"),
        UniqueConstraint("idempotency_key", name="uq_club_consent_events_idem"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False)
    customer_id = Column(UUID(as_uuid=True), ForeignKey("club_customers.id"), nullable=False)
    membership_id = Column(UUID(as_uuid=True), nullable=True)
    #: terms | privacy | marketing_sms | marketing_email
    kind = Column(String(20), nullable=False)
    granted = Column(Boolean, nullable=False)
    document_version_id = Column(UUID(as_uuid=True), nullable=True)
    document_version = Column(Integer, nullable=True)
    #: The exact wording the person saw when choosing.
    text_snapshot = Column(Text, nullable=True)
    #: landing | till | dashboard | unsubscribe_link | provider
    source = Column(String(20), nullable=False)
    source_token_id = Column(UUID(as_uuid=True), nullable=True)
    actor_user_id = Column(UUID(as_uuid=True), nullable=True)
    ip_hash = Column(String(64), nullable=True)
    idempotency_key = Column(String(120), nullable=True)
    occurred_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ClubSuppression(Base):
    __tablename__ = "club_suppressions"
    __table_args__ = (
        Index("ix_club_suppressions_lookup", "tenant_id", "phone_hash", "channel"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    #: The club's company; null = the whole tenant.
    company_id = Column(UUID(as_uuid=True), nullable=True)
    phone_hash = Column(String(64), nullable=False)
    channel = Column(String(8), nullable=False, default="sms", server_default="sms")
    #: "marketing" (opt-out) or "all" (a provider block that also stops service SMS).
    scope = Column(String(12), nullable=False, default="marketing", server_default="marketing")
    #: unsubscribe | provider_blacklist | manual
    reason = Column(String(24), nullable=False)
    source = Column(String(24), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    lifted_at = Column(DateTime(timezone=True), nullable=True)
    lifted_by = Column(UUID(as_uuid=True), nullable=True)


class ClubOtpChallenge(Base):
    __tablename__ = "club_otp_challenges"
    __table_args__ = (
        Index("ix_club_otp_challenges_phone", "tenant_id", "phone_hash", "created_at"),
        Index("ix_club_otp_challenges_ip", "ip_hash", "created_at"),
        Index("ix_club_otp_challenges_session", "session_hash"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False)
    company_id = Column(UUID(as_uuid=True), nullable=False)
    club_id = Column(UUID(as_uuid=True), nullable=False)
    source_token_id = Column(UUID(as_uuid=True), nullable=True)
    #: What the code is for — a code for one purpose is never accepted for another.
    purpose = Column(String(24), nullable=False, default="club_signup", server_default="club_signup")
    phone_hash = Column(String(64), nullable=False)
    #: Kept only to (re)send the code; wiped once the challenge is finished.
    phone_ciphertext = Column(Text, nullable=True)
    #: Keyed hash of the browser session this challenge is bound to.
    session_hash = Column(String(64), nullable=False)
    #: Keyed hash of (challenge id, code). Never the code.
    code_hash = Column(String(64), nullable=False)
    status = Column(String(12), nullable=False, default=OTP_PENDING, server_default=OTP_PENDING)
    attempts = Column(Integer, nullable=False, default=0, server_default="0")
    max_attempts = Column(Integer, nullable=False, default=5, server_default="5")
    send_count = Column(Integer, nullable=False, default=1, server_default="1")
    expires_at = Column(DateTime(timezone=True), nullable=False)
    last_sent_at = Column(DateTime(timezone=True), nullable=False)
    verified_at = Column(DateTime(timezone=True), nullable=True)
    #: Keyed hash of the one-time token that lets the verified session register once.
    registration_token_hash = Column(String(64), nullable=True)
    registration_expires_at = Column(DateTime(timezone=True), nullable=True)
    registered_at = Column(DateTime(timezone=True), nullable=True)
    ip_hash = Column(String(64), nullable=True)
    notification_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ClubBenefitGrant(Base):
    __tablename__ = "club_benefit_grants"
    __table_args__ = (UniqueConstraint("unique_key", name="uq_club_benefit_grants_key"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), nullable=False)
    club_id = Column(UUID(as_uuid=True), nullable=False)
    membership_id = Column(UUID(as_uuid=True), ForeignKey("club_memberships.id"), nullable=False, index=True)
    customer_id = Column(UUID(as_uuid=True), nullable=False)
    #: signup | birthday (P2) | manual (P1)
    kind = Column(String(16), nullable=False)
    title = Column(String(120), nullable=False)
    #: available | reserved (P1) | redeemed (P1) | expired | void
    status = Column(String(12), nullable=False, default="available", server_default="available")
    valid_until = Column(DateTime(timezone=True), nullable=True)
    unique_key = Column(String(160), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ClubSaleLink(Base):
    """The club member a sale was made for (one per document)."""

    __tablename__ = "club_sale_links"
    __table_args__ = (UniqueConstraint("transaction_id", name="uq_club_sale_links_tx"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    transaction_id = Column(UUID(as_uuid=True), ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False)
    customer_id = Column(UUID(as_uuid=True), ForeignKey("club_customers.id"), nullable=False, index=True)
    membership_id = Column(UUID(as_uuid=True), ForeignKey("club_memberships.id"), nullable=False, index=True)
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    #: The benefit / earn rules applied to the sale (P0: none — `{}`).
    rules_snapshot = Column(JSONB, nullable=False, default=dict, server_default="{}")
    linked_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ClubAuditEvent(Base):
    """Who did what to a member / a message. Ids and codes only — no phone, no text."""

    __tablename__ = "club_audit_events"
    __table_args__ = (Index("ix_club_audit_events_subject", "tenant_id", "subject_type", "subject_id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    #: club | notifications
    domain = Column(String(16), nullable=False)
    #: membership | customer | notification | provider_config | template
    subject_type = Column(String(24), nullable=False)
    subject_id = Column(UUID(as_uuid=True), nullable=True)
    #: registered | lookup | phone_revealed | consent_changed | status_changed | resend | …
    action = Column(String(32), nullable=False)
    actor_user_id = Column(UUID(as_uuid=True), nullable=True)
    actor_machine_id = Column(UUID(as_uuid=True), nullable=True)
    reason = Column(String(200), nullable=True)
    details = Column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


# ── P1 models (no writer in P0) ──────────────────────────────────────────────


class ClubPointsLedger(Base):
    """P1: append-only points movements; the balance is derived from them."""

    __tablename__ = "club_points_ledger"
    __table_args__ = (
        UniqueConstraint("unique_key", name="uq_club_points_ledger_key"),
        Index("ix_club_points_ledger_member", "membership_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    membership_id = Column(UUID(as_uuid=True), ForeignKey("club_memberships.id"), nullable=False)
    #: earn | redeem | reverse | expire | adjust
    kind = Column(String(10), nullable=False)
    points = Column(Numeric(12, 2), nullable=False)
    transaction_id = Column(UUID(as_uuid=True), nullable=True)
    rule_version = Column(Integer, nullable=True)
    reverses_id = Column(UUID(as_uuid=True), nullable=True)
    reason = Column(String(200), nullable=True)
    actor_user_id = Column(UUID(as_uuid=True), nullable=True)
    unique_key = Column(String(160), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ClubRedemptionReservation(Base):
    """P1: an atomic hold on a grant / points while a sale is being paid."""

    __tablename__ = "club_redemption_reservations"
    __table_args__ = (UniqueConstraint("unique_key", name="uq_club_redemption_reservations_key"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    membership_id = Column(UUID(as_uuid=True), ForeignKey("club_memberships.id"), nullable=False)
    grant_id = Column(UUID(as_uuid=True), nullable=True)
    points = Column(Numeric(12, 2), nullable=True)
    #: reserved | committed | released | expired
    status = Column(String(10), nullable=False, default="reserved", server_default="reserved")
    transaction_ref = Column(String(100), nullable=True)
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    unique_key = Column(String(160), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
