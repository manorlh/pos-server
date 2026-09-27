import type { PosMachine } from '@/lib/types';

const BATTERY_STATUSES = ['charging', 'discharging', 'full', 'not_charging', 'unknown'] as const;

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
    pairingStatus,
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
    businessDate: (raw.businessDate ?? raw.business_date) as string | undefined,
    openedAt: (raw.openedAt ?? raw.opened_at) as string | undefined,
    openedBy: (raw.openedBy ?? raw.opened_by) as string | undefined,
    closeShiftPending: Boolean(raw.closeShiftPending ?? raw.close_shift_pending ?? false),
    closedShiftsAwaitingZ: nullableNumber(raw.closedShiftsAwaitingZ ?? raw.closed_shifts_awaiting_z),
    orphanDocuments: nullableNumber(raw.orphanDocuments ?? raw.orphan_documents),
    reportedOpenShiftId: nullableString(raw.reportedOpenShiftId ?? raw.reported_open_shift_id),
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
    createdAt: String(raw.createdAt ?? raw.created_at ?? ''),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? ''),
  };
}
