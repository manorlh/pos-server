import { DEVICE_MODELS, type DeviceModel, type PosMachine } from '@/lib/types';
import { normalizeMachineIntegration } from '@/lib/paymentIntegration';

const BATTERY_STATUSES = ['charging', 'discharging', 'full', 'not_charging', 'unknown'] as const;
const PRINTER_STATUSES = ['ok', 'no_paper', 'overheated', 'error', 'unavailable', 'unknown'] as const;

/**
 * Number-or-null, never number-or-zero.
 *
 * `batteryPercent` and `clockSkewMs` are nullable and null carries meaning ("the
 * device could not read it"), so they must not go through `Number(raw ?? 0)` the
 * way the boolean fields go through `Boolean(...)`. A missing battery reading
 * rendered as 0% is a false low-battery alarm on a distributor's dashboard.
 */
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function batteryStatus(value: unknown): PosMachine['batteryStatus'] {
  const s = nullableString(value)?.toLowerCase();
  if (!s) return null;
  return (BATTERY_STATUSES as readonly string[]).includes(s)
    ? (s as PosMachine['batteryStatus'])
    : 'unknown';
}

/** Null stays null (never reported); a value the dashboard does not know is 'unknown'. */
function printerStatus(value: unknown): PosMachine['printerStatus'] {
  const s = nullableString(value)?.toLowerCase();
  if (!s) return null;
  return (PRINTER_STATUSES as readonly string[]).includes(s)
    ? (s as PosMachine['printerStatus'])
    : 'unknown';
}

const TERMINAL_STATUSES = ['match', 'mismatch', 'unknown', 'not_required'] as const;

/**
 * Absent (a server that predates it) stays absent and shows nothing; a value the
 * dashboard does not know reads as "unknown", never as "match".
 */
function terminalStatus(value: unknown): PosMachine['terminalStatus'] {
  const s = nullableString(value);
  if (!s) return undefined;
  return (TERMINAL_STATUSES as readonly string[]).includes(s)
    ? (s as PosMachine['terminalStatus'])
    : 'unknown';
}

function terminalLastWrite(value: unknown): PosMachine['terminalLastWrite'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const w = value as Record<string, unknown>;
  return {
    field: nullableString(w.field),
    value: nullableString(w.value),
    ok: typeof w.ok === 'boolean' ? w.ok : null,
    error: nullableString(w.error),
    at: nullableString(w.at),
  };
}

/** Exported for the force answer, whose rows carry the same terminal fields. */
export function normalizeTerminalFields(raw: Record<string, unknown>) {
  return {
    terminalNumber: nullableString(raw.terminalNumber),
    terminalClearingServer: nullableString(raw.terminalClearingServer),
    terminalOfflineMode: typeof raw.terminalOfflineMode === 'boolean' ? raw.terminalOfflineMode : null,
    terminalReportedAt: nullableString(raw.terminalReportedAt),
    terminalLastWrite: terminalLastWrite(raw.terminalLastWrite),
    terminalMerchantName: nullableString(raw.terminalMerchantName),
    terminalSupplierNumber: nullableString(raw.terminalSupplierNumber),
    expectedTerminalNumber: nullableString(raw.expectedTerminalNumber),
    forceTerminalNumber: raw.forceTerminalNumber === true,
    forceTerminalNumberSource: (nullableString(raw.forceTerminalNumberSource) ??
      null) as PosMachine['forceTerminalNumberSource'],
    terminalStatus: terminalStatus(raw.terminalStatus),
    expectedTerminalNumberSource: nullableString(raw.expectedTerminalNumberSource),
    cardLock: (['mismatch', 'not_configured', 'unknown'] as const).find((v) => v === raw.cardLock) ?? null,
    // The network pinpad (app/services/payment_terminal.py): dropped here before, so the
    // "נדרשת כתובת IP למסופון" alert never showed.
    pinpadEnabled: raw.pinpadEnabled === true,
    pinpadHost: nullableString(raw.pinpadHost),
    pinpadPort: nullableString(raw.pinpadPort),
    pinpadRequired: raw.pinpadRequired === true,
    pinpadAddressMissing: raw.pinpadAddressMissing === true,
  };
}

/** What is waiting for this till's close: a Z run, a standalone request, or nothing known. */
function closeSource(value: unknown): PosMachine['pendingCloseSource'] {
  const s = nullableString(value);
  return s === 'z_run' || s === 'request' ? s : null;
}

