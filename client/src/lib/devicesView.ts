/**
 * "מכשירים" — the devices page's search, filters, sort and their URL (app/dashboard/machines).
 * The owner: "בענן במכשירים, שדרג את ה-UI לצורה יותר נוחה, תציג סיריאלי של כל מכשיר ואפשר חיפוש
 * לפי סיריאלי, לפי דגם, ואפשר סינונים".
 *
 * * **Search** — one box over the name, the register label ("קופה 2"), the serial (any part of
 *   it: its last digits are enough), the model (its code, its Hebrew label, its name on the box,
 *   its maker — also in Hebrew letters), the role and platform, the shop, its company, the area,
 *   the app version, the device's addresses and its SIMs (carrier, phone). Forgiving like the
 *   model picker (lib/optionSearch.ts `normalizeSearchText`): case, niqqud, geresh, Hebrew final
 *   letters and punctuation are ignored. Every word of the query must be found (in any field).
 *   A word of one or two characters only starts a word ("T2", "קופה 2"), so "2" does not find
 *   every serial with a 2 in it; from three characters on it is found anywhere, and in the
 *   identifiers (serial, device code, IP, app version, phone) separators are ignored
 *   ("PB12-34" = "pb1234").
 * * **Filters** — status, role, platform, model, version (current / older than the newest one
 *   in view on its platform / unknown), area, shop and flags (never seen, training, locked, shop
 *   switched off). Any of the values chosen in one filter, all the filters together. The counts
 *   beside each value are of the rows the search and the *other* filters leave, so choosing a
 *   value never rewrites the numbers of its own filter.
 * * **Sort** — by shop (the default: company and shop, then the tills by register number, the
 *   screens after them), name, model, serial, role, version, last seen or status. A row without
 *   the value (no serial, no version…) goes last whichever way.
 * * **URL** — the filters and the sort are the page's query (a filtered view can be shared), next
 *   to the scope's own `company` / `shop` / `machine`, which are never touched.
 *
 * Only sibling libs imported (no `@/`), so `npm test` compiles it on its own
 * (lib/devicesView.test.ts).
 */

import { DEVICE_MODEL_NAMES, deviceModelKeywords } from './deviceModelSearch';
import { DEVICE_ROLES, isDisplayDevice, type DeviceModelId } from './deviceProfile';
import { serialSourceLabel } from './deviceSearch';
import { normalizeSearchText } from './optionSearch';

// ── The row ──────────────────────────────────────────────────────────────────

/** What this module reads of a machine (`PosMachine` is one). */
export interface DeviceViewRow {
  id: string;
  name: string;
  machineCode: string;
  shopId?: string | null;
  posNumber?: string | null;
  areaId?: string | null;
  areaName?: string | null;
  deviceModel?: string | null;
  deviceRole?: string | null;
  fiscal?: boolean | null;
  platform?: string | null;
  appVersion?: string | null;
  serialNumber?: string | null;
  serialSource?: string | null;
  lastHeartbeatAt?: string | null;
  status?: string | null;
  lastIp?: string | null;
  lanIp?: string | null;
  cellular?: { sims?: Array<{ carrier?: string | null; phoneNumber?: string | null } | null> | null } | null;
  trainingMode?: boolean | null;
  remoteLocked?: boolean | null;
  shopActive?: boolean | null;
}

/** The words the page has (its translations and its shops), handed in so this stays pure. */
export interface DeviceViewContext {
  shopName: (shopId: string) => string | null | undefined;
  /** The shop's company path ("Acme ▸ North"), searched and sorted before the shop. */
  companyName?: (shopId: string) => string | null | undefined;
  /** "קופה 2". */
  registerLabel: (n: number) => string;
  /** The model's Hebrew label (messages machines.deviceModel.<id>). */
  modelLabel: (model: string) => string;
  roleLabel: (role: DeviceRoleKey) => string;
  platformLabel: (platform: DevicePlatformKey) => string;
}

/** The server's status values, attention first (the status strip's order). */
export const STATUS_ORDER = [
  'offline_with_unsynced',
  'offline',
  'pending_sync',
  'shift_close_pending',
  'no_open_shift',
  'online',
  'not_paired',
  'retired',
] as const;

