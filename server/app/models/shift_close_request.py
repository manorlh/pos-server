"""A remote shift close that is not part of a Z."""
from __future__ import annotations

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ShiftCloseRequestStatus:
    #: Waiting for the till to acknowledge the instruction.
    WAITING_CLOSE = "waiting_close"
    #: The till acknowledged it (or deferred it) and is closing.
    CLOSING = "closing"
    #: The shift is closed on the cloud with every document.
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


#: Requests the till still has to act on (handed over on the heartbeat).
PENDING_CLOSE_REQUEST_STATUSES = (
    ShiftCloseRequestStatus.WAITING_CLOSE,
    ShiftCloseRequestStatus.CLOSING,
)


class ShiftCloseRequest(Base):
    """
    An operator asked a till to close its open shift, without producing a Z.

    It reaches the till exactly as a Z run's close does — the `close-shift` Ably event
    and `pendingCloseShift` on the heartbeat, with this row's id as the `requestId` — so
    a till in the field needs no change to answer it: its `shift-close/ack` and the
    `closeRequestId` of its close resolve here (`app.services.shift_close_requests`).

    The closed shift is then an ordinary candidate for the shop's next Z. Statuses are
    plain strings (see `ShiftCloseRequestStatus`); a request not answered within 36 h
    expires, like a Z run's items.
    """

    __tablename__ = "shift_close_requests"
    __table_args__ = (Index("ix_shift_close_requests_machine_status", "machine_id", "status"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    #: The open shift the till is asked to close. NULL only if neither the cloud nor the
    #: till's heartbeat named one; the till's ack fills it in.
    shift_id = Column(UUID(as_uuid=True), ForeignKey("shifts.id"), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    status = Column(String(16), nullable=False, default=ShiftCloseRequestStatus.WAITING_CLOSE)
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    failed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    machine = relationship("POSMachine")
    shift = relationship("Shift", foreign_keys=[shift_id])
