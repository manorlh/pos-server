from datetime import date, datetime
from pydantic import AliasChoices, BaseModel, Field, ConfigDict, PrivateAttr, field_validator, model_validator
from typing import Optional, Dict, Any, List
import uuid
from app.models.pos_machine import PairingStatus as ModelPairingStatus
from app.schemas.transmission import HeartbeatTransmission


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
    #: An area of the machine's shop (its new one, when `shopId` is sent too). An
    #: explicit null clears it; omitted leaves it as it is.
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")

    model_config = ConfigDict(populate_by_name=True)


#: The columns the backlog counts land in are INTEGER; the skew is BIGINT. A reading
#: beyond them is not a reading (and would fail the write): it is dropped, as unknown.
INT32_MAX = 2**31 - 1
INT64_MAX = 2**63 - 1

#: What each heartbeat string is cut to — the width of the column it lands in.
HEARTBEAT_STRING_LIMITS = {"app_version": 64, "serial_number": 64, "battery_status": 32}


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
    app_version: Optional[str] = Field(None, alias="appVersion")

    # Outbox depth. Accepted and logged rather than stored: it is a live number that
    # is stale the moment it lands, and the machine's real backlog is derivable from
    # what has actually been pushed.
    pending_count: Optional[int] = Field(None, alias="pendingCount")

    # Undelivered sales only, as opposed to the whole outbox above. Optional like
    # everything here: a till predating this field simply does not send it.
    pending_documents: Optional[int] = Field(None, alias="pendingDocuments")

    serial_number: Optional[str] = Field(None, alias="serialNumber")
    # No ge/le bound here deliberately: an out-of-range reading is clamped in the
    # service, not rejected. See MachineHeartbeatBody's docstring.
    battery_percent: Optional[int] = Field(None, alias="batteryPercent")
    battery_status: Optional[str] = Field(None, alias="batteryStatus")
    # Signed; negative means the device is behind the server.
    clock_skew_ms: Optional[int] = Field(None, alias="clockSkewMs")

    # The shift the till has open right now, by its own account; absent or null = none
    # open (the till drops null fields). Sent on every beat so the cloud knows about a
    # shift whose open event is still queued offline.
    open_shift_id: Optional[uuid.UUID] = Field(None, alias="openShiftId")
    #: The open shift's per-till number ("משמרת #N"); null if none open or unnumbered.
    open_shift_sequence: Optional[int] = Field(None, alias="openShiftSequence")
    open_shift_opened_at: Optional[datetime] = Field(None, alias="openShiftOpenedAt")

    #: The till's card transmission state (docs/SHIFTS_API.md §4.2). A block that is not
    #: an object is dropped whole; a field inside it that cannot be read is None.
    transmission: Optional[HeartbeatTransmission] = None

    model_config = ConfigDict(populate_by_name=True)

    @field_validator("app_version", "serial_number", "battery_status", mode="before")
    @classmethod
    def _truncate(cls, value, info):
        """An over-long string is cut to what the column holds, never a 422."""
        if value is None:
            return None
        text = value if isinstance(value, str) else str(value)
        return text[: HEARTBEAT_STRING_LIMITS[info.field_name]]

    @field_validator("*", mode="wrap")
    @classmethod
    def _unreadable_is_unknown(cls, value, handler, info):
        """
        A field that cannot be read is dropped (None), never a 422 for the whole beat.

        The heartbeat is the one call that must never fail validation: a terminal that
        cannot say "I am here" shows as dead. A negative backlog reads as unknown too.
        """
        try:
            parsed = handler(value)
        except (ValueError, TypeError):
            return None
        if info.field_name in ("pending_count", "pending_documents") and parsed is not None:
            if parsed < 0 or parsed > INT32_MAX:
                return None
        if info.field_name == "clock_skew_ms" and parsed is not None and abs(parsed) > INT64_MAX:
            return None
        if info.field_name == "battery_percent" and parsed is not None and abs(parsed) > INT32_MAX:
            return None
        return parsed

    #: The till sent an `openShiftId` that could not be read (not a UUID). Distinct from
    #: absent/null ("none open"): an unreadable claim leaves the stored one as it was.
    _open_shift_id_unreadable: bool = PrivateAttr(default=False)

    @model_validator(mode="wrap")
    @classmethod
    def _remember_unreadable_claim(cls, value, handler):
        model = handler(value)
        if isinstance(value, dict):
            raw = next((value[k] for k in ("openShiftId", "open_shift_id") if k in value), None)
            if raw is not None and model.open_shift_id is None:
                model._open_shift_id_unreadable = True
        return model

    @property
    def open_shift_id_unreadable(self) -> bool:
        return self._open_shift_id_unreadable