export const ROLE_KEYS = DEVICE_ROLES;
export type DeviceRoleKey = (typeof ROLE_KEYS)[number];
export const PLATFORM_KEYS = ['android', 'windows', 'web'] as const;
export type DevicePlatformKey = (typeof PLATFORM_KEYS)[number];
export const VERSION_KEYS = ['current', 'old', 'unknown'] as const;
export type VersionKey = (typeof VERSION_KEYS)[number];
export const FLAG_KEYS = ['neverSeen', 'training', 'locked', 'inactiveShop'] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

/** The model / area / shop value of a row that has none. */
export const NONE = 'none';

/** "קופה 2"'s 2, or null (no shop, or not a plain positive number) — lib/registerNumber.ts's rule. */
export function registerNumberOf(row: Pick<DeviceViewRow, 'shopId' | 'posNumber'>): number | null {
  if (!row.shopId || row.posNumber == null) return null;
  const raw = String(row.posNumber).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** The server's status, or "not_paired" when it sent none (components/dashboard/machine-status.tsx). */
export function statusOf(row: Pick<DeviceViewRow, 'status'>): string {
  return row.status || 'not_paired';
}

/** The role as the badges read it: no role is a till; a display device the server named only by `fiscal` is a KDS. */
export function roleOf(row: Pick<DeviceViewRow, 'deviceRole' | 'fiscal'>): DeviceRoleKey {
  const role = (ROLE_KEYS as readonly string[]).includes(row.deviceRole ?? '') ? (row.deviceRole as DeviceRoleKey) : null;
  if (isDisplayDevice(row)) return role && role !== 'till' && role !== 'kiosk' ? role : 'kds';
  return role ?? 'till';
}

/** Android unless the server says Windows or a browser (a machine paired before the column is Android). */
export function platformOf(row: Pick<DeviceViewRow, 'platform'>): DevicePlatformKey {
  return row.platform === 'windows' ? 'windows' : row.platform === 'web' ? 'web' : 'android';
}

export function modelOf(row: Pick<DeviceViewRow, 'deviceModel'>): string {
  return row.deviceModel?.trim() || NONE;
}

/** The flags a row carries (a row may carry several). */
export function flagsOf(row: DeviceViewRow): FlagKey[] {
  const out: FlagKey[] = [];
  if (!row.lastHeartbeatAt) out.push('neverSeen');
  if (row.trainingMode) out.push('training');
  if (row.remoteLocked) out.push('locked');
  if (row.shopId && row.shopActive === false) out.push('inactiveShop');
  return out;
}

// ── The serial ───────────────────────────────────────────────────────────────

/** The serial as the row shows it, and where it came from ("SUNMI", "Android"…); null = "לא דווח". */
export function serialOf(row: Pick<DeviceViewRow, 'serialNumber' | 'serialSource'>): {
  serial: string;
  source: string | null;
} | null {
  const serial = row.serialNumber?.trim();
  if (!serial) return null;
  return { serial, source: serialSourceLabel(row.serialSource) };
}

// ── The app version ──────────────────────────────────────────────────────────

/** "0.1.248+b6e07db-device" → [0, 1, 248]; null when it does not start with a number. */
export function parseAppVersion(version: string | null | undefined): number[] | null {
  const head = (version ?? '').trim().split('+', 1)[0];
  const m = /^v?(\d+(?:\.\d+)*)/i.exec(head);
  if (!m) return null;
  return m[1].split('.').map(Number);
}

/** The version as the row shows it: without the build ("+b6e07db-device"). */
export function shortAppVersion(version: string | null | undefined): string | null {
  const head = (version ?? '').trim().split('+', 1)[0].trim();
  return head || null;
}

/** <0, 0, >0 — part by part, a missing part is 0 ("1.2" = "1.2.0"). */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest version seen per platform (the Windows app and the APK are numbered apart). */
export function newestVersions(rows: readonly DeviceViewRow[]): Map<DevicePlatformKey, number[]> {
  const out = new Map<DevicePlatformKey, number[]>();
  for (const row of rows) {
    const v = parseAppVersion(row.appVersion);
    if (!v) continue;
    const platform = platformOf(row);
    const best = out.get(platform);
    if (!best || compareVersions(v, best) > 0) out.set(platform, v);
  }
  return out;
}

/** "גרסה ישנה": below the newest version in view on its platform; unknown when it never said. */
export function versionStateOf(row: DeviceViewRow, newest: Map<DevicePlatformKey, number[]>): VersionKey {
  const v = parseAppVersion(row.appVersion);
  if (!v) return 'unknown';
  const best = newest.get(platformOf(row));
  return best && compareVersions(v, best) < 0 ? 'old' : 'current';
}

// ── Search ───────────────────────────────────────────────────────────────────

const compact = (text: string): string => normalizeSearchText(text).replace(/ /g, '');

/** The query's words, as they are compared (empty: no search). */
export function searchTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map(compact)
    .filter((t) => t !== '');
}

