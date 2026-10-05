"""
Offline (deferred) card authorization — Nayax/Agamento `authorizePendingTransactions`.

With the acquirer out of reach the terminal approves a card sale on its own and holds it
for authorization later. When the till sends the held sales, the acquirer may decline
some of them: money the shop took a document for and will not be paid. Every such run
is reported here as one `OfflineAuthorization`; the terminal uids it answered are kept
as `OfflineAuthorizationItem` rows with their outcome, so the Z can name the declined
card legs (`app.services.offline_authorizations`).
"""
from __future__ import annotations

import uuid

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class OfflineOutcome:
    APPROVED = "approved"
    DECLINED = "declined"


OFFLINE_OUTCOMES = (OfflineOutcome.APPROVED, OfflineOutcome.DECLINED)


class OfflineAuthorization(Base):
    """One `authorizePendingTransactions` run of one till, as reported. Id is the till's."""

    __tablename__ = "offline_authorizations"
    __table_args__ = (
        Index("ix_offline_authorizations_machine_authorized", "machine_id", "authorized_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # till-generated, the idempotency key
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    authorized_at = Column(DateTime(timezone=True), nullable=False)
    status_code = Column(Integer, nullable=True)
    #: The approved total as the terminal reported it, in agorot (as sent).
    total_amount_agorot = Column(BigInteger, nullable=True)
    total_count = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    items = relationship(
        "OfflineAuthorizationItem",
        back_populates="authorization",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class OfflineAuthorizationItem(Base):
    """One terminal uid a run answered, approved or declined."""

    __tablename__ = "offline_authorization_items"
    __table_args__ = (
        UniqueConstraint("authorization_id", "terminal_uid", name="uq_offline_authorization_items_uid"),
        Index("ix_offline_authorization_items_machine_uid", "machine_id", "terminal_uid"),
        CheckConstraint(
            "outcome IN ('approved', 'declined')", name="ck_offline_authorization_items_outcome"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    authorization_id = Column(
        UUID(as_uuid=True),
        ForeignKey("offline_authorizations.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: Denormalised from the run: legs are matched per till, by uid.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    terminal_uid = Column(String(64), nullable=False)
    outcome = Column(String(16), nullable=False)

    authorization = relationship("OfflineAuthorization", back_populates="items")
