"""Cloud-initiated close-day request tracking."""
from __future__ import annotations

import enum
import uuid

from sqlalchemy import Column, DateTime, Enum as SQLEnum, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class CloseDayRequestStatus(str, enum.Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"


class CloseDayItemStatus(str, enum.Enum):
    PENDING = "pending"
    SENT = "sent"
    RECEIVED = "received"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class CloseDayRequest(Base):
    __tablename__ = "close_day_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    initiated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    status = Column(
        SQLEnum(CloseDayRequestStatus, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=CloseDayRequestStatus.PENDING,
    )
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    items = relationship("CloseDayRequestItem", back_populates="request", cascade="all, delete-orphan")


class CloseDayRequestItem(Base):
    __tablename__ = "close_day_request_items"
    __table_args__ = (
        Index("ix_close_day_items_machine_status", "machine_id", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id = Column(UUID(as_uuid=True), ForeignKey("close_day_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    trading_day_id = Column(UUID(as_uuid=True), ForeignKey("trading_days.id"), nullable=True)
    z_report_id = Column(UUID(as_uuid=True), ForeignKey("z_reports.id"), nullable=True)
    status = Column(
        SQLEnum(CloseDayItemStatus, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=CloseDayItemStatus.PENDING,
    )
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    failed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    request = relationship("CloseDayRequest", back_populates="items")
    machine = relationship("POSMachine")
    trading_day = relationship("TradingDay")
    z_report = relationship("ZReport")
