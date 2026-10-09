"""
Production vouchers ("שוברי הפקה") — what comes after issue and redemption (the spec's §14, §16,
§18; the contract's "Helper: settlement, reports and §18" section):

* `prepaid_settlement_agreements` — "הסכם התחשבנות" with a production for an event: which batches
  it covers (by the production / the event, or a list), the billing basis (by redemption — the
  default — or by delivery), the period, ₪ only, and how cancelled and replacement vouchers are
  charged. The settlement itself is computed, never stored.
* `prepaid_settlement_invoices` / `…_lines` / `…_files` — the external invoice references
  ("אסמכתאות"): the invoice is issued outside the system; here its number, date, system, amount,
  an optional file and the voucher quantities it covers, per batch. Never deleted — voided.
* `prepaid_voucher_deliveries` — "מסירה להפקה": a serial range of a batch handed over (when, to
  whom, by whom, chargeable or not). What "by delivery" bills.
* `prepaid_voucher_replacements` — a replacement voucher linked to its original (lost, damaged,
  cancelled): the original is cancelled, the replacement inherits its batch and what was left.
* `prepaid_redemption_pauses` — redemptions paused for an event, batch, type or production, with a
  reason and an optional end ("עד").
* `prepaid_redemption_quotas` — the most redemptions a production, event, type or batch takes,
  overall, per day or within a range.
* `prepaid_voucher_test_batches` — a batch marked as staff test vouchers ("שוברי בדיקה"):
  redeemable only at a till in training mode, out of every settlement.
* `prepaid_voucher_extra_events` — the audit trail of all of the above (who, when, what, before
  and after).

Money in agorot, ₪ only (`currency` 'ILS'). See app/services/prepaid_voucher_settlement.py,
prepaid_voucher_controls.py, prepaid_voucher_replacement.py.
"""
import uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: `billing_basis`: "לפי מימוש" (the default — vouchers validly redeemed, net, in the period) /
#: "לפי מסירה" (vouchers marked chargeable when handed over, whatever is redeemed).
SETTLEMENT_BASES = ("redemption", "delivery")
#: `cancelled_policy` — a voucher cancelled and never redeemed: not charged (`exclude`, the
#: default) / charged anyway (`charge`, by delivery: it was handed over).
CANCELLED_POLICIES = ("exclude", "charge")
#: `replacement_policy` — a replacement and its original are one voucher (`free`, the default:
#: "אינו יוצר חיוב נוסף להפקה") / the replacement is a voucher of its own (`charge`).
REPLACEMENT_POLICIES = ("free", "charge")
AGREEMENT_STATUSES = ("active", "closed")
CURRENCIES = ("ILS",)
#: `prepaid_voucher_replacements.reason_kind`.
REPLACEMENT_REASONS = ("lost", "damaged", "cancelled", "other")
#: Pauses and quotas apply to batches by: their production (the batch's customer until the
#: Production entity), their event (the batch's event name / its report event), their type, or one batch.
CONTROL_SCOPES = ("production", "event", "type", "batch")
QUOTA_PERIODS = ("overall", "day", "range")


