"""
"עסקאות שלא הושלמו" — payment attempts that failed on the terminal (docs/SPEC_FAILED_PAYMENTS.md).

A card declined, a payment cancelled on the terminal or by the cashier, a terminal that
did not answer (and was resolved as not charged), a terminal error, a card lock: none of
them issues a tax document, so no report used to show them. The till records each failed
or aborted attempt (one row per attempt = one terminal request / vuid; retries and lookups
of the same vuid update the same row) and pushes it through its outbox
(`POST /sync/{machine_id}/failed-payments`), idempotent by the till's id. When the same
basket is paid later, the till links the attempt to the paying document and re-sends it.

Informational only: never part of a sale, a shift's totals, a Z or any export. Of the card
only the last four digits and the brand are kept — never anything else of it.
"""
import uuid

from sqlalchemy import BigInteger, Column, Date, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: What became of an attempt (`outcome`), as the till sends it.
OUTCOMES = (
    "declined",
    "cancelled_terminal",
    "cancelled_cashier",
    "no_answer",
    "terminal_error",
    "card_locked",
)
#: `kind`: a sale, a keyed (manual card entry) sale, or money back to a card (a refund).
KIND_SALE = "sale"
KIND_KEYED = "keyed"
KIND_PAYOUT = "payout"
KINDS = (KIND_SALE, KIND_KEYED, KIND_PAYOUT)


class FailedPaymentAttempt(Base):
    """One failed or aborted payment attempt of a till. Client id; upserted by it."""

    __tablename__ = "failed_payment_attempts"
    __table_args__ = (
        Index("ix_failed_payment_attempts_tenant_occurred", "tenant_id", "occurred_at"),
        Index("ix_failed_payment_attempts_machine_occurred", "machine_id", "occurred_at"),
        Index("ix_failed_payment_attempts_shift", "shift_id"),
        Index("ix_failed_payment_attempts_transaction", "transaction_id"),
        Index("ix_failed_payment_attempts_paid_by", "paid_by_transaction_id"),
    )

    #: The till's own id of the attempt (stable: a re-send of the same attempt keeps it).
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    #: The till's shift id as it sent it; not a foreign key (the shift may land later).
    shift_id = Column(UUID(as_uuid=True), nullable=True)
    business_date = Column(Date, nullable=True)
    #: The till user (`pos_users.id` as the till sent it — free text, like
    #: `transactions.cashier_id`) and their name as the till had it.
    pos_user_id = Column(String(100), nullable=True)
    employee_name = Column(String(200), nullable=True)

    #: When the attempt started, and when its final outcome was settled.
    occurred_at = Column(DateTime(timezone=True), nullable=False)
    resolved_at = Column(DateTime(timezone=True), nullable=True)

    #: Integer agorot, always positive (a payout is told by `kind`, not by a sign).
    amount_agorot = Column(BigInteger, nullable=False)
    #: The tender's wire string: `card` today; `voucher` and others possible.
    method = Column(String(32), nullable=False, default="card", server_default="card")
    #: sale | keyed | payout (`KINDS`).
    kind = Column(String(32), nullable=False, default=KIND_SALE, server_default=KIND_SALE)
    #: till | kiosk.
    channel = Column(String(32), nullable=False, default="till", server_default="till")
    #: agamento | nayax_lan | zcredit | synqpay, and the terminal's number.
    terminal_type = Column(String(32), nullable=True)
    terminal_id = Column(String(64), nullable=True)

    #: `OUTCOMES`, and the terminal's own code and words (≤ 300 characters).
    outcome = Column(String(32), nullable=False)
    reason_code = Column(String(64), nullable=True)
    reason_message = Column(String(300), nullable=True)

    #: Of the card: its brand (`app.services.card_brands.BRANDS`) and last four digits only.
    card_brand = Column(String(16), nullable=True)
    card_last4 = Column(String(4), nullable=True)

    line_count = Column(Integer, nullable=True)
    vuid = Column(String(100), nullable=True)

    #: The pending document the till voided for this attempt — it reaches the cloud as a
    #: `cancelled` transaction with this id — when one was written. Not a foreign key: the
    #: two arrive in either order.
    transaction_id = Column(UUID(as_uuid=True), nullable=True)
    #: The document that eventually paid the same basket, its tender and when.
    paid_by_transaction_id = Column(UUID(as_uuid=True), nullable=True)
    paid_by_method = Column(String(16), nullable=True)
    paid_at = Column(DateTime(timezone=True), nullable=True)

    #: When the cloud first received it.
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: The row's last change ON THE TILL (`updatedAt`): an older re-send never overwrites
    #: a newer one.
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
