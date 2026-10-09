"""
"סוללה חלשה" — a device's low-battery alerts (docs/SPEC_KIOSK_INSIGHTS.md §6).

Every till, handheld, tablet and kiosk reports its battery on the heartbeat (`battery_percent`,
`battery_status` on `pos_machines`). When a discharging device crosses a threshold (15 / 10 / 5 %
by default — the till parameter `lowBatteryThresholds`), one row is written here: an alert routed
to the shop's tills like the kiosk alerts (`alerts.battery`), and the history the dashboard's
"תקינות מכשירים" lists. Each threshold fires once per discharge cycle (`cycle_id`); a lower one
closes the higher one ("escalated"); the alert clears when the device charges or climbs 5 points
above its threshold, and the cycle ends when it charges or climbs 5 above the highest threshold.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class DeviceBatteryAlert(Base):
    """One threshold a device's battery crossed in one discharge cycle."""

    __tablename__ = "device_battery_alerts"
    __table_args__ = (
        Index("ix_device_battery_alerts_machine_raised", "machine_id", "raised_at"),
        Index("ix_device_battery_alerts_tenant_open", "tenant_id", "cleared_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    #: The discharge cycle the row belongs to (one per unplugging, until it charges again).
    cycle_id = Column(UUID(as_uuid=True), nullable=False)
    #: The threshold crossed (percent): 15, 10, 5 by default; the lowest is critical.
    level = Column(Integer, nullable=False)
    #: The battery when it fired, and as last reported while it is open.
    percent = Column(Integer, nullable=False)
    last_percent = Column(Integer, nullable=True)
    #: "warning" | "critical" (the lowest threshold).
    severity = Column(String(16), nullable=False, default="warning")
    raised_at = Column(DateTime(timezone=True), nullable=False)
    cleared_at = Column(DateTime(timezone=True), nullable=True)
    #: charging | recovered | escalated
    clear_reason = Column(String(16), nullable=True)
    #: When the discharge cycle ended (charging, or back above the highest threshold + 5).
    cycle_ended_at = Column(DateTime(timezone=True), nullable=True)
    acknowledged_at = Column(DateTime(timezone=True), nullable=True)
    acknowledged_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
