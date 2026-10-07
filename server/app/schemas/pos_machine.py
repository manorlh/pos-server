from datetime import date, datetime
from pydantic import AliasChoices, BaseModel, Field, ConfigDict, PrivateAttr, field_validator, model_validator
from typing import Optional, Dict, Any, List, Literal
import uuid
from app.models.pos_machine import PairingStatus as ModelPairingStatus
from app.schemas.printer import HeartbeatPrinter
from app.schemas.terminal import HeartbeatTerminal
from app.schemas.transmission import HeartbeatTransmission


#: The hardware a till is (`app.models.pos_machine.DEVICE_MODELS`).
DeviceModel = Literal[
    "N55F", "MODO", "P18", "LANDI", "FEITIAN_TABLET", "GENERIC_ANDROID",
    # SUNMI (`app.models.sunmi.SUNMI_MODEL_IDS`, docs/SPEC_SUNMI.md).
    "SUNMI_V1", "SUNMI_V2", "SUNMI_V2_PRO", "SUNMI_V2S", "SUNMI_V2S_PLUS", "SUNMI_V3",
    "SUNMI_P1", "SUNMI_P2", "SUNMI_P3", "SUNMI_L2", "SUNMI_M2",
    "SUNMI_T1", "SUNMI_T2", "SUNMI_T2_MINI", "SUNMI_T2S", "SUNMI_T3",
    "SUNMI_D2_MINI", "SUNMI_D2S", "SUNMI_D2S_PLUS", "SUNMI_D3", "SUNMI_D3_MINI",
    "SUNMI_K2", "SUNMI",
    # SynqPay terminals (`app.models.synqpay_devices.SYNQPAY_DEVICE_MODEL_IDS`, docs/SPEC_SYNQPAY.md).
    "SYNQPAY_DX8000", "SYNQPAY_DX6000", "SYNQPAY_EX8000", "SYNQPAY_RX5000",
    "SYNQPAY_S1P2", "SYNQPAY_S1U2_M4", "SYNQPAY_VERIFONE", "SYNQPAY",
    # PAX A77 / Urovo i9100 (`app.models.vendor_devices.VENDOR_DEVICE_MODEL_IDS`): Agamento / TC.
    "PAX_A77", "UROVO_I9100",
]

#: "סוג מכשיר (תפקיד)" (docs/SPEC_DEVICE_ROLE_MODEL.md): a till, a self-order kiosk, a KDS
#: kitchen screen or the "מוכן / לא מוכן" board. The last two are display devices: not tills
#: and not accounting systems (app/services/display_devices.py).
DeviceRole = Literal["till", "kiosk", "kds", "order_status_board"]

#: What the device runs (app/services/display_devices.py `PLATFORMS`). "web": the browser kiosk
#: the dashboard app serves at `/k` (a kiosk only — docs/SPEC_KIOSK.md §27).
DevicePlatform = Literal["android", "windows", "web"]


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
    #: Who produces this till's Z (docs/SHIFTS_API.md §5.1). A switch is refused while
    #: the till has shifts waiting for a Z of the old mode (409); the same value is a no-op.
    z_mode: Optional[Literal["cloud", "till"]] = Field(None, alias="zMode")
    #: "קידומת מסמכים" (docs/SPEC_DOCUMENT_PREFIX.md): digits, 1–3. An explicit null or ""
    #: goes back to the default (the register number); omitted leaves it as it is. The
    #: format and the uniqueness in the shop are checked by the route (400 / 409, Hebrew).
    document_prefix: Optional[str] = Field(None, alias="documentPrefix", max_length=10)

    model_config = ConfigDict(populate_by_name=True)


#: The columns the backlog counts land in are INTEGER; the skew is BIGINT. A reading
#: beyond them is not a reading (and would fail the write): it is dropped, as unknown.
INT32_MAX = 2**31 - 1
INT64_MAX = 2**63 - 1

#: What each heartbeat string is cut to — the width of the column it lands in.
HEARTBEAT_STRING_LIMITS = {"app_version": 64, "serial_number": 64, "battery_status": 32}


