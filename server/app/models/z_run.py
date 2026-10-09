"""A Z run: the orchestration of one cloud Z over one shop's tills."""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, Column, Date, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ZRunStatus:
    WAITING = "waiting"
    BUILDING = "building"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    #: Ended with no Z: the shifts it would take had no activity at all ("אין תנועות —
    #: לא ניתן לסגור Z על 0"). No Z written, no number drawn; the shifts stay closed.
    EMPTY = "empty"


class ZRunItemStatus:
    #: The till has an open shift the run asked it to close; not yet acknowledged.
    WAITING_CLOSE = "waiting_close"
    #: The till acknowledged the instruction (or deferred it) and is closing.
    CLOSING = "closing"
    #: The till's shifts to include are closed on the cloud with every document.
    READY = "ready"
    #: Left out of this Z (by the operator, or nothing to include).
    EXCLUDED = "excluded"
    FAILED = "failed"
    EXPIRED = "expired"


#: Items still holding a claim on their till: a second run for the same till is refused.
LIVE_ITEM_STATUSES = (ZRunItemStatus.WAITING_CLOSE, ZRunItemStatus.CLOSING, ZRunItemStatus.READY)
#: Items the till still has to act on.
PENDING_ITEM_STATUSES = (ZRunItemStatus.WAITING_CLOSE, ZRunItemStatus.CLOSING)


class ZRun(Base):
    """
    One Z for one shop: an item per till, each waiting for its till's shift to close and
    sync, then the Z is built in one transaction (`app.services.z_runs.build_z`).

    Replaced `close_day_requests`. Statuses are plain strings (see `ZRunStatus`).
    """

    __tablename__ = "z_runs"
    __table_args__ = (Index("ix_z_runs_shop_status", "shop_id", "status"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False)
    #: The area this Z was started for: its tills were the area's at the time. NULL for
    #: a whole-shop or hand-picked Z. A filter only — the Z is still the shop's.
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id"), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    status = Column(String(16), nullable=False, default=ZRunStatus.WAITING)
    #: The business date the operator asked for; NULL = derive it at build time.
    business_date = Column(Date, nullable=True)
    #: When an unfinished run stops being worth finishing (36 h, the old close TTL).
    expires_at = Column(DateTime(timezone=True), nullable=False)
    z_report_id = Column(
        UUID(as_uuid=True),
        # z_reports.z_run_id points back here; one side of the cycle is added after.
        ForeignKey("z_reports.id", use_alter=True, name="fk_z_runs_z_report_id_z_reports"),
        nullable=True,
    )
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    #: Started from the shop's master till ("סגירת Z סניפי"): the Z is built only when the
    #: cloud holds, for every till, its shift closed, the close accepted and every sale the
    #: till counted (`app.services.z_runs.verify_item`) — or the till was deferred by the
    #: operator's typed "סגור". False for the dashboard's runs.
    strict_cloud_check = Column(Boolean, nullable=False, default=False, server_default="false")
    #: "כפה סגירה (גם באמצע מכירה)": the tills park an open basket and close (only a card
    #: charge in flight is waited for). Handed to the till as `force` with the close.
    force_close = Column(Boolean, nullable=False, default=False, server_default="false")
    #: "סגירת יום סניפית" from remote control (app/services/remote_till_z.py): each till closes
    #: only once it is at rest — no sale, no payment, no card in flight (`waitForRest`).
    wait_for_rest = Column(Boolean, nullable=False, default=False, server_default="false")
    #: "אני מאשר שהנתונים בענן הם הנתונים הקיימים" (docs/SPEC_OFFLINE_TILL_Z.md §4.6.1): who
    #: confirmed, when, and the state of the tills the run took. Null when nothing warned.
    cloud_data_confirmation = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    items = relationship(
        "ZRunItem", back_populates="run", cascade="all, delete-orphan", order_by="ZRunItem.created_at"
    )
    shop = relationship("Shop")
    area = relationship("ShopArea")


class ZRunItem(Base):
    __tablename__ = "z_run_items"
    __table_args__ = (Index("ix_z_run_items_machine_status", "machine_id", "status"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id = Column(UUID(as_uuid=True), ForeignKey("z_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)
    #: The newest shift of this till to include; every older un-Z'd one comes with it.
    through_shift_id = Column(UUID(as_uuid=True), ForeignKey("shifts.id"), nullable=True)
    #: The open shift the run asked the till to close, once the cloud holds it.
    close_shift_id = Column(UUID(as_uuid=True), ForeignKey("shifts.id"), nullable=True)
    #: The shift the till *claimed* open (heartbeat, ack) while the cloud had not seen it.
    #: Deliberately no foreign key: that shift may not be in `shifts` yet (its open is
    #: still queued on the till), and a key would make the run a 500. `close_shift_id`
    #: is filled in when the shift lands (`app.services.shifts.link_claimed_shift`).
    claimed_shift_id = Column(UUID(as_uuid=True), nullable=True)
    include_open_shift = Column(Boolean, nullable=False, default=False, server_default="false")
    status = Column(String(16), nullable=False)
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    ready_at = Column(DateTime(timezone=True), nullable=True)
    failed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    run = relationship("ZRun", back_populates="items")
    machine = relationship("POSMachine")
