"""
"הפצה בוואטסאפ": prepaid vouchers ("שוברי הפקה") handed out over WhatsApp — the production
gives a list of phone numbers, every recipient gets a message with their own vouchers as a PDF
behind a personal link (app/services/voucher_distribution.py has the rules).

* `voucher_distributions` — one per batch: the message texts and the PDF's layout.
* `voucher_distribution_recipients` — a person (or, `kind = group`, one envelope sent to
  whoever leads it), their personal link (only its hash and its ciphertext are kept) and
  where the sending stands: pending / sent / delivered / read / failed, opened, downloaded.
  The phone number is personal data: encrypted at rest (the payment-secrets key, as the
  notification service), with a keyed hash for dedupe and search; erased (anonymised) on
  request once the batch is over.
* `voucher_distribution_assignments` — which voucher went to whom. One row per voucher, the
  voucher unique: a voucher belongs to one recipient at most. Unassigning deletes the row and
  is logged in the audit trail with the serials and the reason.
* `voucher_distribution_events` — the audit trail: imports, assignments, every send (who,
  when, how), every open of a link (when, from where), revokes, erasures. Never edited.
* `whatsapp_cloud_configs` — per company, the official WhatsApp Cloud API (optional, off by
  default): the phone number id, the template, and the access token / app secret encrypted.

Separate from the batch's own tables (app/models/prepaid_voucher.py) on purpose: sending is a
layer on top of the vouchers, never a change to what a voucher is worth or where it redeems.
"""
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: `voucher_distribution_recipients.kind`: a person, or one envelope (group) to whoever leads it.
RECIPIENT_KINDS = ("person", "group")
#: `voucher_distribution_recipients.status` — the delivery as far as it is known.
RECIPIENT_STATUSES = ("pending", "sent", "delivered", "read", "failed")
#: How a recipient was marked sent.
SENT_VIA = ("wa_link", "share", "manual", "download", "api")
#: `voucher_distribution_recipients.api_status` — the Cloud API queue (null: not sent by the API).
API_STATUSES = ("queued", "sending", "retry", "accepted", "failed")