class HeartbeatOfflineTillZ(BaseModel):
    """
    The till's Zs closed with no connection that the cloud has not taken yet
    (docs/SPEC_OFFLINE_TILL_Z.md §4.4): their count, whether one is held in a conflict,
    and the last number of the till's run as it knows it.
    """

    model_config = ConfigDict(populate_by_name=True)

    pending: Optional[int] = Field(None, ge=0, le=100_000)
    conflict: Optional[bool] = None
    last_number: Optional[int] = Field(None, alias="lastNumber", ge=0)
    #: The till's run `last_number` is in (docs/SPEC_INDEPENDENT_TILL.md §3.1): a report of
    #: another run (sent before the till heard of a new one) says nothing of this run's.
    epoch: Optional[int] = Field(None, ge=0)


class HeartbeatLocalShopZ(BaseModel):
    """
    The shop Zs a main till made in local mode that the cloud has not taken yet
    (docs/SPEC_INDEPENDENT_TILL.md §8.10): their count, whether one is held in a conflict,
    and the last number it made. What a handover of the shop's Z production waits for.
    """

    model_config = ConfigDict(populate_by_name=True)

    pending: Optional[int] = Field(None, ge=0, le=100_000)
    conflict: Optional[bool] = None
    last_number: Optional[int] = Field(None, alias="lastNumber", ge=0)
    #: The tills the main till heard on the LAN lately (machine ids) — a hint for the card's
    #: "מחובר ברשת המקומית / מרוחק (דרך הענן)" (docs/SPEC_INDEPENDENT_TILL.md §8.14).
    lan_seen: Optional[List[str]] = Field(None, alias="lanSeen", max_length=200)


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
    #: Where `serialNumber` came from: ftpos | sunmi | build | ro.serialno
    #: (app/services/device_identity.py). Anything else is dropped there.
    serial_source: Optional[str] = Field(None, alias="serialSource")
    #: The SIMs, the data path and the LAN address (pos-android CellularDtos.kt), cleaned field
    #: by field in `device_identity.clean_cellular` — never a 422.
    cellular: Optional[Dict[str, Any]] = None
    #: Device owner and silent updates (pos-android system/DeviceManagement.kt), cleaned key by
    #: key in `device_management.clean_block` — never a 422.
    device_management: Optional[Dict[str, Any]] = Field(None, alias="deviceManagement")
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
    #: "עקיפת בדיקת מספר מסוף" as the till applies it now (app/services/terminal_check_bypass.py).
    #: Absent (an older build) leaves the stored reading as it was.
    terminal_number_check_bypass: Optional[bool] = Field(None, alias="terminalNumberCheckBypass")
    #: Zs closed at the till with no connection, not uploaded yet (§4.4 of the offline
    #: till Z spec). Absent leaves the stored reading as it was.
    offline_till_z: Optional[HeartbeatOfflineTillZ] = Field(None, alias="offlineTillZ")
    #: The till's per-series document counters (`documentSequence.320/.330/.400`), so a
    #: replacement device starts after them (offline till Z §4.6). Absent: as it was.
    document_counters: Optional[Dict[str, int]] = Field(None, alias="documentCounters")
    #: Shop Zs made on this main till in local mode, not in the cloud yet
    #: (docs/SPEC_INDEPENDENT_TILL.md §8.10). Absent leaves the stored reading as it was.
    local_shop_z: Optional[HeartbeatLocalShopZ] = Field(None, alias="localShopZ")

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
    #: "קידומת מסמכים": the till's own (null = the default), and the one it issues under
    #: now — its own, else the register number (docs/SPEC_DOCUMENT_PREFIX.md).
    document_prefix: Optional[str] = Field(None, alias="documentPrefix")
    effective_document_prefix: Optional[str] = Field(None, alias="effectiveDocumentPrefix")
    #: Its shop's number in its company, and that company's in the tenant; null without a shop.
    shop_number: Optional[int] = Field(None, alias="shopNumber")
    company_number: Optional[int] = Field(None, alias="companyNumber")
    #: "cloud" (the shop's Z run builds its Z) or "till" (it produces its own, §5).
    z_mode: str = Field("cloud", alias="zMode")
    #: Zs closed at the till with no connection not uploaded yet, as it last said; whether
    #: one is held in a conflict for support (docs/SPEC_OFFLINE_TILL_Z.md §4.4).
    offline_till_z_pending: Optional[int] = Field(None, alias="offlineTillZPending")
    offline_till_z_conflict: Optional[bool] = Field(False, alias="offlineTillZConflict")
    #: Support produced this till's Z from the cloud (offline till Z spec §4.6), or null.
    support_z: Optional[Dict[str, Any]] = Field(None, alias="supportZ")
    #: The last reset of the till's data support ordered from the cloud (§4.7), or null.
    till_reset: Optional[Dict[str, Any]] = Field(None, alias="tillReset")
    #: "הוחלפה קופה": every replacement of the till's device, oldest first (§4.6.2).
    replacements: Optional[List[Dict[str, Any]]] = None
    #: "קופה עצמאית" (docs/SPEC_INDEPENDENT_TILL.md): its own Z, outside the shop's LAN group.
    independent_till: bool = Field(False, alias="independentTill")

    @field_validator("independent_till", mode="before")
    @classmethod
    def _independent_default(cls, value):
        return bool(value)

    @field_validator("z_mode", mode="before")
    @classmethod
    def _z_mode_default(cls, value):
        # A row not flushed yet (or a caller's stand-in) has no value: it is the default.
        return value or "cloud"

    distributor_id: uuid.UUID = Field(..., alias="distributorId")
    mqtt_client_id: Optional[str] = Field(None, alias="mqttClientId")
    pairing_status: ModelPairingStatus = Field(..., alias="pairingStatus")
    device_info: Optional[Dict[str, Any]] = Field(None, alias="deviceInfo")
    #: One of `DeviceModel`, null = unknown (read as a 55F).
    device_model: Optional[str] = Field(None, alias="deviceModel")
    has_printer: bool = Field(True, alias="hasPrinter")
    #: False for a till with no card terminal of its own (a P18): it charges on a Nayax
    #: pinpad on the network (app/services/payment_terminal.py).
    has_builtin_terminal: bool = Field(True, alias="hasBuiltinTerminal")
    # ── Role and model (docs/SPEC_DEVICE_ROLE_MODEL.md) ──────────────────────────
    #: "till" | "kiosk" (a `kiosk_devices` row). Null where it was not computed (a plain
    #: PUT answer); the machines list and the machine page always carry it.
    device_role: Optional[str] = Field(None, alias="deviceRole")
    #: For a kiosk: whether it is on (`enabled`). A disabled kiosk works as a till.
    kiosk_enabled: Optional[bool] = Field(None, alias="kioskEnabled")
    #: False for a display device (a KDS / the "מוכן / לא מוכן" board): not a till, not an
    #: accounting system (docs/SPEC_DEVICE_ROLE_MODEL.md §2.2). From the row on a plain PUT.
    is_fiscal: bool = Field(True, alias="fiscal")
    #: "android" | "windows" (null on a plain PUT answer of a machine paired before the column).
    platform: Optional[str] = None
    #: Its KDS screen (`role`, `name`, `isActive`, `shopId`), or null. On a fiscal till: a
    #: screen paired on the KDS page before display devices existed — flagged.
    kds_screen: Optional[Dict[str, Any]] = Field(None, alias="kdsScreen")

    @field_validator("is_fiscal", mode="before")
    @classmethod
    def _unset_is_fiscal(cls, value):
        # A row not flushed yet has no column default applied: a till.
        return value is not False
    #: The model the dashboard chose, and the one the device named itself at pairing (if
    #: recognised). When they differ from `deviceModel` the machine page warns.
    device_model_chosen: Optional[str] = Field(None, alias="deviceModelChosen")
    device_model_reported: Optional[str] = Field(None, alias="deviceModelReported")
    #: A cash drawer port the till drives itself (none today: drawers open through a
    #: receipt printer).
    has_cash_drawer_port: bool = Field(False, alias="hasCashDrawerPort")
    #: A LANDI / Feitian tablet: built-in printer / drawer support "בקרוב".
    device_driver_pending: bool = Field(False, alias="deviceDriverPending")
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
    #: Device identity (app/services/device_identity.py): the serial's source, the SIMs as the
    #: last heartbeat said, the address it came from and the device's own LAN address.
    serial_source: Optional[str] = Field(None, alias="serialSource")
    cellular: Optional[Dict[str, Any]] = None
    cellular_reported_at: Optional[datetime] = Field(None, alias="cellularReportedAt")
    last_ip: Optional[str] = Field(None, alias="lastIp")
    lan_ip: Optional[str] = Field(None, alias="lanIp")
    #: "עדכון שקט" (app/services/device_management.py): the heartbeat's `deviceManagement` block
    #: as last sent (device owner, update path, kiosk lock, a technician's release), when, and
    #: the dashboard's "הפעל מחדש" request as it stands.
    device_management: Optional[Dict[str, Any]] = Field(None, alias="deviceManagement")
    device_management_reported_at: Optional[datetime] = Field(None, alias="deviceManagementReportedAt")
    reboot_request: Optional[Dict[str, Any]] = Field(None, alias="rebootRequest")
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
    #: Where `expectedTerminalNumber` comes from ("machine", "shop"…; null = none sets it).
    expected_terminal_number_source: Optional[str] = Field(None, alias="expectedTerminalNumberSource")
    #: The till's card lock on its last report (docs/SPEC_KIOSK.md §20): "mismatch" |
    #: "not_configured" | "unknown"; null = card payment not locked.
    card_lock: Optional[str] = Field(None, alias="cardLock")
    #: "עקיפת בדיקת מספר מסוף" (docs/SPEC_KIOSK.md §20.1, app/services/terminal_check_bypass.py):
    #: on for this till (then `cardLock` is null), the level it comes from, who set it and when
    #: ({userEmail, userRole, at, scopeType…}), what the till itself reported it applies (null:
    #: never said), and the lock the check would have put on now.
    terminal_number_check_bypass: Optional[bool] = Field(None, alias="terminalNumberCheckBypass")
    terminal_number_check_bypass_source: Optional[str] = Field(None, alias="terminalNumberCheckBypassSource")
    terminal_number_check_bypass_change: Optional[Dict[str, Any]] = Field(None, alias="terminalNumberCheckBypassChange")
    terminal_number_check_bypass_reported: Optional[bool] = Field(None, alias="terminalNumberCheckBypassReported")
    card_lock_bypassed: Optional[str] = Field(None, alias="cardLockBypassed")
    # ── The network pinpad (app/services/payment_terminal.py) ───────────────────
    #: The merged `nayaxEnabled`, and the merged address (`nayaxDeviceHost`, `nayaxDevicePort`).
    pinpad_enabled: Optional[bool] = Field(None, alias="pinpadEnabled")
    pinpad_host: Optional[str] = Field(None, alias="pinpadHost")
    pinpad_port: Optional[str] = Field(None, alias="pinpadPort")
    #: The till charges on a network pinpad: it has no terminal of its own, or is told to.
    pinpad_required: Optional[bool] = Field(None, alias="pinpadRequired")
    #: It does, and no level gives it an address: the machines page asks for one.
    pinpad_address_missing: Optional[bool] = Field(None, alias="pinpadAddressMissing")
    # ── "סוג אינטגרציית אשראי" (app/services/payment_integration.py) ────────────
    #: agamento | nayax_lan | zcredit: what the till charges on.
    payment_integration: Optional[str] = Field(None, alias="paymentIntegration")
    #: The level that chose it ("tenant" … "machine"); null = automatic.
    payment_integration_source: Optional[str] = Field(None, alias="paymentIntegrationSource")
    payment_integration_automatic: Optional[bool] = Field(None, alias="paymentIntegrationAutomatic")
    #: The fields it still needs ("zcreditTerminalNumber", "nayaxDeviceHost", …).
    payment_integration_missing: List[str] = Field(default_factory=list, alias="paymentIntegrationMissing")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

