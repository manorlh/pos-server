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
    #: What the dish was ordered with, as the till sent it (docs/SPEC_MENU_MODIFIERS.md
    #: §3.8): modifiers, notes, allergies, seat, course, a meal's components. Taken apart
    #: for the reports into `transaction_item_parts`. Null: a plain line.
    details = Column(JSON, nullable=True)
    #: The upsell rule ("הגדלת מכירה") the line was added by, when it was. Not a key.
    upsell_rule_id = Column(UUID(as_uuid=True), nullable=True)

    transaction = relationship("Transaction", back_populates="items")
    product = relationship("Product")
