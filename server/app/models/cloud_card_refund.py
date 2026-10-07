"""
"זיכוי באשראי מהענן (Z-Credit)" — a card refund the cloud makes through Z-Credit's web API for
a sale charged on Z-Credit (docs/SPEC_REMOTE_CREDIT.md §11).

The owner (07.10.2026): "אפשר לזכות אשראי מהענן עם Z-Credit, כי הם Web — בהנחה שיש בסניף
Z-Credit; בסניף יכול להיות גם וגם".

The cloud moves the money; it never issues the fiscal document. Once the gateway says the card
was refunded, the cloud asks a till for the credit note through the remote-credit path (mode
`card_refunded`, `remote_credit_requests.card_refund_id`): the till issues it in its own series,
in its open shift, with the refund as its card tender — so the document lands in that till's
shift / X / Z by its Z mode, like every other document.

* `cloud_card_refunds` — one row per refund; its `id` is the dashboard's request id (a double
  submit is one refund). Written **before** the gateway is called and finished after, so a
  crash between the two leaves a row that is resolved by a status query — never a second refund.
* `cloud_card_refund_events` — the audit trail: who did what, when and why.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class CloudCardRefundStatus:
    #: The row exists; the gateway is being (or is about to be) called. A row left here
    #: past the refund's timeout is a crash: resolved like an unknown outcome.
    IN_FLIGHT = "in_flight"
    #: The gateway refunded (or voided) the card — by its answer, by a status query, or as
    #: an operator recorded after checking. Money moved; the credit note must follow.
    REFUNDED = "refunded"
    #: Nothing moved: the gateway said no, the checks before the call refused, or the status
    #: query (or an operator) found that the refund never happened.
    DECLINED = "declined"
    #: The refund may have reached the gateway and no answer came back. Only a status query
    #: or an operator moves it on; it is never sent again.
    UNKNOWN = "unknown"


CARD_REFUND_STATUSES = (
    CloudCardRefundStatus.IN_FLIGHT,
    CloudCardRefundStatus.REFUNDED,
    CloudCardRefundStatus.DECLINED,
    CloudCardRefundStatus.UNKNOWN,
)
#: Statuses whose money may be gone: they hold the original's quantities and the leg's amount.
HOLDING_CARD_REFUND_STATUSES = (
    CloudCardRefundStatus.IN_FLIGHT,
    CloudCardRefundStatus.UNKNOWN,
    CloudCardRefundStatus.REFUNDED,
)


class CloudCardRefund(Base):
    __tablename__ = "cloud_card_refunds"
    __table_args__ = (
        Index("ix_cloud_card_refunds_original", "original_transaction_id"),
        Index("ix_cloud_card_refunds_payment", "original_payment_id"),
        Index("ix_cloud_card_refunds_tenant_created", "tenant_id", "created_at"),
        Index("ix_cloud_card_refunds_status", "status"),
    )

    #: The dashboard's request id: the same id is the same refund, whatever is sent again.
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    #: The original's shop and till (the till whose Z-Credit settings refund it).
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    original_machine_id = Column(UUID(as_uuid=True), nullable=True)

    #: The sale and its card leg (not foreign keys, like `remote_credit_requests`).
    original_transaction_id = Column(UUID(as_uuid=True), nullable=False)
    original_payment_id = Column(UUID(as_uuid=True), nullable=False)
    original_document_number = Column(String(40), nullable=True)
    original_document_type = Column(Integer, nullable=True)
    #: The leg as charged: its amount, the card's last four digits and brand.
    original_leg_amount = Column(Numeric(12, 2), nullable=False)
    card_last4 = Column(String(4), nullable=True)
    card_brand = Column(String(16), nullable=True)
    card_acquirer = Column(String(16), nullable=True)
    card_issuer = Column(String(16), nullable=True)

    #: `zcredit` — the only provider a cloud refund is made through.
    provider = Column(String(16), nullable=False, default="zcredit")
    #: The terminal refunded on, and the layer its password came from (tenant … machine).
    terminal_number = Column(String(20), nullable=True)
    credential_source = Column(String(16), nullable=True)
    #: The sale's gateway reference (`ReferenceNumber`) — what RefundTransaction takes.
    original_reference = Column(String(64), nullable=False)

    #: What is refunded: the lines (the remote credit's shape) and their money.
    full_credit = Column(Boolean, nullable=False, default=False, server_default="false")
    lines = Column(JSONB, nullable=False, default=list)
    amount = Column(Numeric(12, 2), nullable=False)
    reason_code = Column(String(32), nullable=True)
    reason = Column(Text, nullable=False)
    #: The till asked to issue the credit note (the latest ask; see `remote_credit_request_id`).
    target_machine_id = Column(UUID(as_uuid=True), nullable=False)

    #: `CloudCardRefundStatus`.
    status = Column(String(16), nullable=False, default=CloudCardRefundStatus.IN_FLIGHT)
    #: Why it is declined / unknown: our code (`already_refunded_at_gateway`, `no_reply`…).
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)

    #: The sale's state at the gateway before the refund (StatusCode), and after a query.
    before_status_code = Column(Integer, nullable=True)
    after_status_code = Column(Integer, nullable=True)
    #: The gateway's answer to the refund.
    return_code = Column(Integer, nullable=True)
    return_message = Column(Text, nullable=True)
    refund_reference = Column(String(64), nullable=True)
    approval_number = Column(String(32), nullable=True)
    voucher_number = Column(String(32), nullable=True)
    #: Refunded before the sale was deposited: the gateway voided it (StatusCode 3).
    voided = Column(Boolean, nullable=False, default=False, server_default="false")
    #: `gateway` (its answer), `status_query`, `manual` (an operator, after checking).
    resolved_by = Column(String(16), nullable=True)
    resolved_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    resolution_note = Column(Text, nullable=True)

    #: The call: the row committed (`attempt_started_at`), the refund request about to go
    #: out (`refund_sent_at` — null means it surely never left), the answer or the give-up.
    attempt_started_at = Column(DateTime(timezone=True), nullable=True)
    refund_sent_at = Column(DateTime(timezone=True), nullable=True)
    attempt_finished_at = Column(DateTime(timezone=True), nullable=True)
    query_count = Column(Integer, nullable=False, default=0, server_default="0")
    last_query_at = Column(DateTime(timezone=True), nullable=True)
    refunded_at = Column(DateTime(timezone=True), nullable=True)

    #: The credit note: the remote-credit request that asks a till for it (the latest), and
    #: the document once a till issued it.
    remote_credit_request_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    credit_transaction_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    credit_document_number = Column(String(40), nullable=True)
    credit_document_type = Column(Integer, nullable=True)

    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    initiated_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class CloudCardRefundEvent(Base):
    """One entry of a refund's audit trail."""

    __tablename__ = "cloud_card_refund_events"
    __table_args__ = (Index("ix_cloud_card_refund_events_refund", "refund_id", "at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    refund_id = Column(UUID(as_uuid=True), ForeignKey("cloud_card_refunds.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: `user` (the dashboard), `gateway` (Z-Credit's answer), `till`, or `system`.
    actor = Column(String(16), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    #: created | refused | preflight | sent | refunded | declined | unknown | query |
    #: resolved | resolved_manually | document_requested | document_issued | document_failed |
    #: resent.
    action = Column(String(24), nullable=False)
    detail = Column(Text, nullable=True)
    data = Column(JSONB, nullable=True)
