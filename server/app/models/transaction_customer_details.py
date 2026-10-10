"""
"הדפס העתק עם פרטי לקוח" (docs/SPEC_CUSTOMER_INVOICE.md §3.5): the customer's details a till added to a
COPY of a document after it was issued.

An issued document is never changed (§23(ב), §18(ב)(2)): this is a separate, append-only record
linked to it — a row per time details were added, who added them and when — and the document's own
row, its lines, its totals and the uniform file's records are not touched by it, whatever it says.
Nothing reads this table into a filing; it is read only by the document's detail in the dashboard
and by the copy printed from it, both labelled as added after issue.

Client id; a resend is a no-op. Never updated, never deleted (it is the audit of who added what
and when). Not a foreign key to the document: it may land before it.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class TransactionCustomerDetails(Base):
    __tablename__ = "transaction_customer_details"
    __table_args__ = (
        Index("ix_transaction_customer_details_transaction", "transaction_id", "added_at"),
        Index("ix_transaction_customer_details_tenant", "tenant_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    #: The document the details were added to (a copy of it printed them).
    transaction_id = Column(UUID(as_uuid=True), nullable=False)
    customer_name = Column(String(255), nullable=False)
    customer_vat_number = Column(String(20), nullable=False)
    customer_address = Column(String(500), nullable=True)
    customer_phone = Column(String(30), nullable=True)
    customer_email = Column(String(255), nullable=True)
    #: Who added them (the till user) and when (the till's clock).
    added_by_id = Column(String(100), nullable=True)
    added_by_name = Column(String(200), nullable=True)
    added_at = Column(DateTime(timezone=True), nullable=False)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
