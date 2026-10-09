"""
"פקודות שנשלחו" — the dashboard's `Idempotency-Key` for a command to a device
(app/services/command_idempotency.py).

The dashboard sends every command fire-and-forget and may retry it (a dropped connection, a
second click, "נסה שוב" after a network error). One row per key the first request answered:
a retry with the same key gets that very answer back — the same command ids — and never makes
a second command. The key is the client's (a uuid), scoped to the tenant and the kind of
command; the request's fingerprint keeps a key from being reused for a different request.
"""
import uuid

from sqlalchemy import Column, DateTime, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class CommandRequestKey(Base):
    __tablename__ = "command_request_keys"
    __table_args__ = (
        UniqueConstraint("tenant_id", "kind", "key", name="uq_command_request_keys_key"),
        Index("ix_command_request_keys_created", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), nullable=True)
    #: "device_command" | "card_command" | "kiosk_command" | "till_message" | "printer_test" …
    kind = Column(String(32), nullable=False)
    key = Column(String(100), nullable=False)
    #: Who sent it: another user's key is never answered with this one's response.
    user_id = Column(UUID(as_uuid=True), nullable=True)
    #: SHA-256 of the request (its path's target and body): the same key for another request → 422.
    fingerprint = Column(String(64), nullable=False)
    #: The first answer, as the endpoint returned it (its status code beside it).
    response = Column(JSONB, nullable=True)
    status_code = Column(Integer, nullable=False, default=201, server_default="201")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
