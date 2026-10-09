"""
"שליטה מרחוק" — remote actions on tills and kiosks from the dashboard (app/services/device_commands.py).

* `DeviceCommand` — one action for one device, its delivery and its acknowledgement: `pending`
  (waiting for the device) → `delivered` (the device took it) → `done` / `refused` / `failed`; or
  `cancelled` (from the dashboard before delivery) / `expired` (never picked up). One row per device
  of a batch (`batch_id`). The rows are the audit: who asked what, when, and what the device did.
* `DeviceRemoteState` — what a device must be now, whatever it missed: "נעל קופה" (locked, with its
  message). Set by the dashboard's lock / unlock, cleared by a manager code on the till too.
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

DEVICE_ACTIONS = (
    "lock",             # "נעל קופה": a full-screen lock with a message, after the sale in progress
    "unlock",           # "שחרר"
    "sync_now",         # "סנכרן עכשיו"
    "refresh_catalog",  # "רענן קטלוג"
    "sign_out",         # "נתק משתמש": after the sale in progress
    "restart_app",      # "הפעל מחדש את האפליקציה": only at rest
    "install_update",   # "התקן עדכון עכשיו": only when one is ready, only at rest
)
OPEN_STATUSES = ("pending", "delivered")
FINAL_STATUSES = ("done", "refused", "failed", "cancelled", "expired")


class DeviceCommand(Base):
    __tablename__ = "device_commands"
    __table_args__ = (
        Index("ix_device_commands_machine_status", "machine_id", "status"),
        Index("ix_device_commands_shop_created", "shop_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    #: One per dashboard request that named several devices.
    batch_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    action = Column(String(32), nullable=False)
    #: The lock's message ("הקופה נעולה — פנו למנהל").
    message = Column(String(300), nullable=True)
    status = Column(String(16), nullable=False, default="pending", server_default="pending")
    #: What the device said (a refusal's reason: "sale_in_progress", "no_update"…).
    detail = Column(String(300), nullable=True)
    #: "dashboard" | "till" (a manager code on the till).
    source = Column(String(16), nullable=False, default="dashboard", server_default="dashboard")
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    done_at = Column(DateTime(timezone=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    #: A lock / unlock: the device's lock as it was before it (locked, message, when, by whom), for
    #: a cancel to put back exactly (app/services/device_commands.py `cancel`).
    prev_state = Column(JSONB, nullable=True)


class DeviceRemoteState(Base):
    __tablename__ = "device_remote_states"

    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    locked = Column(Boolean, nullable=False, default=False, server_default="false")
    lock_message = Column(String(300), nullable=True)
    locked_at = Column(DateTime(timezone=True), nullable=True)
    locked_by = Column(String(200), nullable=True)
    unlocked_at = Column(DateTime(timezone=True), nullable=True)
    unlocked_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