class PrepaidSettlementAgreement(Base):
    __tablename__ = "prepaid_settlement_agreements"
    __table_args__ = (
        CheckConstraint("billing_basis IN ('redemption', 'delivery')", name="ck_prepaid_settlement_agreements_basis"),
        CheckConstraint("currency = 'ILS'", name="ck_prepaid_settlement_agreements_currency"),
        CheckConstraint("cancelled_policy IN ('exclude', 'charge')", name="ck_prepaid_settlement_agreements_cancelled"),
        CheckConstraint("replacement_policy IN ('free', 'charge')", name="ck_prepaid_settlement_agreements_replacement"),
        CheckConstraint("status IN ('active', 'closed')", name="ck_prepaid_settlement_agreements_status"),
        Index("ix_prepaid_settlement_agreements_tenant", "tenant_id", "company_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False)
    name = Column(String(200), nullable=False)
    #: The production: the core's Production entity (`prepaid_productions`, the batches' `production_id`)
    #: and/or its name (the batches' `customer_name`, kept in step with it — and the only link of a batch
    #: made before productions).
    production_name = Column(String(200), nullable=True)
    production_id = Column(UUID(as_uuid=True), ForeignKey("prepaid_productions.id", ondelete="SET NULL"), nullable=True)
    #: The event: the batches' `event_name` text, and/or the report event (`report_events`).
    event_name = Column(String(200), nullable=True)
    report_event_id = Column(UUID(as_uuid=True), ForeignKey("report_events.id", ondelete="SET NULL"), nullable=True)
    #: An explicit list of batch ids (strings). Set: exactly these batches; null: the
    #: production / event decide (a new batch of theirs joins by itself).
    batch_ids = Column(JSON, nullable=True)
    billing_basis = Column(String(16), nullable=False, default="redemption", server_default="redemption")
    #: The tenant's local days, both included; null: open-ended.
    period_from = Column(Date, nullable=True)
    period_to = Column(Date, nullable=True)
    currency = Column(String(3), nullable=False, default="ILS", server_default="ILS")
    cancelled_policy = Column(String(16), nullable=False, default="exclude", server_default="exclude")
    replacement_policy = Column(String(16), nullable=False, default="free", server_default="free")
    status = Column(String(16), nullable=False, default="active", server_default="active")
    notes = Column(Text, nullable=True)
    #: "הסבר לפער" — why the invoices differ from the report (the report itself never changes).
    gap_note = Column(Text, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class PrepaidSettlementInvoice(Base):
    """An external invoice to the production ("אסמכתא חיצונית") — issued elsewhere, referenced here."""

    __tablename__ = "prepaid_settlement_invoices"
    __table_args__ = (
        CheckConstraint("currency = 'ILS'", name="ck_prepaid_settlement_invoices_currency"),
        Index("ix_prepaid_settlement_invoices_agreement", "agreement_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    agreement_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_settlement_agreements.id", ondelete="CASCADE"), nullable=False
    )
    number = Column(String(64), nullable=False)
    invoice_date = Column(Date, nullable=False)
    #: The external system it was issued in ("חשבשבת", "ריווחית" …).
    system = Column(String(100), nullable=True)
    #: The invoice's own amount, agorot — compared with the quantities it covers (the gap).
    amount = Column(BigInteger, nullable=False)
    currency = Column(String(3), nullable=False, default="ILS", server_default="ILS")
    note = Column(Text, nullable=True)
    gap_note = Column(Text, nullable=True)
    file_name = Column(String(255), nullable=True)
    file_type = Column(String(100), nullable=True)
    file_size = Column(Integer, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    voided_at = Column(DateTime(timezone=True), nullable=True)
    voided_by_name = Column(String(200), nullable=True)
    void_reason = Column(Text, nullable=True)


class PrepaidSettlementInvoiceLine(Base):
    """The vouchers of one batch an invoice covers, at the batch's production price (snapshot)."""

    __tablename__ = "prepaid_settlement_invoice_lines"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_prepaid_settlement_invoice_lines_quantity"),
        Index("ix_prepaid_settlement_invoice_lines_invoice", "invoice_id"),
        Index("ix_prepaid_settlement_invoice_lines_batch", "batch_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    invoice_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_settlement_invoices.id", ondelete="CASCADE"), nullable=False
    )
    batch_id = Column(UUID(as_uuid=True), ForeignKey("prepaid_voucher_batches.id"), nullable=False)
    quantity = Column(Integer, nullable=False)
    #: Agorot per voucher when they all were issued at one price; null when they differ.
    unit_price = Column(BigInteger, nullable=True)
    #: Agorot: Σ the covered vouchers' production prices at issue.
    amount = Column(BigInteger, nullable=True)
    #: The vouchers it covers (ids) and their serials — a voucher is on one live invoice at most.
    voucher_ids = Column(JSON, nullable=True)
    serials = Column(JSON, nullable=True)


class PrepaidSettlementInvoiceFile(Base):
    """An invoice's optional file (PDF / image), kept apart so the invoice rows stay light."""

    __tablename__ = "prepaid_settlement_invoice_files"

    invoice_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_settlement_invoices.id", ondelete="CASCADE"), primary_key=True
    )
    data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PrepaidVoucherDelivery(Base):
    """"מסירה להפקה": the vouchers `serial_from`..`serial_to` of a batch handed over."""

    __tablename__ = "prepaid_voucher_deliveries"
    __table_args__ = (
        CheckConstraint("serial_from >= 1 AND serial_to >= serial_from", name="ck_prepaid_voucher_deliveries_range"),
        Index("ix_prepaid_voucher_deliveries_batch", "batch_id", "delivered_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    batch_id = Column(UUID(as_uuid=True), ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), nullable=False)
    serial_from = Column(Integer, nullable=False)
    serial_to = Column(Integer, nullable=False)
    #: Vouchers in the range when it was recorded (cancelled ones included).
    count = Column(Integer, nullable=False)
    #: "חייב בעת המסירה": billed by an agreement "by delivery". Off: handed over free.
    chargeable = Column(Boolean, nullable=False, default=True, server_default="true")
    delivered_at = Column(DateTime(timezone=True), nullable=False)
    recipient = Column(String(200), nullable=True)
    note = Column(Text, nullable=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    voided_at = Column(DateTime(timezone=True), nullable=True)
    voided_by_name = Column(String(200), nullable=True)
    void_reason = Column(Text, nullable=True)


class PrepaidVoucherReplacement(Base):
    """A replacement voucher and the original it stands for (§16). One replacement per original."""

    __tablename__ = "prepaid_voucher_replacements"
    __table_args__ = (
        UniqueConstraint("original_voucher_id", name="uq_prepaid_voucher_replacements_original"),
        UniqueConstraint("replacement_voucher_id", name="uq_prepaid_voucher_replacements_replacement"),
        CheckConstraint(
            "reason_kind IN ('lost', 'damaged', 'cancelled', 'other')", name="ck_prepaid_voucher_replacements_reason"
        ),
        Index("ix_prepaid_voucher_replacements_batch", "batch_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    batch_id = Column(UUID(as_uuid=True), ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), nullable=False)
    original_voucher_id = Column(UUID(as_uuid=True), ForeignKey("prepaid_vouchers.id", ondelete="CASCADE"), nullable=False)
    replacement_voucher_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_vouchers.id", ondelete="CASCADE"), nullable=False
    )
    reason_kind = Column(String(16), nullable=False)
    reason = Column(Text, nullable=False)
    #: The original's status before it was replaced, and what the replacement was given.
    original_status = Column(String(16), nullable=True)
    details = Column(JSON, nullable=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PrepaidRedemptionPause(Base):
    """"השהיית מימושים" (§18.4): active from creation until `until` or until resumed."""

    __tablename__ = "prepaid_redemption_pauses"
    __table_args__ = (
        CheckConstraint(
            "scope_kind IN ('production', 'event', 'type', 'batch')", name="ck_prepaid_redemption_pauses_scope"
        ),
        Index("ix_prepaid_redemption_pauses_tenant", "tenant_id", "resumed_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: Null: every company of the tenant (the scope value decides).
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    scope_kind = Column(String(16), nullable=False)
    #: The production's / event's name, or the type's / batch's id.
    scope_value = Column(String(200), nullable=False)
    #: As shown ("פסטיבל הקיץ", "שובר ארוחה").
    scope_label = Column(String(200), nullable=True)
    reason = Column(Text, nullable=False)
    until = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    resumed_at = Column(DateTime(timezone=True), nullable=True)
    resumed_by_name = Column(String(200), nullable=True)
    resume_note = Column(Text, nullable=True)


class PrepaidRedemptionQuota(Base):
    """"מכסת מימושים" (§18.3): at most `max_redemptions` in the period."""

    __tablename__ = "prepaid_redemption_quotas"
    __table_args__ = (
        CheckConstraint(
            "scope_kind IN ('production', 'event', 'type', 'batch')", name="ck_prepaid_redemption_quotas_scope"
        ),
        CheckConstraint("period IN ('overall', 'day', 'range')", name="ck_prepaid_redemption_quotas_period"),
        CheckConstraint("max_redemptions >= 0", name="ck_prepaid_redemption_quotas_max"),
        Index("ix_prepaid_redemption_quotas_tenant", "tenant_id", "active"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    scope_kind = Column(String(16), nullable=False)
    scope_value = Column(String(200), nullable=False)
    scope_label = Column(String(200), nullable=True)
    max_redemptions = Column(Integer, nullable=False)
    period = Column(String(16), nullable=False, default="overall", server_default="overall")
    period_from = Column(DateTime(timezone=True), nullable=True)
    period_to = Column(DateTime(timezone=True), nullable=True)
    #: The dashboard warns from this share of the quota (percent).
    warn_percent = Column(Integer, nullable=False, default=80, server_default="80")
    active = Column(Boolean, nullable=False, default=True, server_default="true")
    note = Column(Text, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class PrepaidVoucherTestBatch(Base):
    """A batch of staff test vouchers ("שוברי בדיקה", §18.5)."""

    __tablename__ = "prepaid_voucher_test_batches"

    batch_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    note = Column(Text, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PrepaidVoucherExtraEvent(Base):
    """The audit trail of settlement, deliveries, replacements, pauses, quotas and test batches."""

    __tablename__ = "prepaid_voucher_extra_events"
    __table_args__ = (Index("ix_prepaid_voucher_extra_events_tenant", "tenant_id", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: agreement_create / agreement_update / invoice_add / invoice_void / invoice_file / invoice_update /
    #: delivery_add / delivery_void / replace / pause / resume / quota_create / quota_update /
    #: test_create / test_mark / test_unmark
    action = Column(String(32), nullable=False)
    #: What it is about: the agreement, invoice, delivery, voucher, pause, quota or batch id.
    ref_id = Column(UUID(as_uuid=True), nullable=True)
    batch_id = Column(UUID(as_uuid=True), nullable=True)
    reason = Column(Text, nullable=True)
    #: {"before": {...}, "after": {...}, ...}
    details = Column(JSON, nullable=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


# On the core's reservations: what a redemption quota counts at every check (migration e4b9d2a7c6f1).
from app.models.prepaid_voucher import PrepaidVoucherReservation as _Reservation  # noqa: E402

Index(
    "ix_prepaid_voucher_reservations_batch_held",
    _Reservation.__table__.c.batch_id, _Reservation.__table__.c.status, _Reservation.__table__.c.expires_at,
)
