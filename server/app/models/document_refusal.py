"""
"מסמך שנדחה בענן" — every till document the cloud refused, kept so it cannot stay silent.

The owner's rule is that every document issued on a device reaches the cloud. The cloud
still refuses what is not a document at all (a payload it cannot read, a field it cannot
parse, a write the database refuses), and before this a refusal lived only in the till's
outbox and in a `sync_logs` line nobody read: a till's document #80 was refused every hour
for two days (2026-10) and the only trace was a numbering gap.

One row per (till, document as the till identified it). Every refusal of the same document
bumps `attempts` and `last_seen_at` and keeps the latest reason and payload; when the same
document is later stored, `landed_at` is set and the row stays as history. Shown in the
reconciliation report (check `refused_documents`) and on the transmissions page.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class DocumentRefusal(Base):
    __tablename__ = "document_refusals"
    __table_args__ = (
        UniqueConstraint("machine_id", "document_ref", name="uq_document_refusals_machine_ref"),
        Index("ix_document_refusals_tenant_open", "tenant_id", "landed_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    #: The document as the till identified it: its id as sent, or `batch-index:<n>` for a
    #: document that carried no readable id (then every such refusal of the till is one row
    #: per position — the best the cloud can do with nothing to name it by).
    document_ref = Column(String(120), nullable=False)
    #: The id when it reads as a UUID — what `landed_at` is matched on.
    document_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    document_number = Column(String(100), nullable=True)
    document_type = Column(Integer, nullable=True)
    #: When the till says it issued the document (`createdAt` as sent, when readable).
    issued_at = Column(DateTime(timezone=True), nullable=True)
    total_amount = Column(String(40), nullable=True)
    reason = Column(Text, nullable=False)
    attempts = Column(Integer, nullable=False, default=1, server_default="1")
    first_seen_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_seen_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: The document as the till last sent it (capped), so it can be read and replayed.
    payload = Column(JSONB, nullable=True)
    #: Set when the same document was later stored; the row stays as history.
    landed_at = Column(DateTime(timezone=True), nullable=True)
