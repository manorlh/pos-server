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


class PrepaidVoucherBatch(Base):
    __tablename__ = "prepaid_voucher_batches"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'cancelled')", name="ck_prepaid_voucher_batches_status"),
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
    #: {global product id: quantity still to be taken}.
    remaining = Column(JSON, nullable=False)
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

    voucher = relationship("PrepaidVoucher", back_populates="redemptions")
    machine = relationship("POSMachine")


#: `prepaid_voucher_events.action`.
PREPAID_EVENT_ACTIONS = (
    "create",          # the batch was made (count, groups)
    "add",             # more vouchers issued (count, groups)
    "assign_groups",   # an ungrouped batch split into groups
    "update",          # print settings / texts changed
    "cancel_batch",
    "cancel_group",    # a whole group (a lost envelope) cancelled
    "cancel_voucher",
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
