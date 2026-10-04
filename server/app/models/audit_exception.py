"""
Exceptions ("חריגות"): things a manager wants to look at after the fact — a discount,
a refund, a drawer opened without a sale, a basket cancelled, an order that stayed open
for long, a high tip, a cash difference at close.

Three tables:

* `audit_exceptions` — one detected exception, with where (tenant/company/shop/area/
  till), when, who (the till user), what it was about (a document, a shift or a till
  event), the amount and the review state (new / reviewed / dismissed).
  `dedupe_key` is unique: detection is idempotent, so a re-pushed document or a rescan
  never creates the same exception twice.
* `exception_rule_values` — the configuration: per exception type, whether it is on
  and its thresholds, set at any of five levels (tenant, company, shop, area, till).
  The most specific level that sets a field wins, field by field
  (`app.services.exceptions.resolve_rules`), else the built-in default.
* `till_events` — what the till records that no document carries: a line voided, a
  basket cancelled, the time a basket took, a drawer opened without a sale. Pushed
  through the till's outbox (`POST /sync/{machine_id}/events`), idempotent by id.
"""
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

EXCEPTION_STATUSES = ("new", "reviewed", "dismissed")
RULE_SCOPES = ("tenant", "company", "shop", "area", "machine")


class AuditException(Base):
    __tablename__ = "audit_exceptions"
    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_audit_exceptions_dedupe_key"),
        CheckConstraint(
            "status IN ('new', 'reviewed', 'dismissed')", name="ck_audit_exceptions_status"
        ),
        Index("ix_audit_exceptions_tenant_occurred", "tenant_id", "occurred_at"),
        Index("ix_audit_exceptions_shop_occurred", "shop_id", "occurred_at"),
        Index("ix_audit_exceptions_machine", "machine_id"),
        Index("ix_audit_exceptions_transaction", "transaction_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    company_id = Column(UUID(as_uuid=True), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)
    shift_id = Column(UUID(as_uuid=True), nullable=True)
    #: The document it is about, when it is about one. Not a foreign key: the document
    #: is the till's and is never deleted, but a till event may name one not pushed yet.
    transaction_id = Column(UUID(as_uuid=True), nullable=True)
    till_event_id = Column(UUID(as_uuid=True), nullable=True)

    exception_type = Column(String(32), nullable=False, index=True)
    severity = Column(String(16), nullable=False, default="medium")
    #: `<type>:<source id>` — what makes detection idempotent.
    dedupe_key = Column(String(200), nullable=False)

    #: The till user (`pos_users.id` as the till sent it — free text, like
    #: `transactions.cashier_id`) and their name as resolved when detected.
    pos_user_id = Column(String(100), nullable=True, index=True)
    pos_user_name = Column(String(200), nullable=True)

    #: The money it is about (the discount, the refund, the tip, the difference…).
    amount = Column(Numeric(12, 2), nullable=True)
    #: The measured value the threshold was compared with (percent, minutes…), if any.
    value = Column(Numeric(12, 2), nullable=True)
    threshold = Column(Numeric(12, 2), nullable=True)
    details = Column(JSONB, nullable=True)

    occurred_at = Column(DateTime(timezone=True), nullable=False)
    detected_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    status = Column(String(16), nullable=False, default="new", server_default="new", index=True)
    reviewed_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    review_note = Column(Text, nullable=True)


class ExceptionRuleValue(Base):
    """One level's own settings for one exception type. A null field inherits."""

    __tablename__ = "exception_rule_values"
    __table_args__ = (
        UniqueConstraint(
            "scope_type", "scope_id", "exception_type", name="uq_exception_rule_values_scope_type"
        ),
        CheckConstraint(
            "scope_type IN ('tenant', 'company', 'shop', 'area', 'machine')",
            name="ck_exception_rule_values_scope",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    scope_type = Column(String(16), nullable=False)
    #: The tenant's, company's, shop's, area's or till's id, by `scope_type`.
    scope_id = Column(UUID(as_uuid=True), nullable=False)
    exception_type = Column(String(32), nullable=False)
    #: Null: inherit from the level above.
    enabled = Column(Boolean, nullable=True)
    #: Only the thresholds this level sets, e.g. `{"minutes": 15}`; the rest inherit.
    params = Column(JSONB, nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)


class TillEvent(Base):
    """Something the till did that no document carries. Client id; idempotent."""

    __tablename__ = "till_events"
    __table_args__ = (
        Index("ix_till_events_machine_occurred", "machine_id", "occurred_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    area_id = Column(UUID(as_uuid=True), nullable=True)
    #: The till's shift id as it sent it; not a foreign key (the shift may land later).
    shift_id = Column(UUID(as_uuid=True), nullable=True)
    #: drawer_open | line_void | basket_cancel | basket_completed (and later kinds).
    event_type = Column(String(32), nullable=False)
    occurred_at = Column(DateTime(timezone=True), nullable=False)
    pos_user_id = Column(String(100), nullable=True)
    amount = Column(Numeric(12, 2), nullable=True)
    transaction_id = Column(UUID(as_uuid=True), nullable=True)
    details = Column(JSONB, nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