interface Haystack {
  /** Each text field's compact text from each of its words on ("sunmi t2 mini" → "sunmit2mini", "t2mini", "mini"). */
  fromWord: string[];
  /** Each text field's whole compact text. */
  texts: string[];
  /** Serial, device code, addresses, app version, phones: compact, separators gone. */
  ids: string[];
  register: string | null;
}

function fromWords(text: string): string[] {
  const words = normalizeSearchText(text).split(' ').filter(Boolean);
  return words.map((_, i) => words.slice(i).join(''));
}

function haystackOf(row: DeviceViewRow, ctx: DeviceViewContext): Haystack {
  const n = registerNumberOf(row);
  const role = roleOf(row);
  const platform = platformOf(row);
  const model = row.deviceModel?.trim() || null;
  const sims = (row.cellular?.sims ?? []).filter((s): s is NonNullable<typeof s> => !!s && typeof s === 'object');
  const text: Array<string | null | undefined> = [
    row.name,
    n !== null ? ctx.registerLabel(n) : null,
    row.shopId ? ctx.shopName(row.shopId) : null,
    row.shopId && ctx.companyName ? ctx.companyName(row.shopId) : null,
    row.areaName,
    ctx.roleLabel(role),
    ctx.platformLabel(platform),
    model,
    model ? ctx.modelLabel(model) : null,
    ...(model && model in DEVICE_MODEL_NAMES ? deviceModelKeywords(model as DeviceModelId) : []),
    serialSourceLabel(row.serialSource),
    ...sims.map((s) => s.carrier),
  ];
  const texts = text.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  // The version is an identifier too: its "2" in "0.4.2" must not answer "קופה 2".
  const ids = [
    row.serialNumber,
    row.machineCode,
    row.lastIp,
    row.lanIp,
    row.appVersion,
    ...sims.map((s) => s.phoneNumber),
  ]
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map(compact)
    .filter(Boolean);
  return {
    fromWord: texts.flatMap(fromWords),
    texts: texts.map(compact),
    ids,
    register: n !== null ? String(n) : null,
  };
}

function tokenFound(token: string, h: Haystack): boolean {
  if (token === h.register) return true;
  if (h.fromWord.some((w) => w.startsWith(token))) return true;
  if (token.length < 3) return false;
  return h.texts.some((t) => t.includes(token)) || h.ids.some((id) => id.includes(token));
}

/** Whether a row answers the query (an empty query answers every row). */
export function matchesSearch(row: DeviceViewRow, query: string, ctx: DeviceViewContext): boolean {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return true;
  const h = haystackOf(row, ctx);
  return tokens.every((t) => tokenFound(t, h));
}

// ── Filters ──────────────────────────────────────────────────────────────────

