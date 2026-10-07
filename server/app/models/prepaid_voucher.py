"""
Prepaid vouchers ("שוברי הפקה"): vouchers a festival's production team is handed in
advance and redeems at the tills by QR, for goods already paid for (or given free).

Unrelated to the value vouchers of `vouchers` / `issued_vouchers` (gift cards sold at
a till) and to the item tickets of `ticket_mode` (slips a till prints after a sale).

* `prepaid_voucher_batches` — one print run: the event, its logo and text, validity,
  which shops' tills may redeem it, and whether a voucher may be redeemed in parts.
* `prepaid_voucher_batch_items` — what every voucher of the batch is worth, in goods:
  "1 נקניקייה + 1 שתייה".
* `prepaid_vouchers` — one voucher: a human serial (1..n within its batch), an
  unguessable code (all the QR carries) and the balance still to be taken per item.
* `prepaid_voucher_redemptions` — every redemption, by which till, which employee,
  what was taken and what was forfeited. Idempotent per till by `client_request_id`.
  A discount voucher's use is a redemption too (no goods; its uses and the ₪ it took).
* `prepaid_voucher_reservations` — a discount voucher held for one sale at one till
  while the sale is open (reserve → confirm with the document, or release / time out).

A batch is of one kind (`kind`, docs/SPEC_VOUCHER_PRODUCTION.md §7): `items` — goods paid
in advance, redeemed as a tender; `order_discount` / `item_discount` — a discount on the
document (never a tender), on the whole sale or on chosen products.

See app/services/prepaid_vouchers.py for the rules.
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
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base

PREPAID_BATCH_STATUSES = ("active", "cancelled")
PREPAID_VOUCHER_STATUSES = ("active", "partially_used", "used", "cancelled")
#: `prepaid_voucher_batches.kind`.
PREPAID_VOUCHER_KINDS = ("items", "order_discount", "item_discount")
#: `prepaid_voucher_reservations.status` (a `held` one past `expires_at` reads as expired).
PREPAID_RESERVATION_STATUSES = ("held", "confirmed", "released")


class PrepaidVoucherBatch(Base):
    __tablename__ = "prepaid_voucher_batches"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'cancelled')", name="ck_prepaid_voucher_batches_status"),
        CheckConstraint(
            "kind IN ('items', 'order_discount', 'item_discount')", name="ck_prepaid_voucher_batches_kind"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False, index=True)
    #: The shops whose tills may redeem, as a list of shop id strings. Null: every shop
    #: of the company.
    shop_ids = Column(JSON, nullable=True)

    name = Column(String(200), nullable=False)
    event_name = Column(String(200), nullable=True)
    logo_url = Column(String(500), nullable=True)
    free_text = Column(Text, nullable=True)
    valid_from = Column(DateTime(timezone=True), nullable=True)
    valid_until = Column(DateTime(timezone=True), nullable=True)
    #: True: "מימוש בחלקים" — what is not taken now stays on the voucher. False:
    #: "מימוש חד-פעמי" — one redemption uses the voucher up.
    split_allowed = Column(Boolean, nullable=False, default=False, server_default="false")

    status = Column(String(16), nullable=False, default="active", server_default="active")
    #: The serial the next voucher of this batch gets (serials are 1..n per batch).
    next_serial = Column(Integer, nullable=False, default=1, server_default="1")

    # ── Production ("הפקה", docs/SPEC_VOUCHER_PRODUCTION.md) ──────────────────
    #: The group size the run was made in (an envelope of 10, 20 …); null: not grouped.
    #: Each voucher keeps its own `group_no`, fixed when issued.
    group_size = Column(Integer, nullable=True)
    #: Print the voucher's code under its barcode (human-readable). Off by default: the
    #: barcode is what is redeemed, and a printed code is one more way to copy a voucher.
    show_code = Column(Boolean, nullable=False, default=False, server_default="false")
    #: `qr` (2D, any camera / imager) or `code128` (a line barcode, for 1D laser scanners).
    barcode_type = Column(String(16), nullable=False, default="qr", server_default="qr")
    #: Who ordered the run ("קייטרינג אלון") and their order number — cover sheets, manifest.
    customer_name = Column(String(200), nullable=True)
    order_ref = Column(String(100), nullable=True)

    # ── Kind and terms (docs/SPEC_VOUCHER_PRODUCTION.md §7) ──────────────────────
    #: `items` (goods, a tender — every batch before kinds), `order_discount` (off the
    #: whole sale) or `item_discount` (off chosen products, per unit).
    kind = Column(String(16), nullable=False, default="items", server_default="items")
    #: Discount kinds: `fixed` (agorot in `discount_value`) or `percent` (basis points:
    #: 2000 = 20%). Null for `items`.
    discount_type = Column(String(8), nullable=True)
    discount_value = Column(Integer, nullable=True)
    #: `order_discount`: the least the discounted base must come to (agorot); the most a
    #: percent discount takes (agorot). Null: none.
    min_purchase = Column(Integer, nullable=True)
    max_discount = Column(Integer, nullable=True)
    #: `item_discount`: units discounted per use (null: every eligible unit), and what is
    #: discounted — `{"productIds": [...], "categoryIds": [...], "names": [...]}` (global
    #: ids; a category means it and its sub-categories; names as printed).
    max_units = Column(Integer, nullable=True)
    targets = Column(JSON, nullable=True)
    #: Other vouchers in the same sale: `single` (no other), `distinct_batches` (only of
    #: other batches) or `unlimited`. New batches: single; the migration gave every batch
    #: made before it `unlimited` (what the tills did then).
    stacking = Column(String(24), nullable=False, default="single", server_default="single")
    #: A discount voucher on a line that has a promotion: `exclude` (never — the line is
    #: left out), `best` (the bigger of the two, never both) or `combine` (both).
    promotion_policy = Column(String(16), nullable=False, default="exclude", server_default="exclude")
    #: Discount kinds: uses per voucher, the most of them one sale takes, and (optional)
    #: the most one voucher gives in a day (the tenant's local day).
    uses_per_voucher = Column(Integer, nullable=False, default=1, server_default="1")
    max_uses_per_sale = Column(Integer, nullable=False, default=1, server_default="1")
    max_uses_per_day = Column(Integer, nullable=True)

    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    cancelled_at = Column(DateTime(timezone=True), nullable=True)

    items = relationship(
        "PrepaidVoucherBatchItem",
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="PrepaidVoucherBatchItem.sort_order",
    )
    vouchers = relationship("PrepaidVoucher", back_populates="batch", cascade="all, delete-orphan")


class PrepaidVoucherBatchItem(Base):
    __tablename__ = "prepaid_voucher_batch_items"
    __table_args__ = (
        UniqueConstraint("batch_id", "product_id", name="uq_prepaid_voucher_batch_items_product"),
        CheckConstraint("quantity > 0", name="ck_prepaid_voucher_batch_items_quantity"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    batch_id = Column(
        UUID(as_uuid=True),
        ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: The global (catalog) product.
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False)
    #: The product's name when the batch was made — what the voucher prints.
    product_name = Column(String(255), nullable=False)
    quantity = Column(Integer, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)

    batch = relationship("PrepaidVoucherBatch", back_populates="items")


class PrepaidVoucher(Base):
    __tablename__ = "prepaid_vouchers"
    __table_args__ = (
        UniqueConstraint("batch_id", "serial", name="uq_prepaid_vouchers_batch_serial"),
        CheckConstraint(
            "status IN ('active', 'partially_used', 'used', 'cancelled')",
            name="ck_prepaid_vouchers_status",
        ),
        Index("ix_prepaid_vouchers_batch_group", "batch_id", "group_no"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    batch_id = Column(
        UUID(as_uuid=True),
        ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    serial = Column(Integer, nullable=False)
    #: The voucher's group within its batch (1..n), fixed when it was issued; null: the
    #: batch was not made in groups. See `PrepaidVoucherBatch.group_size`.
    group_no = Column(Integer, nullable=True)
    #: Random, unguessable, unique everywhere; the QR carries "PV:" + this.
    code = Column(String(32), nullable=False, unique=True, index=True)
    #: {global product id: quantity still to be taken}. Empty for a discount voucher.
    remaining = Column(JSON, nullable=False)
    #: A discount voucher's uses not yet taken (held reservations still count as left:
    #: a use is taken when the sale is confirmed). Null for `items`.
    uses_left = Column(Integer, nullable=True)
    status = Column(String(16), nullable=False, default="active", server_default="active")
    #: Free text from the dashboard ("נמסר לדני — במה"); shown there and in the till's lookup.
    note = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    first_redeemed_at = Column(DateTime(timezone=True), nullable=True)
    last_redeemed_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)

    batch = relationship("PrepaidVoucherBatch", back_populates="vouchers")
    redemptions = relationship(
        "PrepaidVoucherRedemption",
        back_populates="voucher",
        cascade="all, delete-orphan",
        order_by="PrepaidVoucherRedemption.redeemed_at",
    )


class PrepaidVoucherRedemption(Base):
    __tablename__ = "prepaid_voucher_redemptions"
    __table_args__ = (
        UniqueConstraint(
            "machine_id", "client_request_id", name="uq_prepaid_voucher_redemptions_request"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    voucher_id = Column(
        UUID(as_uuid=True),
        ForeignKey("prepaid_vouchers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    batch_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    #: The till's signed-in employee as the till reports them (free text, like
    #: `transactions.cashier_id`).
    pos_user_id = Column(String(100), nullable=True)
    pos_user_name = Column(String(200), nullable=True)
    client_request_id = Column(String(100), nullable=False)
    #: The till's sale document for the goods, when it said which (client-generated id;
    #: no foreign key — the document reaches the cloud later, with the till's sync).
    transaction_id = Column(String(100), nullable=True)
    #: [{productId, name, quantity}] taken now.
    items = Column(JSON, nullable=False)
    #: [{productId, name, quantity}] given up (one-time redemption of part of a voucher).
    forfeited = Column(JSON, nullable=True)
    redeemed_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: Set when the till undid it (the payment it was part of was abandoned): its goods
    #: went back on the voucher. Kept, not deleted, so the history shows it.
    reversed_at = Column(DateTime(timezone=True), nullable=True)
    #: The till's sale (basket) the voucher was used in, as the till named it — how the
    #: stacking rules see the other vouchers of one sale before its document exists.
    sale_ref = Column(String(100), nullable=True)
    #: A discount voucher's use: how many uses it took, the ₪ it took off (agorot, as the
    #: document says), and the reservation it confirmed. Null on a goods redemption.
    uses = Column(Integer, nullable=True)
    discount_amount = Column(Integer, nullable=True)
    reservation_id = Column(UUID(as_uuid=True), nullable=True)
    #: What the cloud's re-check found wrong when the use was confirmed (the document is
    #: fiscal and already issued, so it is recorded and flagged, never refused): `late`,
    #: `over_use`, `over_daily`, `over_sale`, `stacking`, `promotion`. Null: nothing.
    flags = Column(JSON, nullable=True)

    voucher = relationship("PrepaidVoucher", back_populates="redemptions")
    machine = relationship("POSMachine")


class PrepaidVoucherReservation(Base):
    """
    A discount voucher held for one open sale at one till: applied to the basket, not yet
    paid. Held for `RESERVATION_TTL` (renewed while the till keeps asking), then confirmed
    by the sale's document (`confirm`, or the document itself through the till's outbox),
    released (removed from the basket, sale cancelled), or left to expire. Idempotent per
    till by `client_request_id`, like a redemption.
    """

    __tablename__ = "prepaid_voucher_reservations"
    __table_args__ = (
        UniqueConstraint(
            "machine_id", "client_request_id", name="uq_prepaid_voucher_reservations_request"
        ),
        Index("ix_prepaid_voucher_reservations_voucher", "voucher_id", "status"),
        Index("ix_prepaid_voucher_reservations_sale", "machine_id", "sale_ref"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    voucher_id = Column(
        UUID(as_uuid=True),
        ForeignKey("prepaid_vouchers.id", ondelete="CASCADE"),
        nullable=False,
    )
    batch_id = Column(UUID(as_uuid=True), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    client_request_id = Column(String(100), nullable=False)
    #: The till's sale (basket) it is held for.
    sale_ref = Column(String(100), nullable=False)
    #: Uses held, and what the cloud computed the discount to be when it was held
    #: (agorot; the basket may change after — the document says what was taken).
    uses = Column(Integer, nullable=False, default=1, server_default="1")
    amount = Column(Integer, nullable=True)
    status = Column(String(16), nullable=False, default="held", server_default="held")
    expires_at = Column(DateTime(timezone=True), nullable=False)
    pos_user_id = Column(String(100), nullable=True)
    pos_user_name = Column(String(200), nullable=True)
    #: The sale's document, once confirmed (client-generated id, like a redemption's).
    transaction_id = Column(String(100), nullable=True)
    redemption_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    confirmed_at = Column(DateTime(timezone=True), nullable=True)
    released_at = Column(DateTime(timezone=True), nullable=True)

    voucher = relationship("PrepaidVoucher")


class TransactionVoucherDiscount(Base):
    """
    One discount voucher on one sale document, as the till printed it ("שובר #12 — פסטיבל
    הקיץ"): what it took off, inside the document's `document_discount` (each line's share
    is `transaction_items.voucher_discount`). A discount, never a tender. Replaced with
    the document on a re-push, like its promotions.
    """

    __tablename__ = "transaction_voucher_discounts"
    __table_args__ = (
        Index("ix_transaction_voucher_discounts_transaction", "transaction_id"),
        Index("ix_transaction_voucher_discounts_batch", "batch_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    transaction_id = Column(
        UUID(as_uuid=True), ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False
    )
    #: Not foreign keys: the document keeps naming them whatever happens to the batch.
    reservation_id = Column(UUID(as_uuid=True), nullable=True)
    voucher_id = Column(UUID(as_uuid=True), nullable=True)
    batch_id = Column(UUID(as_uuid=True), nullable=True)
    serial = Column(Integer, nullable=True)
    batch_name = Column(String(200), nullable=True)
    kind = Column(String(16), nullable=True)
    uses = Column(Integer, nullable=False, default=1, server_default="1")
    discount_amount = Column(Numeric(12, 2), nullable=False, default=0, server_default="0")
    #: [{"itemId", "amount"}] — the lines it took its discount from (shekels).
    lines = Column(JSON, nullable=True)


#: `prepaid_voucher_events.action`.
PREPAID_EVENT_ACTIONS = (
    "create",          # the batch was made (count, groups)
    "add",             # more vouchers issued (count, groups)
    "assign_groups",   # an ungrouped batch split into groups
    "update",          # print settings / texts changed
    "cancel_batch",
    "cancel_group",    # a whole group (a lost envelope) cancelled
    "cancel_voucher",
    "use_flagged",     # a discount voucher's use confirmed against the rules (see `flags`)
)


class PrepaidVoucherEvent(Base):
    """
    A batch's audit trail ("יומן"): who made it, issued more, grouped it, cancelled a group
    (a lost envelope), a voucher or the whole batch — when, and why. Never edited.
    """

    __tablename__ = "prepaid_voucher_events"
    __table_args__ = (Index("ix_prepaid_voucher_events_batch", "batch_id", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    batch_id = Column(
        UUID(as_uuid=True),
        ForeignKey("prepaid_voucher_batches.id", ondelete="CASCADE"),
        nullable=False,
    )
    action = Column(String(32), nullable=False)
    group_no = Column(Integer, nullable=True)
    voucher_id = Column(UUID(as_uuid=True), nullable=True)
    #: How many vouchers the action touched (issued, cancelled …).
    count = Column(Integer, nullable=True)
    reason = Column(Text, nullable=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(200), nullable=True)
    #: Anything else worth keeping: the serial range, the group size, the fields changed.
    details = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
