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


#: `prepaid_voucher_types.pricing` (the spec's §5): `fixed` — the redeemed goods come to the
#: voucher's till value; `cover` — list prices, the voucher pays up to its value.
PREPAID_TYPE_PRICINGS = ("fixed", "cover")
#: `discount_block_policy` (the spec's §7): a product that takes no discounts ("לא מקבל הנחות")
#: is never lowered (`honour`), lowered within the caps (`auto`), or with a manager (`manager`).
PREPAID_DISCOUNT_BLOCK_POLICIES = ("honour", "auto", "manager")
#: `redemption_accounting` — how the till books a redemption (the owner, 08.10.2026):
#: `discount` "קיזוז מהחשבונית (כמו הנחה)" — a document-level deduction through the document
#: discount (items ₪50, voucher −₪40: the document is ₪10, VAT on ₪10, no voucher leg); the
#: default for new vouchers. `payment` "אמצעי תשלום (חייב במע״מ)" — the `production_voucher`
#: tender, full VAT, in the Z like any tender. `zero` "₪0 עם הצגת שווי" — ₪0 lines with the
#: value as a memo, outside the totals; every batch made before types.
PREPAID_REDEMPTION_ACCOUNTING = ("discount", "payment", "zero")
#: Where a type came from: `manual` (the types screen), `batch` (made with a batch that named
#: no type — one batch's own terms), `legacy` (a batch made before types, migrated).
PREPAID_TYPE_ORIGINS = ("manual", "batch", "legacy")


