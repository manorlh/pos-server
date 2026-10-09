import uuid

from sqlalchemy import (
    Column, String, ForeignKey, Numeric, Integer, Text, Index, JSON,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.database import Base


class TransactionItem(Base):
    """A single line item on a transaction. id is client-generated UUID."""

    __tablename__ = "transaction_items"
    __table_args__ = (
        Index("ix_transaction_items_transaction", "transaction_id"),
        Index("ix_transaction_items_refund_of_item", "refund_of_item_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated
    transaction_id = Column(
        UUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False,
    )
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=True)

    # Snapshot of product info at time of sale (so historical receipts survive product edits)
    product_name = Column(String(255), nullable=True)
    sku = Column(String(100), nullable=True)

    quantity = Column(Numeric(12, 3), nullable=False)
    unit_price = Column(Numeric(12, 2), nullable=False)
    total_price = Column(Numeric(12, 2), nullable=False)
    discount = Column(Numeric(12, 2), nullable=True)
    discount_type = Column(String(20), nullable=True)
    transaction_type = Column(Integer, nullable=True)
    line_discount = Column(Numeric(12, 2), nullable=True)
    notes = Column(Text, nullable=True)
    #: On a credit-note line returned from a receipt: the original sale line
    #: (`transaction_items.id`) it credits. Not a foreign key, for the reason
    #: `transactions.refund_of_transaction_id` is not one — the original may reach the
    #: cloud after its credit note. Resolved within the tenant when read; it settles the
    #: original per line and names the base document of the line in the tax export.
    refund_of_item_id = Column(UUID(as_uuid=True), nullable=True)
    #: The line's share of what promotions ("מבצעים") took off, as an amount. Distinct
    #: from `discount` (the cashier's own line discount), and like it inside the
    #: document's `document_discount`, never in `total_price` (gross). Null: none.
    promotion_discount = Column(Numeric(12, 2), nullable=True)
    #: The promotion that took it (the largest share, when several did). Not a key.
    promotion_id = Column(UUID(as_uuid=True), nullable=True)
    #: The line's share of what discount vouchers ("שוברי הנחה", prepaid vouchers of a
    #: discount kind) took off, as an amount — like `promotion_discount`, inside the
    #: document's `document_discount`, never in `total_price`, never a tender. The
    #: vouchers themselves: `transaction_voucher_discounts`. Null: none.
    voucher_discount = Column(Numeric(12, 2), nullable=True)
    #: Production vouchers (the production vouchers contract §4): a `discount`-mode deduction's
    #: share of the line (inside `document_discount`), and a `zero`-mode ₪0 line's memo value
    #: (agorot, the unit's list value × quantity) with its redemption. Null: none.
    prepaid_deduction = Column(Numeric(12, 2), nullable=True)
    voucher_memo_value = Column(Integer, nullable=True)
    voucher_redemption_id = Column(String(100), nullable=True)
    #: What the dish was ordered with, as the till sent it (docs/SPEC_MENU_MODIFIERS.md
    #: §3.8): modifiers, notes, allergies, seat, course, a meal's components. Taken apart
    #: for the reports into `transaction_item_parts`. Null: a plain line.
    details = Column(JSON, nullable=True)
    #: The upsell rule ("הגדלת מכירה") the line was added by, when it was. Not a key.
    upsell_rule_id = Column(UUID(as_uuid=True), nullable=True)
    #: OTH ("על חשבון הבית", till parameter `othEnabled`): the reason the line was given
    #: free — a 100% line discount, in `discount` like any other. Null: an ordinary line.
    oth_reason = Column(String(100), nullable=True)
    #: The till user who gave it, and who approved it (a till user's or a cloud account's
    #: id, as the till sent them; free text like `transactions.cashier_id`).
    oth_by = Column(String(100), nullable=True)
    oth_approved_by = Column(String(100), nullable=True)
    #: "הודעות לעובד על פריט" (app/services/product_alerts.py): the employee confirmed the
    #: product's alerts before it was added — `[{at, by, byName, alerts: [{text, kind}]}]`,
    #: one per confirmed add. Null: nothing had to be confirmed.
    alerts_ack = Column(JSON, nullable=True)
    #: "תפריטים" (docs/SPEC_MENUS.md): the menu that was active on the till when the line
    #: was added, as the till sent it — not a key (a deleted menu stays named) — its name
    #: then, and where the line's price came from: "menu" (the menu's own price) or
    #: "catalog". Null: no menu was active, or a till that predates menus.
    menu_id = Column(UUID(as_uuid=True), nullable=True)
    menu_name = Column(String(80), nullable=True)
    price_source = Column(String(16), nullable=True)

    transaction = relationship("Transaction", back_populates="items")
    product = relationship("Product")
