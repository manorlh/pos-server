from datetime import date, datetime
from pydantic import AliasChoices, BaseModel, Field, ConfigDict, PrivateAttr, field_validator, model_validator
from typing import Optional, Dict, Any, List, Literal
import uuid
from app.models.pos_machine import PairingStatus as ModelPairingStatus
from app.schemas.printer import HeartbeatPrinter
from app.schemas.terminal import HeartbeatTerminal
from app.schemas.transmission import HeartbeatTransmission


#: The hardware a till is (`app.models.pos_machine.DEVICE_MODELS`).
DeviceModel = Literal["N55F", "MODO"]


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
    #: "N55F" (built-in printer) or "MODO" (none). An explicit null records "unknown",
    #: which the till reads as a 55F; omitted leaves it as it is.
    device_model: Optional[DeviceModel] = Field(None, alias="deviceModel")
    #: "לקוח קבוע / זמני" for this till alone — the super admin's (app/services/licenses.py).
    license_type: Optional[Literal["permanent", "temporary"]] = Field(None, alias="licenseType")
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")

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
    #: The till's printer as it last observed it (docs/SHIFTS_API.md §1.6a). Dropped
    #: whole when not an object, like `transmission`; an unknown status is "unknown".
    printer: Optional[HeartbeatPrinter] = None
    #: The till's card terminal (Agamento): its number, clearing server, offline mode and
    #: the till's last write into it. Absent or null leaves the stored reading as it was.
    terminal: Optional[HeartbeatTerminal] = None

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
    #: Its shop's number in its company, and that company's in the tenant; null without a shop.
    shop_number: Optional[int] = Field(None, alias="shopNumber")
    company_number: Optional[int] = Field(None, alias="companyNumber")
    distributor_id: uuid.UUID = Field(..., alias="distributorId")
    mqtt_client_id: Optional[str] = Field(None, alias="mqttClientId")
    pairing_status: ModelPairingStatus = Field(..., alias="pairingStatus")
    device_info: Optional[Dict[str, Any]] = Field(None, alias="deviceInfo")
    #: "N55F" | "MODO", null = unknown. `hasPrinter` is false for a Modo only.
    device_model: Optional[str] = Field(None, alias="deviceModel")
    has_printer: bool = Field(True, alias="hasPrinter")
    license_type: str = Field("permanent", alias="licenseType")
    license_expires_on: Optional[date] = Field(None, alias="licenseExpiresOn")
    is_active: bool = Field(..., alias="isActive")

    @field_validator("license_type", mode="before")
    @classmethod
    def _unset_license_is_permanent(cls, v):
        # A row not yet flushed has no column default applied.
        return v or "permanent"
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
    # ── The printer (docs/SHIFTS_API.md §1.6a) — all null for a till that never reported
    printer_status: Optional[str] = Field(None, alias="printerStatus")
    printer_error_code: Optional[int] = Field(None, alias="printerErrorCode")
    printer_message: Optional[str] = Field(None, alias="printerMessage")
    #: When the till observed it (the till's clock).
    printer_status_at: Optional[datetime] = Field(None, alias="printerStatusAt")
    printer_last_ok_at: Optional[datetime] = Field(None, alias="printerLastOkAt")
    #: When the cloud received it; null = the till never sent a printer block.
    printer_reported_at: Optional[datetime] = Field(None, alias="printerReportedAt")
    # ── The card terminal (app/services/terminal_status.py) ─────────────────────
    #: What the till's Agamento reports; all null for a till that never reported.
    terminal_number: Optional[str] = Field(None, alias="terminalNumber")
    terminal_clearing_server: Optional[str] = Field(None, alias="terminalClearingServer")
    terminal_offline_mode: Optional[bool] = Field(None, alias="terminalOfflineMode")
    terminal_reported_at: Optional[datetime] = Field(None, alias="terminalReportedAt")
    #: {field, value, ok, error, at} of the till's last write into Agamento.
    terminal_last_write: Optional[Dict[str, Any]] = Field(None, alias="terminalLastWrite")
    #: The business name and supplier number the terminal is set up under, as it names them.
    terminal_merchant_name: Optional[str] = Field(None, alias="terminalMerchantName")
    terminal_supplier_number: Optional[str] = Field(None, alias="terminalSupplierNumber")
    #: The till's effective settings: the number it must be on, whether it forces it, and
    #: the level `forceTerminalNumber` comes from ("tenant" … "machine"; null = default).
    expected_terminal_number: Optional[str] = Field(None, alias="expectedTerminalNumber")
    force_terminal_number: Optional[bool] = Field(None, alias="forceTerminalNumber")
    force_terminal_number_source: Optional[str] = Field(None, alias="forceTerminalNumberSource")
    #: "match" | "mismatch" | "unknown" (no report yet) | "not_required" (no expected number).
    terminal_status: Optional[str] = Field(None, alias="terminalStatus")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