class POSMachineResponse(POSMachineBase):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    #: The area of its shop it stands in now; both null when unassigned.
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    area_name: Optional[str] = Field(None, alias="areaName")
    #: The register number in its shop — "קופה 2". Null when the machine has no shop.
    #: Text, because documents copy it verbatim; it is always a plain integer when set.
    pos_number: Optional[str] = Field(None, alias="posNumber")
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
    #: "open" or "none" — whether the cloud holds an open shift for this till.
    shift_status: Optional[str] = Field(None, alias="shiftStatus")
    open_shift_id: Optional[uuid.UUID] = Field(None, alias="openShiftId")
    #: The open shift's per-till number ("משמרת #N"); null if none open or unnumbered.
    open_shift_sequence: Optional[int] = Field(None, alias="openShiftSequence")
    business_date: Optional[date] = Field(None, alias="businessDate")
    opened_at: Optional[datetime] = Field(None, alias="openedAt")
    opened_by: Optional[str] = Field(None, alias="openedBy")
    close_shift_pending: Optional[bool] = Field(None, alias="closeShiftPending")
    #: "z_run" or "request" while a remote close waits for this till; null otherwise.
    pending_close_source: Optional[str] = Field(None, alias="pendingCloseSource")
    #: The Z run waiting for this till's close, when the source is a Z run.
    pending_z_run_id: Optional[uuid.UUID] = Field(None, alias="pendingZRunId")
    #: Closed shifts of this till that no Z has taken yet.
    closed_shifts_awaiting_z: Optional[int] = Field(None, alias="closedShiftsAwaitingZ")
    #: The till's own claim from its heartbeat (may be ahead of the cloud); null unless a
    #: close could still answer it (not a shift the cloud holds closed, not another till's).
    reported_open_shift_id: Optional[uuid.UUID] = Field(None, alias="reportedOpenShiftId")
    #: Documents of this till stored with no shift (they named none); no Z takes them.
    orphan_documents: Optional[int] = Field(None, alias="orphanDocuments")
    # The resolved status light (app/services/machine_status.py). These were computed
    # by the router but missing from this model, so FastAPI dropped them on the way out.
    status: Optional[str] = None
    online: Optional[bool] = None
    status_flags: List[str] = Field(default_factory=list, alias="statusFlags")
    pending_documents: Optional[int] = Field(None, alias="pendingDocuments")
    pending_as_of: Optional[datetime] = Field(None, alias="pendingAsOf")
    # ── Card transmission (docs/SHIFTS_API.md §4.6) ──────────────────────────
    pending_transmission_count: Optional[int] = Field(None, alias="pendingTransmissionCount")
    #: Decimal string, like every money value the dashboard reads.
    pending_transmission_amount: Optional[str] = Field(None, alias="pendingTransmissionAmount")
    oldest_pending_transmission_at: Optional[datetime] = Field(None, alias="oldestPendingTransmissionAt")
    last_transmission_at: Optional[datetime] = Field(None, alias="lastTransmissionAt")
    last_transmission_error: Optional[str] = Field(None, alias="lastTransmissionError")
    transmission_reported_at: Optional[datetime] = Field(None, alias="transmissionReportedAt")
    transmission_source: Optional[str] = Field(None, alias="transmissionSource")
    #: Card sales the till assumes a successful batch carried; not verified, not a flag.
    assumed_transmission_count: Optional[int] = Field(None, alias="assumedTransmissionCount")
    untransmitted_card_legs: Optional[int] = Field(None, alias="untransmittedCardLegs")
    untransmitted_card_amount: Optional[str] = Field(None, alias="untransmittedCardAmount")
    transmission_tracking_started_at: Optional[datetime] = Field(None, alias="transmissionTrackingStartedAt")
    transmit_pending: Optional[bool] = Field(None, alias="transmitPending")
    pending_transmit_request_id: Optional[uuid.UUID] = Field(None, alias="pendingTransmitRequestId")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