class PrepaidVoucherType(Base):
    """
    "סוג שובר" (the spec's §2–3): the business template a batch is issued from — "שובר ארוחה",
    "שובר משקה". What a voucher gives, its value at the till and its price to the production,
    how it is priced and recorded. A batch copies all of it when issued (with the type's
    `version`), so a later change never touches vouchers already handed out. Every batch has
    one (§19.1): a batch made before types got a `legacy` type of its own.
    """

    __tablename__ = "prepaid_voucher_types"
    __table_args__ = (
        CheckConstraint("pricing IN ('fixed', 'cover')", name="ck_prepaid_voucher_types_pricing"),
        CheckConstraint(
            "discount_block_policy IN ('honour', 'auto', 'manager')",
            name="ck_prepaid_voucher_types_discount_block_policy",
        ),
        CheckConstraint(
            "redemption_accounting IN ('discount', 'payment', 'zero')",
            name="ck_prepaid_voucher_types_redemption_accounting",
        ),
        CheckConstraint(
            "kind IN ('items', 'order_discount', 'item_discount')", name="ck_prepaid_voucher_types_kind"
        ),
        Index("ix_prepaid_voucher_types_company", "tenant_id", "company_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False)
    #: "MEAL", "DRINK" — short, unique among the company's active manual types.
    code = Column(String(32), nullable=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    origin = Column(String(16), nullable=False, default="manual", server_default="manual")
    #: Off: no new batches from it; its batches are untouched.
    active = Column(Boolean, nullable=False, default=True, server_default="true")
    #: Bumped by every change of its terms; a batch keeps the version it was issued with.
    version = Column(Integer, nullable=False, default=1, server_default="1")

    kind = Column(String(16), nullable=False, default="items", server_default="items")
    #: "שווי בקופה" and "מחיר מכירה להפקה" — each for the whole voucher, in agorot, independent.
    till_value = Column(Integer, nullable=True)
    production_price = Column(Integer, nullable=True)
    pricing = Column(String(8), nullable=False, default="fixed", server_default="fixed")
    #: `cover`: the customer may pay what the goods cost above the value ("השלמת תשלום").
    allow_top_up = Column(Boolean, nullable=False, default=True, server_default="true")
    #: How the till books a redemption — `discount` (default) / `payment` / `zero`, see
    #: PREPAID_REDEMPTION_ACCOUNTING. Copied to a batch, editable there, recorded per redemption.
    redemption_accounting = Column(String(16), nullable=False, default="discount", server_default="discount")
    #: "הצג תוקף על השובר" — off: the paper leaves out the validity and the terms line under it
    #: (still enforced at redemption).
    show_validity = Column(Boolean, nullable=False, default=True, server_default="true")
    #: Products that take no discounts (§7): `honour` / `auto` / `manager`, with optional caps —
    #: agorot off one unit, basis points off one unit, agorot off one voucher's redemption — and
    #: scope (`{"productIds", "categoryIds"}`; null: every product of the voucher).
    discount_block_policy = Column(String(16), nullable=False, default="honour", server_default="honour")
    override_max_amount = Column(Integer, nullable=True)
    override_max_percent = Column(Integer, nullable=True)
    override_max_total = Column(Integer, nullable=True)
    override_scope = Column(JSON, nullable=True)
    #: "מימוש ללא אינטרנט": its batches may be assigned to a till / the shop's LAN host.
    offline_allowed = Column(Boolean, nullable=False, default=False, server_default="false")
    split_allowed = Column(Boolean, nullable=False, default=False, server_default="false")
    include_extras = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Print the till value on the voucher ("שווי השובר: ₪80"). The production price never is.
    print_till_value = Column(Boolean, nullable=False, default=False, server_default="false")

    # Discount kinds' terms — as on a batch (docs/SPEC_VOUCHER_PRODUCTION.md §7).
    discount_type = Column(String(8), nullable=True)
    discount_value = Column(Integer, nullable=True)
    min_purchase = Column(Integer, nullable=True)
    max_discount = Column(Integer, nullable=True)
    max_units = Column(Integer, nullable=True)
    targets = Column(JSON, nullable=True)
    #: "שובר אחד בעסקה" (`single`) / "כמה שוברים בעסקה" (`unlimited`, a new type's default — the form's) /
    #: "כמה שוברים, רק מסוגים שונים" (`distinct_batches`).
    stacking = Column(String(24), nullable=False, default="single", server_default="single")
    #: "מספר שוברים מקסימלי בעסקה" — with `unlimited` / `distinct_batches` only; null: no maximum.
    max_vouchers_per_sale = Column(Integer, nullable=True)
    #: "items" (a fixed list, `items`) or "groups" ([{key, name, minQty, maxQty, value (agorot | null),
    #: allowRepeat, allItems, productIds, categoryIds, includeSubcategories, excludeProductIds,
    #: excludeCategoryIds, sortOrder}] — the production vouchers contract §1). A batch's groups also
    #: carry `frozenProductIds`, the catalog as it was at issue (`catalog_mode` frozen).
    selection = Column(String(8), nullable=False, default="items", server_default="items")
    groups = Column(JSON, nullable=True)
    #: Units per voucher across the groups (3 for a meal, 1 for "one of several"); null: Σ the groups' max.
    total_qty = Column(Integer, nullable=True)
    catalog_mode = Column(String(8), nullable=False, default="frozen", server_default="frozen")
    promotion_policy = Column(String(16), nullable=False, default="exclude", server_default="exclude")
    uses_per_voucher = Column(Integer, nullable=False, default=1, server_default="1")
    max_uses_per_sale = Column(Integer, nullable=False, default=1, server_default="1")
    max_uses_per_day = Column(Integer, nullable=True)

    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    items = relationship(
        "PrepaidVoucherTypeItem",
        back_populates="type",
        cascade="all, delete-orphan",
        order_by="PrepaidVoucherTypeItem.sort_order",
    )


class PrepaidVoucherTypeItem(Base):
    """A type's goods: what each voucher of it gives ("מנה + תוספת + משקה")."""

    __tablename__ = "prepaid_voucher_type_items"
    __table_args__ = (
        UniqueConstraint("type_id", "product_id", name="uq_prepaid_voucher_type_items_product"),
        CheckConstraint("quantity > 0", name="ck_prepaid_voucher_type_items_quantity"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    type_id = Column(
        UUID(as_uuid=True),
        ForeignKey("prepaid_voucher_types.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False)
    product_name = Column(String(255), nullable=False)
    quantity = Column(Numeric(10, 3), nullable=False)
    weighed = Column(Boolean, nullable=False, default=False, server_default="false")
    unit_label = Column(String(16), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    type = relationship("PrepaidVoucherType", back_populates="items")


class PrepaidVoucherTypeEvent(Base):
    """A type's audit trail: who made or changed it, when, and what changed (before → after)."""

    __tablename__ = "prepaid_voucher_type_events"
    __table_args__ = (Index("ix_prepaid_voucher_type_events_type", "type_id", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    type_id = Column(
        UUID(as_uuid=True), ForeignKey("prepaid_voucher_types.id", ondelete="CASCADE"), nullable=False
    )
    #: create / update / activate / deactivate
    action = Column(String(32), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(200), nullable=True)
    #: {"fields": [...], "before": {...}, "after": {...}, "version": n}
    details = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PrepaidVoucherBatch(Base):
    __tablename__ = "prepaid_voucher_batches"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'cancelled')", name="ck_prepaid_voucher_batches_status"),
        CheckConstraint(
            "kind IN ('items', 'order_discount', 'item_discount')", name="ck_prepaid_voucher_batches_kind"
        ),
        # The batch list and the reports read a tenant's batches by issue date.
        Index("ix_prepaid_voucher_batches_tenant_created", "tenant_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=False, index=True)
    #: The shops whose tills may redeem, as a list of shop id strings. Null: every shop
    #: of the company.
    shop_ids = Column(JSON, nullable=True)

    # ── Its type (the spec's §2), copied when issued: a later change of the type never
    # touches the batch. Every batch has one (§19.1).
    type_id = Column(UUID(as_uuid=True), ForeignKey("prepaid_voucher_types.id"), nullable=False, index=True)
    type_version = Column(Integer, nullable=False, default=1, server_default="1")
    type_code = Column(String(32), nullable=True)
    type_name = Column(String(200), nullable=True)
    #: Agorot, from the type: "שווי בקופה" and "מחיר מכירה להפקה" (never printed, never shown
    #: to a cashier; the dashboard shows it only with the `prepaid_voucher_prices` section).
    till_value = Column(Integer, nullable=True)
    production_price = Column(Integer, nullable=True)
    #: Every batch made before types: `cover` with no value and `zero` accounting (₪0 lines with
    #: the value shown) — editable on the batch; each redemption records the mode it used.
    pricing = Column(String(8), nullable=False, default="cover", server_default="cover")
    allow_top_up = Column(Boolean, nullable=False, default=True, server_default="true")
    redemption_accounting = Column(String(16), nullable=False, default="zero", server_default="zero")
    #: "הצג תוקף על השובר" — off: the paper leaves out the validity and the terms line under it
    #: (still enforced at redemption).
    show_validity = Column(Boolean, nullable=False, default=True, server_default="true")
    discount_block_policy = Column(String(16), nullable=False, default="honour", server_default="honour")
    override_max_amount = Column(Integer, nullable=True)
    override_max_percent = Column(Integer, nullable=True)
    override_max_total = Column(Integer, nullable=True)
    override_scope = Column(JSON, nullable=True)
    offline_allowed = Column(Boolean, nullable=False, default=False, server_default="false")
    print_till_value = Column(Boolean, nullable=False, default=False, server_default="false")

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
    #: "הצגת הפריטים על השובר": print the goods (a discount voucher: what it gives) on the
    #: voucher. Off: title, free text, validity, barcode, code and serial only — the till
    #: still knows what the voucher is worth. On by default, and every batch before it.
    show_items = Column(Boolean, nullable=False, default=True, server_default="true")
    #: "נוצר על ידי Runner Systems" in small print at the bottom of the voucher. On by
    #: default, and every batch before it.
    show_credit = Column(Boolean, nullable=False, default=True, server_default="true")
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
    #: Other vouchers in the same sale: `single` ("שובר אחד בעסקה", no other),
    #: `unlimited` ("כמה שוברים בעסקה", a new type's default) or `distinct_batches` ("כמה
    #: שוברים, רק מסוגים שונים"). The migration gave every batch made before kinds `unlimited`
    #: (what the tills did then); a batch keeps its value.
    stacking = Column(String(24), nullable=False, default="single", server_default="single")
    #: "מספר שוברים מקסימלי בעסקה" — with `unlimited` / `distinct_batches` only: the most
    #: vouchers one sale holds, this one included. Null: no maximum.
    max_vouchers_per_sale = Column(Integer, nullable=True)
    #: "items" (a fixed list, `items`) or "groups" ([{key, name, minQty, maxQty, value (agorot | null),
    #: allowRepeat, allItems, productIds, categoryIds, includeSubcategories, excludeProductIds,
    #: excludeCategoryIds, sortOrder}] — the production vouchers contract §1). A batch's groups also
    #: carry `frozenProductIds`, the catalog as it was at issue (`catalog_mode` frozen).
    selection = Column(String(8), nullable=False, default="items", server_default="items")
    groups = Column(JSON, nullable=True)
    #: Units per voucher across the groups (3 for a meal, 1 for "one of several"); null: Σ the groups' max.
    total_qty = Column(Integer, nullable=True)
    catalog_mode = Column(String(8), nullable=False, default="frozen", server_default="frozen")
    #: A discount voucher on a line that has a promotion: `exclude` (never — the line is
    #: left out), `best` (the bigger of the two, never both) or `combine` (both).
    promotion_policy = Column(String(16), nullable=False, default="exclude", server_default="exclude")
    #: Discount kinds: uses per voucher, the most of them one sale takes, and (optional)
    #: the most one voucher gives in a day (the tenant's local day).
    uses_per_voucher = Column(Integer, nullable=False, default=1, server_default="1")
    max_uses_per_sale = Column(Integer, nullable=False, default=1, server_default="1")
    max_uses_per_day = Column(Integer, nullable=True)
    #: Goods: "כולל תוספות" — a dish's paid options and a meal's upcharges are covered too.
    #: False (the default, and every batch before it): the base price as listed is covered,
    #: the extras are paid at the till (docs/SPEC_VOUCHER_PRODUCTION.md §7.14).
    include_extras = Column(Boolean, nullable=False, default=False, server_default="false")

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
    #: Units; a product sold by weight in its unit, to the gram ("0.5" ק״ג). Whole for any
    #: other product (the form refuses a fraction of one sold by the piece).
    quantity = Column(Numeric(10, 3), nullable=False)
    #: Sold by weight when the batch was made, and its unit as printed ("ק״ג").
    weighed = Column(Boolean, nullable=False, default=False, server_default="false")
    unit_label = Column(String(16), nullable=True)
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
        # The vouchers' state filters ("פתוחים", "מומשו") per batch.
        Index("ix_prepaid_vouchers_batch_status", "batch_id", "status"),
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
    #: {global product id: quantity still to be taken} — an int, or a weight to the gram (0.25).
    #: Empty for a discount voucher.
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
        # The reports: redemptions of the batches in scope by time, per till, per voucher.
        Index("ix_prepaid_voucher_redemptions_batch_time", "batch_id", "redeemed_at"),
        Index("ix_prepaid_voucher_redemptions_machine_time", "machine_id", "redeemed_at"),
        Index("ix_prepaid_voucher_redemptions_voucher", "voucher_id"),
        # An offline redemption is synced once, by the device's own id (§7).
        Index("ux_prepaid_voucher_redemptions_client", "tenant_id", "client_redemption_id", unique=True),
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
    # ── The redemption record (the production vouchers contract §5) ──
    #: How it was booked (the batch's `redemption_accounting` then) and priced.
    redemption_accounting = Column(String(16), nullable=True)
    pricing = Column(String(8), nullable=True)
    #: Agorot: what it was worth, what the voucher covered on the document (the tender / the
    #: deduction; 0 for ₪0 lines), the customer's top-up, and the units' list / menu value.
    value_agorot = Column(Integer, nullable=True)
    covered_agorot = Column(Integer, nullable=True)
    top_up_agorot = Column(Integer, nullable=True)
    list_value_agorot = Column(Integer, nullable=True)
    #: Per unit: {productId, productName, groupKey, groupName, quantity, listPriceAgorot,
    #: listValueAgorot, valueAgorot, coveredAgorot, forced, reductionAgorot}.
    units = Column(JSON, nullable=True)
    #: Snapshot names: the voucher's number, its type, its production, its batch.
    serial = Column(Integer, nullable=True)
    type_name = Column(String(200), nullable=True)
    production_name = Column(String(200), nullable=True)
    batch_name = Column(String(200), nullable=True)
    #: Redeemed without the cloud (an offline assignment, §7): the device's own id for it.
    offline = Column(Boolean, nullable=False, default=False, server_default="false")
    assignment_id = Column(UUID(as_uuid=True), nullable=True)
    client_redemption_id = Column(String(100), nullable=True)
    #: The manager who approved a forced discount (§6).
    approved_by_pos_user_id = Column(String(100), nullable=True)
    approved_by_pos_user_name = Column(String(200), nullable=True)

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
    #: A goods voucher's hold (the production vouchers contract §3): the units, their values,
    #: the accounting mode, pricing, top-up and approval the reserve answered — what the
    #: confirm books when the basket did not change.
    goods = Column(JSON, nullable=True)

    voucher = relationship("PrepaidVoucher")


#: `transaction_voucher_discounts.kind` of a production voucher booked as a document deduction
#: ("קיזוז מהחשבונית", `redemption_accounting` discount): inside `document_discount` like a
#: discount, but never "a discount" in a management report — its own category, "שוברי הפקה".
PRODUCTION_VOUCHER_DEDUCTION = "production_voucher"


class TransactionVoucherDiscount(Base):
    """
    One discount voucher on one sale document, as the till printed it ("שובר #12 — פסטיבל
    הקיץ"): what it took off, inside the document's `document_discount` (each line's share
    is `transaction_items.voucher_discount`). A discount, never a tender. Replaced with
    the document on a re-push, like its promotions.

    `kind` `production_voucher`: a production voucher's deduction ("קיזוז שוברי הפקה", the
    contract's §4.1) — inside `document_discount` too (the uniform file files the document as
    issued), never in the lines' `voucher_discount`, and reported as "שוברי הפקה", not as a
    discount. It names its redemption, its type and the units it covered (the receipt's lines).
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
    kind = Column(String(32), nullable=True)
    uses = Column(Integer, nullable=False, default=1, server_default="1")
    discount_amount = Column(Numeric(12, 2), nullable=False, default=0, server_default="0")
    #: [{"itemId", "amount"}] — the lines it took its discount from (shekels).
    lines = Column(JSON, nullable=True)
    #: A production voucher's deduction: its redemption, its type's name, and the units it
    #: covered — [{"productName", "groupName", "quantity"}], as the receipt lists them.
    redemption_id = Column(UUID(as_uuid=True), nullable=True)
    type_name = Column(String(200), nullable=True)
    units = Column(JSON, nullable=True)


class PrepaidVoucherOverrideAudit(Base):
    """
    One forced price reduction on a "לא מקבל הנחות" product (the production vouchers contract §6,
    the spec's `VoucherDiscountOverrideAudit`): which unit, its list price and value, the
    reduction, the policy and the type version that allowed it, who approved, where and when.
    """

    __tablename__ = "prepaid_voucher_override_audits"
    __table_args__ = (
        Index("ix_prepaid_voucher_override_audits_batch", "batch_id", "created_at"),
        Index("ix_prepaid_voucher_override_audits_redemption", "redemption_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    redemption_id = Column(UUID(as_uuid=True), nullable=True)
    voucher_id = Column(UUID(as_uuid=True), nullable=True)
    batch_id = Column(UUID(as_uuid=True), nullable=False)
    type_id = Column(UUID(as_uuid=True), nullable=True)
    type_version = Column(Integer, nullable=True)
    product_id = Column(String(100), nullable=True)
    product_name = Column(String(255), nullable=True)
    quantity = Column(Numeric(12, 3), nullable=True)
    list_price_agorot = Column(Integer, nullable=False)
    value_agorot = Column(Integer, nullable=False)
    reduction_agorot = Column(Integer, nullable=False)
    #: The reduction as basis points of the list price (2000 = 20%).
    reduction_bp = Column(Integer, nullable=False)
    policy = Column(String(16), nullable=False)
    approved_by_pos_user_id = Column(String(100), nullable=True)
    approved_by_pos_user_name = Column(String(200), nullable=True)
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    pos_user_id = Column(String(100), nullable=True)
    pos_user_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


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
    "offline_assign",          # assigned to a till / the shop's LAN host (§7)
    "offline_release",         # released after the device synced everything
    "offline_force_release",   # released with redemptions still on the device (a reason given)
)


class PrepaidVoucherOfflineAssignment(Base):
    """
    A batch assigned for redemption without the internet (the production vouchers contract §7): to
    one till (`machine`) or to its shop's LAN host (`lan_host`, the shop's main till). While it is
    active the cloud and every other machine refuse the batch's vouchers; the device downloads
    them (code hashes, never codes) and syncs what it redeemed. One active assignment per batch.
    """

    __tablename__ = "prepaid_voucher_offline_assignments"
    __table_args__ = (
        Index("ix_prepaid_voucher_offline_assignments_batch", "batch_id", "status"),
        Index("ix_prepaid_voucher_offline_assignments_machine", "machine_id", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    batch_id = Column(UUID(as_uuid=True), nullable=False)
    #: "machine" or "lan_host".
    target = Column(String(16), nullable=False)
    machine_id = Column(UUID(as_uuid=True), nullable=False)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    #: "active" / "released".
    status = Column(String(16), nullable=False, default="active", server_default="active")
    #: Bumped on every change the device must download again (the batch's terms, a cancelled voucher).
    version = Column(Integer, nullable=False, default=1, server_default="1")
    assigned_by = Column(UUID(as_uuid=True), nullable=True)
    assigned_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_download_at = Column(DateTime(timezone=True), nullable=True)
    last_sync_at = Column(DateTime(timezone=True), nullable=True)
    #: What the device said it still had to send at its last sync.
    last_sync_pending = Column(Integer, nullable=True)
    released_at = Column(DateTime(timezone=True), nullable=True)
    released_by = Column(UUID(as_uuid=True), nullable=True)
    forced = Column(Boolean, nullable=False, default=False, server_default="false")
    release_reason = Column(Text, nullable=True)


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
