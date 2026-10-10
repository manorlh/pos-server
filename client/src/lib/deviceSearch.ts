/**
 * "חיפוש מכשיר" — the cloud's device search (pos-server GET /machines/search,
 * app/services/device_identity.py): the filters as the dialog keeps them, the query they send,
 * the page that comes back, and how a row's SIMs and serial read. Pure: no imports, so
 * `npm test` compiles it alone (lib/deviceSearch.test.ts).
 */

export const DEVICE_SEARCH_PAGE_SIZE = 25;

export const LAST_SEEN_OPTIONS = ['online', '1h', '24h', '7d', 'over7d', 'never'] as const;
export type LastSeen = (typeof LAST_SEEN_OPTIONS)[number];

export const ROLE_OPTIONS = ['till', 'kiosk'] as const;
export type DeviceSearchRole = (typeof ROLE_OPTIONS)[number];

/** The dialog's filters; '' = not set. */
export interface DeviceSearchFilters {
  q: string;
  serial: string;
  posNumber: string;
  name: string;
  tenantId: string;
  companyId: string;
  shopId: string;
  model: string;
  role: DeviceSearchRole | '';
  appVersion: string;
  lastSeen: LastSeen | '';
  ip: string;
  carrier: string;
  phone: string;
  includeInactive: boolean;
}

export const EMPTY_DEVICE_SEARCH: DeviceSearchFilters = {
  q: '',
  serial: '',
  posNumber: '',
  name: '',
  tenantId: '',
  companyId: '',
  shopId: '',
  model: '',
  role: '',
  appVersion: '',
  lastSeen: '',
  ip: '',
  carrier: '',
  phone: '',
  includeInactive: false,
};

/** Any filter set (an empty search is still allowed: it lists the newest seen first). */
export function hasDeviceFilters(f: DeviceSearchFilters): boolean {
  return (Object.keys(EMPTY_DEVICE_SEARCH) as (keyof DeviceSearchFilters)[]).some((k) =>
    k === 'includeInactive' ? f.includeInactive : String(f[k]).trim() !== '',
  );
}

/** The query string's parameters: set filters only, trimmed; page is 0-based. */
export function deviceSearchParams(
  f: DeviceSearchFilters,
  page: number,
  pageSize: number = DEVICE_SEARCH_PAGE_SIZE,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const text: (keyof DeviceSearchFilters)[] = [
    'q', 'serial', 'posNumber', 'name', 'tenantId', 'companyId', 'shopId', 'model', 'role',
    'appVersion', 'lastSeen', 'ip', 'carrier', 'phone',
  ];
  for (const k of text) {
    const v = String(f[k] ?? '').trim();
    if (v) out[k] = v;
  }
  if (f.includeInactive) out.includeInactive = true;
  const size = Math.max(1, Math.min(100, Math.floor(pageSize)));
  out.skip = Math.max(0, Math.floor(page)) * size;
  out.limit = size;
  return out;
}

export interface DeviceSearchSim {
  slot: number;
  carrier?: string | null;
  networkType?: string | null;
  signal?: number | null;
  defaultData?: boolean | null;
  inService?: boolean | null;
  phoneNumber?: string | null;
}

export interface DeviceSearchRow {
  id: string;
  name: string;
  machineCode: string;
  posNumber: string | null;
  tenantId: string | null;
  tenantName: string | null;
  companyId: string | null;
  companyName: string | null;
  shopId: string | null;
  shopName: string | null;
  deviceModel: string | null;
  deviceRole: DeviceSearchRole;
  appVersion: string | null;
  lastHeartbeatAt: string | null;
  online: boolean;
  isActive: boolean;
  serialNumber: string | null;
  serialSource: string | null;
  lastIp: string | null;
  lanIp: string | null;
  sims: DeviceSearchSim[];
  viaCellular: boolean;
}

export interface DeviceSearchPage {
  items: DeviceSearchRow[];
  total: number;
  skip: number;
  limit: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** The server's page, defensively: a missing field is null, a bad row is dropped. */
export function parseDeviceSearchPage(raw: unknown): DeviceSearchPage {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = (Array.isArray(o.items) ? o.items : [])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
    .map((r) => ({
      id: String(r.id),
      name: str(r.name) ?? '',
      machineCode: str(r.machineCode) ?? '',
      posNumber: str(r.posNumber),
      tenantId: str(r.tenantId),
      tenantName: str(r.tenantName),
      companyId: str(r.companyId),
      companyName: str(r.companyName),
      shopId: str(r.shopId),
      shopName: str(r.shopName),
      deviceModel: str(r.deviceModel),
      deviceRole: (r.deviceRole === 'kiosk' ? 'kiosk' : 'till') as DeviceSearchRole,
      appVersion: str(r.appVersion),
      lastHeartbeatAt: str(r.lastHeartbeatAt),
      online: r.online === true,
      isActive: r.isActive !== false,
      serialNumber: str(r.serialNumber),
      serialSource: str(r.serialSource),
      lastIp: str(r.lastIp),
      lanIp: str(r.lanIp),
      sims: (Array.isArray(r.sims) ? r.sims : [])
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && num((s as { slot?: unknown }).slot) !== null)
        .map((s) => ({
          slot: num(s.slot)!,
          carrier: str(s.carrier),
          networkType: str(s.networkType),
          signal: num(s.signal),
          defaultData: bool(s.defaultData),
          inService: bool(s.inService),
          phoneNumber: str(s.phoneNumber),
        })),
      viaCellular: r.viaCellular === true,
    }));
  return {
    items,
    total: num(o.total) ?? items.length,
    skip: num(o.skip) ?? 0,
    limit: num(o.limit) ?? DEVICE_SEARCH_PAGE_SIZE,
  };
}

/** "סים 1: פרטנר 4G (נתונים) · סים 2: סלקום 5G" — '' without a SIM. */
export function simSummary(sims: DeviceSearchSim[]): string {
  return [...sims]
    .sort((a, b) => a.slot - b.slot)
    .map((s) => {
      const parts = [s.carrier, s.networkType].filter((p): p is string => !!p);
      return `סים ${s.slot}: ${parts.join(' ') || 'לא ידוע'}${s.defaultData ? ' (נתונים)' : ''}`;
    })
    .join(' · ');
}

/** The phone numbers of a row's SIMs, as the SIMs store them. */
export function phonesOf(sims: DeviceSearchSim[]): string[] {
  return sims.map((s) => s.phoneNumber).filter((p): p is string => !!p);
}

/** Where the serial came from, as people say it. */
export function serialSourceLabel(source: string | null | undefined): string | null {
  switch (source) {
    case 'ftpos':
      return 'Feitian SDK';
    case 'sunmi':
      return 'SUNMI';
    case 'kozen':
      return 'Kozen SDK';
    case 'build':
      return 'Android';
    case 'ro.serialno':
      return 'ro.serialno';
    default:
      return source ? source : null;
  }
}

/** The pages there are, and whether there is a next one. */
export function pageCount(total: number, pageSize: number = DEVICE_SEARCH_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}
