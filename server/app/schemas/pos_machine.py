from datetime import date, datetime
from pydantic import AliasChoices, BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
import uuid
from app.models.pos_machine import PairingStatus as ModelPairingStatus


class PairingStatus(str):
    UNPAIRED = "unpaired"
    PAIRED = "paired"
    ASSIGNED = "assigned"


class POSMachineBase(BaseModel):
    name: str
    machine_code: str = Field(..., alias="machineCode")

    model_config = ConfigDict(populate_by_name=True)


class POSMachineCreate(POSMachineBase):
    distributor_id: uuid.UUID
    device_info: Optional[Dict[str, Any]] = None


class POSMachineUpdate(BaseModel):
    name: Optional[str] = None
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    is_active: Optional[bool] = Field(None, alias="isActive")

    model_config = ConfigDict(populate_by_name=True)


class MachineHeartbeatBody(BaseModel):
    """
    HTTP heartbeat payload from a till (Android) or the POS desktop.

    Every field is optional on purpose. An older build in the field sends a strict
    subset, and a heartbeat is the one call that must never 422 — a terminal that
    cannot say "I am here" shows up on the dashboard as dead, which is a far worse
    lie than a missing battery reading.
    """

    # The Android till calls this `realtimeConnected`; the desktop has always sent
    # `mqttConnected`. Same fact, same column — accept both spellings rather than
    # asking either shipped client to change.
    mqtt_connected: Optional[bool] = Field(
        None,
        validation_alias=AliasChoices("mqttConnected", "realtimeConnected", "mqtt_connected"),
        serialization_alias="mqttConnected",
    )
    app_version: Optional[str] = Field(None, alias="appVersion", max_length=32)

    # Outbox depth. Accepted and logged rather than stored: it is a live number that
    # is stale the moment it lands, and the machine's real backlog is derivable from
    # what has actually been pushed.
    pending_count: Optional[int] = Field(None, alias="pendingCount", ge=0)

    # Undelivered sales only, as opposed to the whole outbox above. Optional like
    # everything here: a till predating this field simply does not send it.
    pending_documents: Optional[int] = Field(None, alias="pendingDocuments", ge=0)

    serial_number: Optional[str] = Field(None, alias="serialNumber", max_length=64)
    # No ge/le bound here deliberately: an out-of-range reading is clamped in the
    # service, not rejected. See MachineHeartbeatBody's docstring.
    battery_percent: Optional[int] = Field(None, alias="batteryPercent")
    battery_status: Optional[str] = Field(None, alias="batteryStatus", max_length=32)
    # Signed; negative means the device is behind the server.
    clock_skew_ms: Optional[int] = Field(None, alias="clockSkewMs")

    model_config = ConfigDict(populate_by_name=True)


class POSMachineResponse(POSMachineBase):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    distributor_id: uuid.UUID = Field(..., alias="distributorId")
    mqtt_client_id: Optional[str] = Field(None, alias="mqttClientId")
    pairing_status: ModelPairingStatus = Field(..., alias="pairingStatus")
    device_info: Optional[Dict[str, Any]] = Field(None, alias="deviceInfo")
    is_active: bool = Field(..., alias="isActive")
    last_heartbeat_at: Optional[datetime] = Field(None, alias="lastHeartbeatAt")
    mqtt_connected: Optional[bool] = Field(None, alias="mqttConnected")
    app_version: Optional[str] = Field(None, alias="appVersion")
    last_sync_at: Optional[datetime] = Field(None, alias="lastSyncAt")
    serial_number: Optional[str] = Field(None, alias="serialNumber")
    # Null means "the device could not read it", never "flat". The dashboard must
    # render it as unknown rather than as 0%.
    battery_percent: Optional[int] = Field(None, alias="batteryPercent")
    battery_status: Optional[str] = Field(None, alias="batteryStatus")
    clock_skew_ms: Optional[int] = Field(None, alias="clockSkewMs")
    last_health_report_at: Optional[datetime] = Field(None, alias="lastHealthReportAt")
    last_catalog_change_at: Optional[datetime] = Field(None, alias="lastCatalogChangeAt")
    catalog_pull_stale: Optional[bool] = Field(None, alias="catalogPullStale")
    trading_day_status: Optional[str] = Field(None, alias="tradingDayStatus")
    trading_day_id: Optional[uuid.UUID] = Field(None, alias="tradingDayId")
    day_date: Optional[date] = Field(None, alias="dayDate")
    opened_at: Optional[datetime] = Field(None, alias="openedAt")
    opened_by: Optional[str] = Field(None, alias="openedBy")
    close_day_pending: Optional[bool] = Field(None, alias="closeDayPending")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

