"""The dashboard asking a till in `zMode = till` to produce its own Z (docs/SHIFTS_API.md §5.4)."""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class TillZRequestStatus:
    #: Created; the till has not acknowledged it.
    WAITING = "waiting"
    #: The till has it (a `received` or `deferred` ack) and is closing / building.
    IN_PROGRESS = "in_progress"
    #: Answered by a till Z (`z_report_id`), or by "nothing to report" (no Z).
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


#: Requests the till still has to act on (handed over on the heartbeat).
PENDING_TILL_Z_STATUSES = (TillZRequestStatus.WAITING, TillZRequestStatus.IN_PROGRESS)


class TillZRequest(Base):
    """
    "Produce your Z" for one till, sent from the dashboard.

    It reaches the till as the `till-z` Ably event and as `pendingTillZ` on every
    heartbeat while pending; the till closes its open shift unattended, asks for its Z
    with this row's id as `tillZRequestId`, and prints it. The request completes only
    from that call (`app.services.till_z`), never from an ack. A till holds at most one
    pending request; one nobody answers expires after 36 h, like a Z run.
    """

    __tablename__ = "till_z_requests"
    __table_args__ = (Index("ix_till_z_requests_machine_status", "machine_id", "status"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    #: The name the till is shown ("הופק מרחוק ע״י …"), frozen when the request was made.
    initiated_by = Column(String(255), nullable=True)
    status = Column(String(16), nullable=False, default=TillZRequestStatus.WAITING)
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    #: "כפה סגירה (גם באמצע מכירה)": the till parks an open basket and produces the Z
    #: (only a card charge in flight is waited for). Handed to the till as `force`.
    force_close = Column(Boolean, nullable=False, default=False, server_default="false")
    #: The Z that answered it; NULL until then, and on one completed with nothing to report.
    z_report_id = Column(UUID(as_uuid=True), ForeignKey("z_reports.id"), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    failed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    machine = relationship("POSMachine")
    z_report = relationship("ZReport", foreign_keys=[z_report_id])