/** A model this build knows, else null (unknown — read as a 55F). */
function deviceModel(value: unknown): PosMachine['deviceModel'] {
  const s = nullableString(value)?.toUpperCase();
  return (DEVICE_MODELS as readonly string[]).includes(s ?? '') ? (s as DeviceModel) : null;
}

/** `till` | `kiosk`; null when the server did not say. */
function deviceRole(value: unknown): PosMachine['deviceRole'] {
  const s = nullableString(value)?.toLowerCase();
  return s === 'till' || s === 'kiosk' ? s : null;
}

/** Absent (an older server) or anything unknown is the default, `cloud`. */
function zMode(value: unknown): NonNullable<PosMachine['zMode']> {
  return nullableString(value) === 'till' ? 'till' : 'cloud';
}

/** Normalize GET /machines rows (camelCase or snake_case, enum quirks). */
export function normalizePosMachine(raw: Record<string, unknown>): PosMachine {
  const pairingRaw = raw.pairingStatus ?? raw.pairing_status;
  let pairingStatus: PosMachine['pairingStatus'] = 'unpaired';
  if (typeof pairingRaw === 'string') {
    const p = pairingRaw.toLowerCase();
    if (p === 'paired' || p === 'assigned' || p === 'unpaired') {
      pairingStatus = p;
    }
  } else if (pairingRaw != null) {
    const s = String(pairingRaw).toLowerCase();
    if (s === 'paired' || s === 'assigned' || s === 'unpaired') {
      pairingStatus = s;
    }
  }

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    machineCode: String(raw.machineCode ?? raw.machine_code ?? ''),
    tenantId: (raw.tenantId ?? raw.tenant_id) as string | undefined,
    shopId: (raw.shopId ?? raw.shop_id) as string | undefined,
    posNumber: nullableString(raw.posNumber ?? raw.pos_number),
    documentPrefix: nullableString(raw.documentPrefix ?? raw.document_prefix),
    effectiveDocumentPrefix: nullableString(raw.effectiveDocumentPrefix ?? raw.effective_document_prefix),
    areaId: nullableString(raw.areaId ?? raw.area_id),
    areaName: nullableString(raw.areaName ?? raw.area_name),
    pairingStatus,
    shopNumber: nullableNumber(raw.shopNumber ?? raw.shop_number),
    companyNumber: nullableNumber(raw.companyNumber ?? raw.company_number),
    deviceModel: deviceModel(raw.deviceModel ?? raw.device_model),
    hasPrinter: typeof raw.hasPrinter === 'boolean' ? raw.hasPrinter : undefined,
    hasBuiltinTerminal: typeof raw.hasBuiltinTerminal === 'boolean' ? raw.hasBuiltinTerminal : undefined,
    // "סוג מכשיר" (docs/SPEC_DEVICE_ROLE_MODEL.md): the role, and the chosen / reported model.
    deviceRole: deviceRole(raw.deviceRole ?? raw.device_role),
    kioskEnabled: typeof raw.kioskEnabled === 'boolean' ? raw.kioskEnabled : null,
    deviceModelChosen: deviceModel(raw.deviceModelChosen ?? raw.device_model_chosen),
    deviceModelReported: deviceModel(raw.deviceModelReported ?? raw.device_model_reported),
    hasCashDrawerPort: raw.hasCashDrawerPort === true,
    deviceDriverPending: raw.deviceDriverPending === true,
    licenseType: (raw.licenseType ?? raw.license_type) === 'temporary' ? 'temporary' : 'permanent',
    licenseExpiresOn: nullableString(raw.licenseExpiresOn ?? raw.license_expires_on),
    mqttClientId: (raw.mqttClientId ?? raw.mqtt_client_id) as string | undefined,
    deviceInfo: (raw.deviceInfo ?? raw.device_info) as Record<string, unknown> | undefined,
    isActive: Boolean(raw.isActive ?? raw.is_active ?? true),
    lastHeartbeatAt: (raw.lastHeartbeatAt ?? raw.last_heartbeat_at) as string | undefined,
    mqttConnected: (raw.mqttConnected ?? raw.mqtt_connected) as boolean | null | undefined,
    lastSyncAt: (raw.lastSyncAt ?? raw.last_sync_at) as string | undefined,
    lastCatalogChangeAt: (raw.lastCatalogChangeAt ?? raw.last_catalog_change_at) as string | undefined,
    catalogPullStale: Boolean(raw.catalogPullStale ?? raw.catalog_pull_stale ?? false),
    shiftStatus: (raw.shiftStatus ?? raw.shift_status) as PosMachine['shiftStatus'],
    openShiftId: (raw.openShiftId ?? raw.open_shift_id) as string | undefined,
    openShiftSequence: nullableNumber(raw.openShiftSequence ?? raw.open_shift_sequence),
    businessDate: (raw.businessDate ?? raw.business_date) as string | undefined,
    openedAt: (raw.openedAt ?? raw.opened_at) as string | undefined,
    openedBy: (raw.openedBy ?? raw.opened_by) as string | undefined,
    closeShiftPending: Boolean(raw.closeShiftPending ?? raw.close_shift_pending ?? false),
    closedShiftsAwaitingZ: nullableNumber(raw.closedShiftsAwaitingZ ?? raw.closed_shifts_awaiting_z),
    orphanDocuments: nullableNumber(raw.orphanDocuments ?? raw.orphan_documents),
    reportedOpenShiftId: nullableString(raw.reportedOpenShiftId ?? raw.reported_open_shift_id),
    pendingCloseSource: closeSource(raw.pendingCloseSource ?? raw.pending_close_source),
    pendingZRunId: nullableString(raw.pendingZRunId ?? raw.pending_z_run_id),
    // The resolved status light and its flags. Passed through as the server sent them:
    // the light is decided server-side and must not be re-derived here.
    status: (nullableString(raw.status) ?? undefined) as PosMachine['status'],
    online: typeof raw.online === 'boolean' ? raw.online : undefined,
    statusFlags: (Array.isArray(raw.statusFlags ?? raw.status_flags)
      ? (raw.statusFlags ?? raw.status_flags)
      : []) as NonNullable<PosMachine['statusFlags']>,
    pendingDocuments: nullableNumber(raw.pendingDocuments ?? raw.pending_documents),
    pendingAsOf: nullableString(raw.pendingAsOf ?? raw.pending_as_of),
    serialNumber: nullableString(raw.serialNumber ?? raw.serial_number),
    batteryPercent: nullableNumber(raw.batteryPercent ?? raw.battery_percent),
    batteryStatus: batteryStatus(raw.batteryStatus ?? raw.battery_status),
    clockSkewMs: nullableNumber(raw.clockSkewMs ?? raw.clock_skew_ms),
    lastHealthReportAt: nullableString(raw.lastHealthReportAt ?? raw.last_health_report_at),
    // Card transmission: counts stay null-or-number (null = never reported, not zero).
    pendingTransmissionCount: nullableNumber(raw.pendingTransmissionCount),
    pendingTransmissionAmount: nullableString(raw.pendingTransmissionAmount),
    oldestPendingTransmissionAt: nullableString(raw.oldestPendingTransmissionAt),
    lastTransmissionAt: nullableString(raw.lastTransmissionAt),
    lastTransmissionError: nullableString(raw.lastTransmissionError),
    transmissionReportedAt: nullableString(raw.transmissionReportedAt),
    transmissionSource: nullableString(raw.transmissionSource),
    assumedTransmissionCount: nullableNumber(raw.assumedTransmissionCount),
    untransmittedCardLegs: nullableNumber(raw.untransmittedCardLegs),
    untransmittedCardAmount: nullableString(raw.untransmittedCardAmount),
    transmissionTrackingStartedAt: nullableString(raw.transmissionTrackingStartedAt),
    transmitPending: Boolean(raw.transmitPending ?? false),
    pendingTransmitRequestId: nullableString(raw.pendingTransmitRequestId),
    printerStatus: printerStatus(raw.printerStatus),
    printerErrorCode: nullableNumber(raw.printerErrorCode),
    printerMessage: nullableString(raw.printerMessage),
    printerStatusAt: nullableString(raw.printerStatusAt),
    printerLastOkAt: nullableString(raw.printerLastOkAt),
    printerReportedAt: nullableString(raw.printerReportedAt),
    ...normalizeTerminalFields(raw),
    // "סוג אינטגרציית אשראי" and the fields it still lacks (the machines list's badge).
    ...normalizeMachineIntegration(raw),
    zMode: zMode(raw.zMode ?? raw.z_mode),
    // "קופה עצמאית": absent (an older server) reads as not independent.
    independentTill: (raw.independentTill ?? raw.independent_till) === true,
    createdAt: String(raw.createdAt ?? raw.created_at ?? ''),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? ''),
  };
}