class VoucherDistribution(Base):
    """A batch's sending settings: the messages (editable per batch) and the PDF's layout."""

    __tablename__ = "voucher_distributions"
    __table_args__ = (UniqueConstraint("batch_id", name="uq_voucher_distributions_batch"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    batch_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), nullable=False
    )
    #: The message to a person; placeholders {שם} {אירוע} {כמות} {מספרים} {קישור} {תוקף} {קבוצה}.
    #: Null: the default text.
    message_template = Column(Text, nullable=True)
    #: The message of a group send (no person's name). Null: the default text.
    group_message_template = Column(Text, nullable=True)
    #: The PDF's page: a print preset of app/services/prepaid_voucher_pdf.py (one voucher a
    #: page by default — A6 reads well on a phone).
    layout = Column(String(16), nullable=False, default="a6", server_default="a6")
    #: When the personal links stop working; null: the batch's validity end + 7 days.
    link_expires_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class VoucherDistributionRecipient(Base):
    __tablename__ = "voucher_distribution_recipients"
    __table_args__ = (
        CheckConstraint("kind IN ('person', 'group')", name="ck_voucher_distribution_recipients_kind"),
        CheckConstraint(
            "status IN ('pending', 'sent', 'delivered', 'read', 'failed')",
            name="ck_voucher_distribution_recipients_status",
        ),
        UniqueConstraint("token_hash", name="uq_voucher_distribution_recipients_token"),
        Index("ix_voucher_distribution_recipients_batch", "batch_id", "sort_order"),
        Index("ix_voucher_distribution_recipients_phone", "batch_id", "phone_hash"),
        Index("ix_voucher_distribution_recipients_api", "api_status", "api_next_attempt_at"),
        Index("ix_voucher_distribution_recipients_wamid", "api_message_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    batch_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), nullable=False
    )
    kind = Column(String(8), nullable=False, default="person", server_default="person")
    #: Optional; erased with the phone.
    name = Column(String(200), nullable=True)
    #: The WhatsApp number (E.164 digits, no "+"), encrypted; null for a group send with no
    #: number (shared by hand) and after an erasure.
    phone_ciphertext = Column(Text, nullable=True)
    #: Keyed hash of the E.164 number (app/services/notifications/crypto.py) — dedupe, search.
    phone_hash = Column(String(64), nullable=True)
    #: The group (envelope) this row was given, when imported by group.
    group_no = Column(Integer, nullable=True)
    #: The order of the list as it was imported.
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")

    # ── The personal link ────────────────────────────────────────────────────
    #: SHA-256 of the token (what a request is looked up by); the token itself is never stored
    #: in the clear — `token_ciphertext` lets the dashboard put it in a message again.
    token_hash = Column(String(64), nullable=True)
    token_ciphertext = Column(Text, nullable=True)
    token_issued_at = Column(DateTime(timezone=True), nullable=True)
    token_expires_at = Column(DateTime(timezone=True), nullable=True)
    token_revoked_at = Column(DateTime(timezone=True), nullable=True)
    #: Bumped on every re-issue (a link sent before stops working).
    token_version = Column(Integer, nullable=False, default=0, server_default="0")

    # ── Sending ──────────────────────────────────────────────────────────────
    status = Column(String(16), nullable=False, default="pending", server_default="pending")
    sent_at = Column(DateTime(timezone=True), nullable=True)
    sent_via = Column(String(16), nullable=True)
    sent_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    sent_by_name = Column(String(200), nullable=True)
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    read_at = Column(DateTime(timezone=True), nullable=True)
    failed_at = Column(DateTime(timezone=True), nullable=True)
    failure_reason = Column(String(300), nullable=True)
    #: The recipient opened the link (the page) / downloaded the PDF: first, last, how often.
    #: Link-preview robots (WhatsApp's own preview, crawlers) are logged but never count.
    opened_at = Column(DateTime(timezone=True), nullable=True)
    last_opened_at = Column(DateTime(timezone=True), nullable=True)
    open_count = Column(Integer, nullable=False, default=0, server_default="0")
    downloaded_at = Column(DateTime(timezone=True), nullable=True)
    download_count = Column(Integer, nullable=False, default=0, server_default="0")

    # ── The Cloud API (optional) ─────────────────────────────────────────────
    api_status = Column(String(16), nullable=True)
    #: WhatsApp's message id ("wamid.…") — what the status webhook names.
    api_message_id = Column(String(128), nullable=True)
    api_attempts = Column(Integer, nullable=False, default=0, server_default="0")
    api_next_attempt_at = Column(DateTime(timezone=True), nullable=True)
    api_lease_until = Column(DateTime(timezone=True), nullable=True)
    api_last_error = Column(String(300), nullable=True)

    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    #: Removed from the list (its link revoked, its vouchers freed). Kept for the audit trail.
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    #: The phone and the name erased (after the batch is over).
    anonymized_at = Column(DateTime(timezone=True), nullable=True)


class VoucherDistributionAssignment(Base):
    """A voucher given to a recipient. The voucher is unique: one recipient at most."""

    __tablename__ = "voucher_distribution_assignments"
    __table_args__ = (
        UniqueConstraint("voucher_id", name="uq_voucher_distribution_assignments_voucher"),
        Index("ix_voucher_distribution_assignments_recipient", "recipient_id", "serial"),
        Index("ix_voucher_distribution_assignments_batch", "batch_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    batch_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), nullable=False
    )
    recipient_id = Column(
        UUID(as_uuid=True), ForeignKey("voucher_distribution_recipients.id", ondelete="CASCADE"), nullable=False
    )
    voucher_id = Column(UUID(as_uuid=True), ForeignKey("prepaid_vouchers.id", ondelete="CASCADE"), nullable=False)
    #: The voucher's serial, for ordering without a join.
    serial = Column(Integer, nullable=False)
    assigned_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    assigned_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


#: `voucher_distribution_events.action`.
DISTRIBUTION_EVENT_ACTIONS = (
    "import",            # a list imported (mode, rows, skipped)
    "assign",            # vouchers given to a recipient (serials)
    "unassign",          # vouchers taken back (serials, reason)
    "settings",          # the messages / layout / link expiry changed
    "sent",              # marked sent (via: wa_link / share / manual / download)
    "unsent",            # the mark undone
    "dashboard_pdf",     # a user fetched the recipient's PDF in the dashboard
    "link_opened",       # the recipient opened the page
    "link_downloaded",   # the recipient downloaded the PDF
    "link_preview",      # a link-preview robot fetched it (not counted as opened)
    "link_denied",       # the link was used after it was revoked / expired
    "link_revoked",
    "link_reissued",
    "removed",           # taken off the list (link revoked, vouchers freed)
    "erased",            # phone and name erased
    "api_queued",
    "api_accepted",      # the Cloud API took the message (its id)
    "api_retry",
    "api_failed",
    "api_status",        # a status from the webhook (sent / delivered / read / failed)
)


class VoucherDistributionEvent(Base):
    """The distribution's audit trail: who did what to whom, and when. Never edited."""

    __tablename__ = "voucher_distribution_events"
    __table_args__ = (
        Index("ix_voucher_distribution_events_batch", "batch_id", "created_at"),
        Index("ix_voucher_distribution_events_recipient", "recipient_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    batch_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), nullable=False
    )
    #: Not a foreign key: the trail keeps naming the row whatever happens to it.
    recipient_id = Column(UUID(as_uuid=True), nullable=True)
    action = Column(String(32), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(200), nullable=True)
    details = Column(JSON, nullable=True)
    #: A public request's address and browser (the link's opens), cut short.
    ip = Column(String(64), nullable=True)
    user_agent = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class WhatsAppCloudConfig(Base):
    """
    A company's WhatsApp Cloud API (Meta's official API): a template message with the PDF as
    its document header, statuses by webhook. Off until configured and enabled — and the
    server's own switch (WHATSAPP_CLOUD_API_ENABLED) must be on for any request to leave.
    The access token and the app secret are write-only: encrypted here, never read back.
    """

    __tablename__ = "whatsapp_cloud_configs"
    __table_args__ = (UniqueConstraint("company_id", name="uq_whatsapp_cloud_configs_company"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    enabled = Column(Boolean, nullable=False, default=False, server_default="false")
    phone_number_id = Column(String(64), nullable=True)
    business_account_id = Column(String(64), nullable=True)
    template_name = Column(String(128), nullable=True)
    template_language = Column(String(16), nullable=False, default="he", server_default="he")
    #: The template body's variables in order ({{1}}, {{2}} …): keys of
    #: app/services/whatsapp_cloud.BODY_PARAM_KEYS. Null: ["name", "event"].
    body_params = Column(JSON, nullable=True)
    #: Graph API version ("v23.0"); null: the server's default.
    api_version = Column(String(16), nullable=True)
    access_token_ciphertext = Column(Text, nullable=True)
    #: Signs the webhook's requests (X-Hub-Signature-256); without it the webhook refuses all.
    app_secret_ciphertext = Column(Text, nullable=True)
    #: What Meta echoes back when the webhook is subscribed (generated here, shown to set up).
    verify_token_ciphertext = Column(Text, nullable=True)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
