"""
"זיכוי מרחוק" — a credit for a document, created from the dashboard and issued by a till
(docs/SPEC_REMOTE_CREDIT.md).

The cloud never issues a fiscal document. The dashboard records the *request* here; the
chosen till — one with an open shift, of the same business as the original — receives it
(the `remote-credit` Ably event, and `pendingRemoteCredits` on every heartbeat), issues
the credit in its own number series inside its open shift, and reports back.

* `remote_credit_requests` — one row per request; its `id` is the command id the till
  dedupes by (the dashboard may mint it, so a double submit is one request).
* `remote_credit_events` — the audit trail: who did what, when and why (the dashboard
  user, the till, or the cloud's own expiry).
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class RemoteCreditMode:
    #: "העסקה לא בוצעה בפועל": the till issues the credit at once, with no money moving —
    #: its tender mirrors the original's, marked `noMoneyMovement`. Never a pinpad.
    NO_MONEY = "no_money"
    #: "להשלמה בקופה": the till holds it as a waiting refund; the cashier completes it with
    #: the till's own refund flow and any tender.
    PREPARED = "prepared"
    #: "זוכה באשראי מהענן (Z-Credit)" (SPEC_REMOTE_CREDIT.md §11): the cloud already refunded
    #: the card through Z-Credit's web API (`card_refund_id`); the till issues the credit note
    #: at once, its tender the card leg the request carries — never a pinpad, never the drawer.
    #: Only ever created by a cloud card refund, never asked for directly.
    CARD_REFUNDED = "card_refunded"


#: The modes a dashboard user picks for a remote credit.
REMOTE_CREDIT_MODES = (RemoteCreditMode.NO_MONEY, RemoteCreditMode.PREPARED)
#: Every mode a request may have.
ALL_REMOTE_CREDIT_MODES = REMOTE_CREDIT_MODES + (RemoteCreditMode.CARD_REFUNDED,)


class RemoteCreditStatus:
    #: Created; not handed to the till yet (it is offline).
    QUEUED = "queued"
    #: Sent: the Ably event went out, or a heartbeat / pull handed it over.
    SENT = "sent"
    #: The till has it: executing (mode 1, waiting for the till to be idle) or waiting
    #: for the cashier (mode 2).
    RECEIVED = "received"
    #: The till issued the credit (`credit_transaction_id`).
    COMPLETED = "completed"
    #: The till refused it (`error_code` / `error_message`).
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


#: The statuses a till still has to act on, and that hold creditable quantity.
PENDING_REMOTE_CREDIT_STATUSES = (
    RemoteCreditStatus.QUEUED,
    RemoteCreditStatus.SENT,
    RemoteCreditStatus.RECEIVED,
)


class RemoteCreditRequest(Base):
    __tablename__ = "remote_credit_requests"
    __table_args__ = (
        Index("ix_remote_credit_requests_machine_status", "machine_id", "status"),
        Index("ix_remote_credit_requests_original", "original_transaction_id"),
    )

    #: The command id. The till never issues two credits for one id.
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    #: The original's company (the business whose VAT number the credit is filed under).
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    #: The target till and its shop, as they were when the request was made.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)

    #: The document credited. Not a foreign key, like `transactions.refund_of_transaction_id`.
    original_transaction_id = Column(UUID(as_uuid=True), nullable=False)
    original_machine_id = Column(UUID(as_uuid=True), nullable=True)
    #: As printed (`20000057`), frozen with the request.
    original_document_number = Column(String(40), nullable=True)
    original_document_type = Column(Integer, nullable=True)
    original_issued_at = Column(DateTime(timezone=True), nullable=True)

    #: `no_money` | `prepared` | `card_refunded` (`RemoteCreditMode`).
    mode = Column(String(16), nullable=False)
    #: Mode `card_refunded`: the cloud card refund (`cloud_card_refunds.id`) whose credit
    #: note this request asks for.
    card_refund_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    #: Everything still creditable at the time of the request.
    full_credit = Column(Boolean, nullable=False, default=False, server_default="false")
    #: `[{"itemId", "productId", "productName", "quantity", "amount"}]` — the lines and the
    #: cloud's figure for each (the till recomputes with the same rule and reports its own).
    lines = Column(JSONB, nullable=False, default=list)
    #: Σ lines' amounts: what the request credits.
    amount = Column(Numeric(12, 2), nullable=False)
    #: Mode 1: the original's tenders, mirrored on the credit (`[{"method", "amount"}]`).
    tenders = Column(JSONB, nullable=True)
    #: Why — required. `reason_code` is the quick reason picked, if any.
    reason_code = Column(String(32), nullable=True)
    reason = Column(Text, nullable=False)

    #: `RemoteCreditStatus`.
    status = Column(String(16), nullable=False, default=RemoteCreditStatus.QUEUED)
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)

    #: The credit the till issued (not a foreign key: it may reach the cloud after the ack).
    credit_transaction_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    credit_document_number = Column(String(40), nullable=True)
    credit_document_type = Column(Integer, nullable=True)
    credit_amount = Column(Numeric(12, 2), nullable=True)

    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    #: The name the till shows ("נשלח מהענן ע״י …"), frozen.
    initiated_by = Column(String(255), nullable=True)
    cancelled_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    cancel_reason = Column(Text, nullable=True)

    sent_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    failed_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    machine = relationship("POSMachine", foreign_keys=[machine_id])


class RemoteCreditEvent(Base):
    """One entry of a request's audit trail."""

    __tablename__ = "remote_credit_events"
    __table_args__ = (Index("ix_remote_credit_events_request", "request_id", "at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id = Column(
        UUID(as_uuid=True), ForeignKey("remote_credit_requests.id", ondelete="CASCADE"), nullable=False
    )
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: `user` (the dashboard), `till` (the machine) or `system` (expiry, a linked document).
    actor = Column(String(16), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    #: created | sent | received | deferred | waiting | completed | failed | cancelled |
    #: expired | document_linked.
    action = Column(String(24), nullable=False)
    detail = Column(Text, nullable=True)
    data = Column(JSONB, nullable=True)
