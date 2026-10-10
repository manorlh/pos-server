import uuid
import enum

from sqlalchemy import (
    Boolean, Column, Computed, String, ForeignKey, Numeric, Integer, Text,
    Enum as SQLEnum, DateTime, UniqueConstraint, Index, false, text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class TransactionStatus(str, enum.Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    REFUNDED = "refunded"
    PARTIAL_REFUND = "partial_refund"


#: `document_series` as the database computes it from the type — the same rule as
#: `app.services.document_prefix.document_series_of` (tested to agree).
DOCUMENT_SERIES_SQL = (
    "CASE WHEN document_type IN (400, -400) THEN 400 "
    "WHEN document_type = 330 THEN 330 "
    "WHEN document_type IS NULL AND refund_of_transaction_id IS NOT NULL THEN 330 "
    "WHEN document_type IS NULL OR document_type = 320 THEN 320 "
    "ELSE abs(document_type) END"
)


class Transaction(Base):
    """A POS sale / refund. id is client-generated UUID for idempotent upserts."""

    __tablename__ = "transactions"
    __table_args__ = (
        # One number series per document type on each till ("רצף מספרים נפרד לכל מסמך",
        # docs/SPEC_DOCUMENT_PREFIX.md): a 320 #57 and a 330 #57 of one till are two
        # documents; a 400 and a -400 share the 400 series (`document_series`).
        # Unique among the documents that *hold* their number: a second document with a
        # number already held is stored too — every document lands — as a numbering
        # conflict (`number_conflict_of`, docs/SHIFTS_API.md §1.2d), outside this index.
        Index(
            "uq_tx_machine_series_number_primary",
            "machine_id", "document_series", "transaction_number",
            unique=True,
            postgresql_where=text("number_conflict_of IS NULL"),
            sqlite_where=text("number_conflict_of IS NULL"),
        ),
        Index("ix_transactions_claimed_shift", "claimed_shift_id"),
        Index("ix_transactions_number_conflict_of", "number_conflict_of"),
        Index("ix_transactions_machine_created_at", "machine_id", "created_at"),
        # The dashboard's sales figures: a tenant / its shops over a time window.
        Index("ix_transactions_tenant_created_at", "tenant_id", "created_at"),
        Index("ix_transactions_shop_created_at", "shop_id", "created_at"),
        Index("ix_transactions_shift", "shift_id"),
        Index("ix_transactions_basket", "basket_id"),
        Index("ix_transactions_refund_of", "refund_of_transaction_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    shift_id = Column(UUID(as_uuid=True), ForeignKey("shifts.id"), nullable=True)

    transaction_number = Column(String(100), nullable=False)
    status = Column(
        SQLEnum(TransactionStatus, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=TransactionStatus.COMPLETED,
    )

    document_type = Column(Integer, nullable=True)
    #: The number series the document was numbered in: 320, 330 or 400 — an exempt
    #: dealer's refund (-400) is in the 400 series. Computed by the database from the type
    #: (a generated column: never written, never out of step with `document_type`). A
    #: number identifies a document of a till only together with this.
    document_series = Column(Integer, Computed(DOCUMENT_SERIES_SQL, persisted=True), nullable=False)
    document_production_date = Column(DateTime(timezone=True), nullable=True)
    # Kept populated for every document, including split-tender ones, because an
    # older till build and every existing report and export still read it. The
    # authoritative breakdown now lives in `payments`; this is the single-value
    # summary of it — the tender name for a one-leg document, and the literal
    # "mixed" for a document with more than one. See `derive_payment_method`.
    payment_method = Column(String(50), nullable=True)

    amount_tendered = Column(Numeric(12, 2), nullable=True)
    change_amount = Column(Numeric(12, 2), nullable=True)
    total_amount = Column(Numeric(12, 2), nullable=False, server_default="0")

    # ── VAT as of issue, not as of reading ────────────────────────────────────
    #
    # These were derived at export time from the gross and the *current* rate, which
    # means a rate change silently rewrote every document already issued. Israel moved
    # 17% → 18% in January 2025; the next change would have re-stated every historical
    # receipt at the new rate. The split a customer was actually charged is a fact about
    # the moment of sale, so it is stored with the sale.
    #
    # `vat_rate` is the fraction in force at issue (0.18), and it is the field that
    # makes the other two auditable — without it you cannot tell a correct 17% document
    # from a wrong 18% one.
    #
    # Nullable: documents issued before this carry none, and back-filling them would
    # invent a rate we cannot know was theirs.
    net_amount = Column(Numeric(12, 2), nullable=True)
    vat_amount = Column(Numeric(12, 2), nullable=True)
    vat_rate = Column(Numeric(6, 4), nullable=True)

    #: The register this document was issued on, as the business numbers its registers.
    #: Stamped by the server from the machine, so the document carries it rather than
    #: only being joinable to it — an audit reads the document.
    pos_number = Column(String(50), nullable=True)
    #: The till's "קידומת מסמכים" this document was issued under, as the till froze it
    #: at issue and printed it (`20000057`). Never rewritten: a later change of the till's
    #: prefix does not touch documents already issued. Null on documents from before
    #: the prefix (and from a till build that sends none): they read as their
    #: `pos_number` — the register that issued them — see
    #: `app.services.document_prefix.document_prefix_of` and docs/SPEC_DOCUMENT_PREFIX.md.
    document_prefix = Column(String(10), nullable=True)
    tip_amount = Column(Numeric(12, 2), nullable=False, server_default="0")
    tip_payment_method = Column(String(10), nullable=True)
    total_discount = Column(Numeric(12, 2), nullable=True)
    document_discount = Column(Numeric(12, 2), nullable=True)
    #: The basket discount on its own — inside `document_discount` with the line
    #: discounts and the promotions — the rate it was given at (null for a sum), and what
    #: it was: `club` (the club button, till parameter `clubButtonEnabled`) or `manual`.
    basket_discount = Column(Numeric(12, 2), nullable=True)
    basket_discount_percent = Column(Numeric(6, 2), nullable=True)
    basket_discount_kind = Column(String(16), nullable=True)
    #: A document made only of production vouchers' ₪0 memo lines (`zero` mode): out of the
    #: Z's and the daily aggregates' document counts, as on the till.
    voucher_memo = Column(Boolean, nullable=False, default=False, server_default="false")
    #: A meal at a staff or managers' table (app/services/table_policies.py): `staff` /
    #: `managers`, whose meal it was (a staff table's employee, as the till named them),
    #: and why (a managers' table's reason). The approving manager is `approved_by_*`.
    meal_kind = Column(String(16), nullable=True)
    meal_employee_id = Column(String(100), nullable=True)
    meal_employee_name = Column(String(200), nullable=True)
    meal_reason = Column(String(300), nullable=True)
    wht_deduction = Column(Numeric(12, 2), nullable=True)

    # Free text as sent by the till — a cloud customer UUID on a current build, but
    # historically anything the client had. Never rejected on ingest; see
    # `customer_ref_id` for the validated link.
    customer_id = Column(String(100), nullable=True)
    # The resolved link, written server-side: set only when `customer_id` parses as a
    # UUID **and** names a customer of this machine's tenant. This is the column the
    # receipt and tax-export code joins on, so an unresolvable reference reads as
    # "no customer" instead of silently producing a tax invoice addressed to nobody.
    customer_ref_id = Column(UUID(as_uuid=True), ForeignKey("customers.id"), nullable=True, index=True)
    # The buyer's details as printed on the document — the regulation requires them on a
    # return (זיכוי), and a walk-in who returns an item is rarely a cloud customer. A
    # snapshot, like a line's product name: never resolved, never rewritten, and only
    # read by the tax export when the document has no resolved `customer_ref_id`.
    customer_name = Column(String(255), nullable=True)
    customer_phone = Column(String(30), nullable=True)
    customer_address = Column(String(500), nullable=True)
    cashier_id = Column(String(100), nullable=True)
    branch_id = Column(String(100), nullable=True)
    notes = Column(Text, nullable=True)

    #: The original sale a credit note refunds. **Not** a foreign key, on purpose: the
    #: till pushes in its own order, and a credit note that reaches the cloud before its
    #: original must still be stored — a fiscal document is never lost over a link. The
    #: link is resolved when it is read (always within the document's own tenant), and
    #: the original is settled when it arrives (`settle_credited_originals`).
    refund_of_transaction_id = Column(UUID(as_uuid=True), nullable=True)
    #: Set on a credit note that took its original's credited total past what the
    #: original collected. Stored all the same — a fiscal document the till issued is
    #: never refused — but flagged, so the over-refund can be found and explained.
    #: Written server-side only (`app.services.transactions.settle_credited_originals`).
    over_credited = Column(Boolean, nullable=False, default=False, server_default=false())
    #: "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): the dashboard request this credit answered,
    #: as the till sent it. Null on every other document. Not a foreign key, like the link
    #: above: a document is never refused over it.
    remote_credit_request_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    #: A credit for a sale that never really happened ("ללא החזר כספי — עסקה שלא בוצעה"):
    #: its tender mirrors the original's but no money moved — true when any of its legs
    #: says so (`TransactionPayment.no_money_movement`). Written server-side on ingest.
    no_money_movement = Column(Boolean, nullable=False, default=False, server_default=false())
    nayax_meta = Column(JSONB, nullable=True)

    #: The till basket this document was committed in (docs/SHIFTS_API.md §1.2a). One
    #: basket that mixes sold and returned lines is several documents — a 320 for the
    #: sale, a 330 per original receipt credited, and a 330 for catalogue returns — that
    #: share this id, and whose offset is paid with `exchange` tender legs. Client
    #: generated; null for every document that is not part of such a basket.
    basket_id = Column(UUID(as_uuid=True), nullable=True)

    #: Who authorised the thing a cashier may not do alone — the refund, or the money
    #: taken off the price. `cashier_id` says who rang it up; this says who allowed it,
    #: and they are rarely the same person.
    #:
    #: A cloud `users` row, not a `pos_users` one: authority lives on `users` and
    #: pointing at the till's own operator table would record a name with no permissions
    #: behind it. Written only after `app.services.approvals` has verified the claim.
    #:
    #: Nullable, and null on the overwhelming majority of rows. Most documents need no
    #: approval at all, and a till operated by someone who already holds the authority
    #: never produces a second name. Null means "nobody had to approve this", not
    #: "we lost track of who did".
    approved_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    #: The same, when the approver was a till user (a shop manager on the till's own
    #: roster) rather than a cloud account. At most one of the two is set. Verified at
    #: ingest like `approved_by_user_id` (`app.services.approvals`).
    approved_by_pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id"), nullable=True)
    #: The approver exactly as the till sent it (`approvedByUserId` / `approvedByPosUserId`),
    #: kept even when it names nobody this business knows — then `approved_by_*` above stay
    #: null (they link only a person of this tenant) and `ingest_notes` says so. Informational
    #: only: an approval claim never refuses or holds a document (docs/SHIFTS_API.md §1.2b).
    #: Not foreign keys, on purpose: an id the cloud does not hold must still be stored.
    claimed_approver_user_id = Column(UUID(as_uuid=True), nullable=True)
    claimed_approver_pos_user_id = Column(UUID(as_uuid=True), nullable=True)
    #: Quiet notes written at ingest about what the document carried — an approver this
    #: business does not know, tender legs that do not add up, a refund link to another
    #: tenant's document — as `[{"code": …, "text": …}]`. Shown in the document's detail;
    #: never a reason to refuse, hold or leave the document out of its shift, X or Z.
    ingest_notes = Column(JSONB, nullable=True)
    #: The shift id exactly as the till sent it (`shiftId`), kept even when the document is
    #: filed elsewhere (another till's shift, a shift the cloud has not seen yet). Not a
    #: foreign key. A document waiting for its shift is moved into it when that shift
    #: reaches the cloud (app/services/document_filing.py, docs/SHIFTS_API.md §1.2c-bis).
    claimed_shift_id = Column(UUID(as_uuid=True), nullable=True)
    #: The machine whose token delivered the document, when it is not the machine that
    #: issued it: a device re-paired as a new machine delivers what it issued as the
    #: previous one, and the document is filed under that previous machine (the issuer).
    pushed_by_machine_id = Column(UUID(as_uuid=True), nullable=True)
    #: "Same number, different id": the document that already holds this number on this
    #: till and series. Null for the holder (and every ordinary document). Both are kept.
    number_conflict_of = Column(UUID(as_uuid=True), nullable=True)
    #: A numbering conflict whose fiscal content is the holder's own (the same sale stored
    #: twice under two ids): left out of every total — X, Z, reports, the open-format
    #: export — so it is counted once. A conflict with other content is a sale of its own
    #: and counts (docs/SHIFTS_API.md §1.2d).
    duplicate_copy = Column(Boolean, nullable=False, default=False, server_default=false())

    # Timestamps from POS
    created_at = Column(DateTime(timezone=True), nullable=False)
    updated_at = Column(DateTime(timezone=True), nullable=False)
    # Authoritative server-side wall clock used when POS clock skew is suspected
    server_received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    machine = relationship("POSMachine")
    shop = relationship("Shop")
    shift = relationship("Shift", back_populates="transactions")
    items = relationship(
        "TransactionItem",
        back_populates="transaction",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    issued_vouchers = relationship(
        "IssuedVoucher",
        back_populates="transaction",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    payments = relationship(
        "TransactionPayment",
        back_populates="transaction",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TransactionPayment.sequence",
    )
    customer = relationship("Customer", foreign_keys=[customer_ref_id])

    @property
    def document_number(self) -> str:
        """The number as printed: the prefix and the number padded to 7 digits (`20000057`), or the bare number without one."""
        from app.services.document_prefix import document_number_of

        return document_number_of(self)

    # View only, and unscoped: the link is not a foreign key (see above), so a reader
    # that follows it must check the tenant itself.
    refund_of = relationship(
        "Transaction",
        primaryjoin="foreign(Transaction.refund_of_transaction_id) == remote(Transaction.id)",
        viewonly=True,
    )
