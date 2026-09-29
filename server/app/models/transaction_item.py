import uuid

from sqlalchemy import (
    Column, String, ForeignKey, Numeric, Integer, Text, Index,
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

    transaction = relationship("Transaction", back_populates="items")
    product = relationship("Product")