export const FILTER_KEYS = ['status', 'role', 'platform', 'model', 'version', 'area', 'shop', 'flag'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** The search and each filter's chosen values ([] = not filtered). */
export type DeviceFilters = { q: string } & Record<FilterKey, string[]>;

export const EMPTY_FILTERS: DeviceFilters = {
  q: '',
  status: [],
  role: [],
  platform: [],
  model: [],
  version: [],
  area: [],
  shop: [],
  flag: [],
};

/** The values a filter can take whatever the rows (the others come from the rows themselves). */
const FIXED_VALUES: Partial<Record<FilterKey, readonly string[]>> = {
  status: STATUS_ORDER,
  role: ROLE_KEYS,
  platform: PLATFORM_KEYS,
  version: VERSION_KEYS,
  flag: FLAG_KEYS,
};

/** The row's values for one filter (a row has one of each, but flags: any number). */
export function valuesOf(row: DeviceViewRow, key: FilterKey, newest: Map<DevicePlatformKey, number[]>): string[] {
  switch (key) {
    case 'status':
      return [statusOf(row)];
    case 'role':
      return [roleOf(row)];
    case 'platform':
      return [platformOf(row)];
    case 'model':
      return [modelOf(row)];
    case 'version':
      return [versionStateOf(row, newest)];
    case 'area':
      return [row.areaId || NONE];
    case 'shop':
      return [row.shopId || NONE];
    case 'flag':
      return flagsOf(row);
  }
}

export function hasActiveFilters(f: DeviceFilters): boolean {
  return f.q.trim() !== '' || FILTER_KEYS.some((k) => f[k].length > 0);
}

/** How many filters (not values) are on, the search not counted. */
export function activeFilterCount(f: DeviceFilters): number {
  return FILTER_KEYS.filter((k) => f[k].length > 0).length;
}

/** `value` on or off in filter `key`, the rest as it was (a new object). */
export function toggleFilterValue(f: DeviceFilters, key: FilterKey, value: string): DeviceFilters {
  const has = f[key].includes(value);
  return { ...f, [key]: has ? f[key].filter((v) => v !== value) : [...f[key], value] };
}

/**
 * The filters as they can apply to these rows: a value no row could ever have — an area, a shop
 * or a model not among the rows in view (a link from another scope), a status this build does
 * not know — is dropped rather than leaving an empty list nobody can explain. A known value with
 * no row now (no device is offline) stays: that is a true answer.
 */
export function effectiveFilters(f: DeviceFilters, rows: readonly DeviceViewRow[]): DeviceFilters {
  const out: DeviceFilters = { ...f };
  for (const key of FILTER_KEYS) {
    if (f[key].length === 0) continue;
    const fixed = FIXED_VALUES[key];
    let known: Set<string>;
    if (fixed) known = new Set(fixed);
    else {
      known = new Set();
      for (const row of rows) for (const v of valuesOf(row, key, new Map())) known.add(v);
    }
    out[key] = f[key].filter((v) => known.has(v));
  }
  return out;
}

export interface FilterResult<T extends DeviceViewRow> {
  rows: T[];
  /** Per filter, per value: the rows the search and the other filters leave with that value. */
  counts: Record<FilterKey, Map<string, number>>;
  /** The newest version per platform among all the rows (the "גרסה ישנה" yardstick). */
  newest: Map<DevicePlatformKey, number[]>;
  /** The filters as applied (`effectiveFilters`). */
  filters: DeviceFilters;
}

/** The rows the search and the filters leave, and the counts beside each filter's values. */
export function applyDeviceFilters<T extends DeviceViewRow>(
  rows: readonly T[],
  filters: DeviceFilters,
  ctx: DeviceViewContext,
): FilterResult<T> {
  const f = effectiveFilters(filters, rows);
  const newest = newestVersions(rows);
  const counts = Object.fromEntries(FILTER_KEYS.map((k) => [k, new Map<string, number>()])) as Record<
    FilterKey,
    Map<string, number>
  >;
  const out: T[] = [];
  for (const row of rows) {
    if (!matchesSearch(row, f.q, ctx)) continue;
    const values = Object.fromEntries(FILTER_KEYS.map((k) => [k, valuesOf(row, k, newest)])) as Record<
      FilterKey,
      string[]
    >;
    const passes = Object.fromEntries(
      FILTER_KEYS.map((k) => [k, f[k].length === 0 || values[k].some((v) => f[k].includes(v))]),
    ) as Record<FilterKey, boolean>;
    for (const key of FILTER_KEYS) {
      // Counted when every other filter lets the row through.
      if (!FILTER_KEYS.every((other) => other === key || passes[other])) continue;
      for (const v of values[key]) counts[key].set(v, (counts[key].get(v) ?? 0) + 1);
    }
    if (FILTER_KEYS.every((k) => passes[k])) out.push(row);
  }
  return { rows: out, counts, newest, filters: f };
}

/** The values to offer for a filter that come from the rows (models, areas, shops), each once. */
export function rowValues(rows: readonly DeviceViewRow[], key: 'model' | 'area' | 'shop'): string[] {
  const seen = new Set<string>();
  for (const row of rows) seen.add(valuesOf(row, key, new Map())[0]);
  return [...seen];
}

// ── Sort ─────────────────────────────────────────────────────────────────────

export const SORT_KEYS = ['shop', 'name', 'model', 'serial', 'role', 'version', 'lastSeen', 'status'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface DeviceSort {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_SORT: DeviceSort = { key: 'shop', dir: 'asc' };

const collator = (a: string, b: string): number =>
  a.localeCompare(b, 'he-IL', { sensitivity: 'base', numeric: true });

/** The label the name column shows and sorts by: "קופה 2", else the name. */
export function deviceLabelOf(row: DeviceViewRow, ctx: Pick<DeviceViewContext, 'registerLabel'>): string {
  const n = registerNumberOf(row);
  return n !== null ? ctx.registerLabel(n) : row.name;
}

/** Shop, then tills before screens, then register number, then name — the default order and every tie's. */
function compareByPlace(a: DeviceViewRow, b: DeviceViewRow, ctx: DeviceViewContext): number {
  const shopKey = (r: DeviceViewRow) =>
    r.shopId ? `${(ctx.companyName?.(r.shopId) ?? '')}\u0001${ctx.shopName(r.shopId) ?? r.shopId}` : null;
  const sa = shopKey(a);
  const sb = shopKey(b);
  if (sa === null && sb !== null) return 1;
  if (sa !== null && sb === null) return -1;
  if (sa !== null && sb !== null) {
    const d = collator(sa, sb);
    if (d !== 0) return d;
    if (a.shopId !== b.shopId) return collator(a.shopId ?? '', b.shopId ?? '');
  }
  return compareInPlace(a, b);
}

function compareInPlace(a: DeviceViewRow, b: DeviceViewRow): number {
  const screen = (r: DeviceViewRow) => (isDisplayDevice(r) ? 1 : 0);
  const d = screen(a) - screen(b);
  if (d !== 0) return d;
  const na = registerNumberOf(a);
  const nb = registerNumberOf(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;
  return collator(a.name, b.name) || collator(a.id, b.id);
}

type SortValue = string | number | number[] | null;

function sortValue(row: DeviceViewRow, key: SortKey, ctx: DeviceViewContext): SortValue {
  switch (key) {
    case 'shop':
      return null; // compareByPlace
    case 'name':
      return deviceLabelOf(row, ctx);
    case 'model': {
      const model = row.deviceModel?.trim();
      return model ? ctx.modelLabel(model) : null;
    }
    case 'serial':
      return row.serialNumber?.trim() || null;
    case 'role':
      return ROLE_KEYS.indexOf(roleOf(row));
    case 'version':
      return parseAppVersion(row.appVersion);
    case 'lastSeen': {
      // Never seen is the stalest of all, not a missing value.
      const ts = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : NaN;
      return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
    }
    case 'status': {
      const i = (STATUS_ORDER as readonly string[]).indexOf(statusOf(row));
      return i === -1 ? STATUS_ORDER.length : i;
    }
  }
}

function compareValues(a: Exclude<SortValue, null>, b: Exclude<SortValue, null>): number {
  if (Array.isArray(a) && Array.isArray(b)) return compareVersions(a, b);
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  return collator(String(a), String(b));
}

/** A sorted copy. Rows without the value go last either way; ties fall back to shop, register number, name. */
export function sortDevices<T extends DeviceViewRow>(rows: readonly T[], sort: DeviceSort, ctx: DeviceViewContext): T[] {
  const sign = sort.dir === 'desc' ? -1 : 1;
  const keyed = rows.map((row) => ({ row, v: sortValue(row, sort.key, ctx) }));
  keyed.sort((x, y) => {
    if (sort.key === 'shop') {
      // The shop reverses; the order inside a shop stays the counter's (1, 2, 3).
      const sx = x.row.shopId ? 0 : 1;
      const sy = y.row.shopId ? 0 : 1;
      if (sx !== sy) return sx - sy;
      if (x.row.shopId !== y.row.shopId) return sign * compareByPlace(x.row, y.row, ctx);
      return compareInPlace(x.row, y.row);
    }
    if (x.v === null && y.v !== null) return 1;
    if (x.v !== null && y.v === null) return -1;
    if (x.v !== null && y.v !== null) {
      const d = compareValues(x.v, y.v);
      if (d !== 0) return sign * d;
    }
    return compareByPlace(x.row, y.row, ctx);
  });
  return keyed.map((k) => k.row);
}

/** A header click: the same column flips its direction, another starts ascending. */
export function nextSort(current: DeviceSort, key: SortKey): DeviceSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

// ── URL ──────────────────────────────────────────────────────────────────────

/** The page's own query keys — never the scope's `company` / `shop` / `machine`. */
export const URL_KEYS: Record<FilterKey | 'q' | 'sort', string> = {
  q: 'q',
  status: 'status',
  role: 'role',
  platform: 'platform',
  model: 'model',
  version: 'ver',
  // Not `area`: that is the top-bar scope's point of sale (SCOPE_PARAM.area), which this filter
  // only defaults to (P:/specs/chain-areas.md §2.5).
  area: 'areas',
  shop: 'shops',
  flag: 'flags',
  sort: 'sort',
};

const LIST_VALUE = /^[\w.:-]{1,80}$/;

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v && LIST_VALUE.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

function parseSort(raw: string | null): DeviceSort {
  if (!raw) return DEFAULT_SORT;
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  if (!(SORT_KEYS as readonly string[]).includes(key)) return DEFAULT_SORT;
  return { key: key as SortKey, dir: desc ? 'desc' : 'asc' };
}

/** Whether a query string carries any of the page's keys (then it wins over what was remembered). */
export function hasViewParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return Object.values(URL_KEYS).some((k) => params.has(k));
}

/** The filters and the sort a query string names (anything else in it is ignored). */
export function viewFromParams(search: string): { filters: DeviceFilters; sort: DeviceSort } {
  const params = new URLSearchParams(search);
  const filters: DeviceFilters = { ...EMPTY_FILTERS, q: (params.get(URL_KEYS.q) ?? '').slice(0, 200) };
  for (const key of FILTER_KEYS) filters[key] = parseList(params.get(URL_KEYS[key]));
  return { filters, sort: parseSort(params.get(URL_KEYS.sort)) };
}

/**
 * The query string with the page's keys set to these filters and this sort — only what is not
 * the default — and every other key (the scope's, a tab's) kept as it was. No leading "?".
 */
export function viewToParams(search: string, filters: DeviceFilters, sort: DeviceSort): string {
  const params = new URLSearchParams(search);
  for (const k of Object.values(URL_KEYS)) params.delete(k);
  const q = filters.q.trim();
  if (q) params.set(URL_KEYS.q, q);
  for (const key of FILTER_KEYS) {
    const values = filters[key].filter((v) => LIST_VALUE.test(v));
    if (values.length > 0) params.set(URL_KEYS[key], values.join(','));
  }
  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) {
    params.set(URL_KEYS.sort, `${sort.dir === 'desc' ? '-' : ''}${sort.key}`);
  }
  return params.toString();
}

// ── Remembered per viewer ────────────────────────────────────────────────────

export type DevicesLayout = 'table' | 'cards';

export interface StoredDevicesView {
  filters: DeviceFilters;
  sort: DeviceSort;
  layout: DevicesLayout;
}

export const STORAGE_KEY = 'devicesView:v1';

export function serializeStoredView(view: StoredDevicesView): string {
  return JSON.stringify({ search: viewToParams('', view.filters, view.sort), layout: view.layout });
}

/** What was remembered, or the defaults for anything missing or unreadable. */
export function parseStoredView(raw: string | null | undefined): StoredDevicesView {
  let o: { search?: unknown; layout?: unknown } = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') o = parsed as typeof o;
  } catch {
    o = {};
  }
  const { filters, sort } = viewFromParams(typeof o.search === 'string' ? o.search : '');
  return { filters, sort, layout: o.layout === 'cards' ? 'cards' : 'table' };
}
