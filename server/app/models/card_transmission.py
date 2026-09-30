"""
Card transaction transmission to Shva (שידור עסקאות) — docs/SHIFTS_API.md §4.

The Nova's card application stores approved card transactions and deposits them only when
the till calls `doPeriodic`. Every attempt is reported here as one `CardTransmission`; the
terminal uids it carried are kept as `CardTransmissionItem` rows, so a card leg whose
document reaches the cloud after the report can still be matched to it
(`app.services.transmissions`).
"""
from __future__ import annotations

import uuid

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class TransmissionTrigger:
    SHIFT_CLOSE = "shift_close"
    DAILY = "daily"
    MANUAL = "manual"
    REMOTE = "remote"


TRANSMISSION_TRIGGERS = (
    TransmissionTrigger.SHIFT_CLOSE,
    TransmissionTrigger.DAILY,
    TransmissionTrigger.MANUAL,
    TransmissionTrigger.REMOTE,
)


class TransmissionStatus:
    SUCCESS = "success"
    FAILED = "failed"
    #: No reply, or a reply the till could not read: the batch may or may not have gone.
    UNKNOWN = "unknown"


TRANSMISSION_STATUSES = (
    TransmissionStatus.SUCCESS,
    TransmissionStatus.FAILED,
    TransmissionStatus.UNKNOWN,
)


class CardTransmission(Base):
    """One `doPeriodic` attempt of one till, as the till reported it. Id is the till's."""

    __tablename__ = "card_transmissions"
    __table_args__ = (
        Index("ix_card_transmissions_machine_started", "machine_id", "started_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # till-generated, the idempotency key
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    trigger = Column(String(16), nullable=False)
    #: The dashboard request this attempt answered, if the till said so. No foreign key:
    #: the till may name one this cloud never created (or one of another environment).
    request_id = Column(UUID(as_uuid=True), nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=False)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(16), nullable=False)
    status_code = Column(Integer, nullable=True)
    status_message = Column(String(500), nullable=True)
    #: Agamento's `ackNumber` — the batch's reference with Shva.
    batch_number = Column(String(64), nullable=True)
    transaction_count = Column(Integer, nullable=True)
    amount = Column(Numeric(12, 2), nullable=True)
    #: How many ids the report carried (the ids themselves are the items).
    terminal_transaction_count = Column(Integer, nullable=False, server_default="0")
    report_text = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    items = relationship(
        "CardTransmissionItem",
        back_populates="transmission",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class CardTransmissionItem(Base):
    """One terminal uid a transmission carried (Agamento `queriedTransactions`)."""

    __tablename__ = "card_transmission_items"
    __table_args__ = (
        UniqueConstraint("transmission_id", "terminal_uid", name="uq_card_transmission_items_uid"),
        Index("ix_card_transmission_items_machine_uid", "machine_id", "terminal_uid"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    transmission_id = Column(
        UUID(as_uuid=True),
        ForeignKey("card_transmissions.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: Denormalised from the transmission: legs are matched per till, by uid.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    terminal_uid = Column(String(64), nullable=False)

    transmission = relationship("CardTransmission", back_populates="items")


class TransmitRequestStatus:
    #: Sent (or waiting for the heartbeat), not acknowledged.
    WAITING = "waiting"
    #: The till acknowledged it (or deferred it) and is transmitting.
    TRANSMITTING = "transmitting"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


PENDING_TRANSMIT_STATUSES = (TransmitRequestStatus.WAITING, TransmitRequestStatus.TRANSMITTING)


class TransmitRequest(Base):
    """
    An operator asked a till to transmit its card batch now (docs/SHIFTS_API.md §4.4).

    Travels like a remote shift close: the `transmit` Ably event now, `pendingTransmit` on
    the heartbeat until it ends. Not answered within 36 h, it expires.
    """

    __tablename__ = "transmit_requests"
    __table_args__ = (Index("ix_transmit_requests_machine_status", "machine_id", "status"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    status = Column(String(16), nullable=False, default=TransmitRequestStatus.WAITING)
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    #: The attempt that answered it. No foreign key: the till's ack may name a report that
    #: has not arrived yet.
    transmission_id = Column(UUID(as_uuid=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    failed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    machine = relationship("POSMachine")
