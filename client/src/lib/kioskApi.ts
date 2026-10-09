/**
 * Self-order kiosks ("קיוסקים") — pos-server app/routers/kiosks.py, the dashboard side of
 * the kiosk contract (§2.2): the kiosks and their live status, turning a till into a kiosk
 * and back, the settings layers (company → shop → kiosk), remote commands, the kiosk's
 * orders, and its media (`POST /kiosks/media`).
 */
import { api } from './api';
import {
  cloneJson,
  dietaryTagsOf,
  sha256Hex,
  type DietaryTag,
  type KioskConfig,
  type KioskFont,
  type KioskLayer,
  type MediaRef,
} from './kioskConfig';
import type { KioskJob, KioskZKind } from './kioskZ';

export type KioskLevel = 'company' | 'shop' | 'machine';
export type KioskFlowState =
  | 'attract'
  | 'ordering'
  | 'paying'
  | 'success'
  | 'paused'
  | 'closed'
  | 'admin'
  /** Waiting to be set up on the device. */
  | 'setup'
  /** The external pinpad is not configured or not reachable. */
  | 'no_payment'
  /** "מצב עבודה: קופה" — the device works as a till today (pos-server app/services/kiosk_till_mode.py). */
  | 'till_mode';

/**
 * "מצב עבודה: קיוסק / קופה" of one kiosk (pos-server kiosk_till_mode.summary_part): the owner's gate
 * (`kioskTillModeEnabled` — a super admin or a distributor sets it), the mode now, who is on it, and
 * what holds a switch sent from here (the kiosk's own refusal code and its Hebrew words).
 */
export interface KioskTillMode {
  enabled: boolean;
  idleReturnMinutes: number;
  orientation: 'auto' | 'portrait' | 'landscape';
  mode: 'kiosk' | 'till';
  since: string | null;
  enteredBy: string | null;
  employee: string | null;
  blocked: string | null;
  blockedText: string | null;
}

/** The screen the kiosk lays itself out on (P:/specs/kiosk-landscape-till-mode.md §2), as it reported it. */
export interface KioskDisplayReport {
  orientation?: 'portrait' | 'landscape';
  sizeClass?: 'handheld' | '11' | '13' | '15' | '21' | '27' | '32';
  diagonalInches?: number;
  physical?: boolean;
  scale?: number;
  widthDp?: number;
  heightDp?: number;
}
export type KioskPrinterHealth = 'ok' | 'warn' | 'error' | 'none';

export interface KioskControllerRef {
  machineId: string;
  name: string;
}

export interface KioskSummary {
  machineId: string;
  /** The kiosk's display name ("קיוסק כניסה"). */
  name: string;
  /** The till's own name. */
  machineName: string;
  posNumber: string | null;
  shopId: string | null;
  shopName: string | null;
  companyId: string | null;
  enabled: boolean;
  online: boolean;
  lastSeenAt: string | null;
  lastKioskSyncAt: string | null;
  appliedConfigVersion: string | null;
  configVersion: string | null;
  configUpToDate: boolean;
  fulfillmentMode: 'BON' | 'KDS';
  paused: boolean;
  pauseMessage: string | null;
  pausedAt: string | null;
  pausedBy: string | null;
  /** When the lock lifts by itself; null: by hand only. */
  pausedUntil?: string | null;
  pausedMode?: 'manual' | 'time' | 'minutes' | 'next_open' | null;
  /** The kiosk's effective hours and automatic Z, as the simple "פתיחה אוטומטית" form shows them. */
  schedule?: {
    enabled: boolean;
    days: number[];
    open: string | null;
    close: string | null;
    ranges: number;
    autoCloseAt: string;
  } | null;
  flowState: KioskFlowState | null;
  /** "מצב עבודה: קיוסק / קופה" — absent from an older server. */
  tillMode?: KioskTillMode | null;
  display?: KioskDisplayReport | null;
  shiftOpen: boolean | null;
  /** Who produces this till's Z: "till" (it does, on request) or "cloud" (the shop Z). */
  zMode: 'till' | 'cloud' | null;
  /**
   * Its Z mode per device (pos-server app/services/kiosk_z.py): `shop` ("Z סניפי" — offered
   * "סגירת משמרת"), `independent` ("Z עצמאי") or `own` ("Z לכל קופה") — offered "הפקת Z".
   */
  zKind?: KioskZKind | null;
  zKindLabel?: string | null;
  independentTill?: boolean | null;
  zAction?: 'close_shift' | 'till_z' | null;
  /** The last "סגירת משמרת" asked of it (36 h), and the last "הפקת Z". */
  shiftClose?: KioskJob | null;
  tillZRequest?: KioskJob | null;
  /** The machine's heartbeat receipt-printer status. */
  printerStatus: string | null;
  bonPrinter: KioskPrinterHealth | null;
  mediaReady: boolean | null;
  mediaMissing: number | null;
  ordersToday: number | null;
  salesTodayAgorot: number | null;
  lastOrderAt: string | null;
  unprintedBons: number | null;
  pendingOrders: number | null;
  /** "התראות לקופות" open now (app/services/kiosk_ops.py). */
  alerts?: KioskOpenAlert[];
  /** The last "סגירה יחד עם ה-Z הסניפי", within 36 h; null when none. */
  shopZClose?: KioskShopZClose | null;
  /** The terminal set for the kiosk beside the one it last reported, and the card lock (SPEC_KIOSK.md §20). */
  terminalIdentity?: KioskTerminalIdentity | null;
  controllerMachineIds: string[];
  controllers: KioskControllerRef[];
}

export interface KioskTerminalIdentity {
  /** The effective expected terminal number; it counts for a kiosk only when `expectedSource` is "machine". */
  expected: string | null;
  expectedSource: string | null;
  reportedNumber: string | null;
  reportedMerchant: string | null;
  reportedAt: string | null;
  /** Card payment locked on the last report; null: not locked. */
  cardLock: 'mismatch' | 'not_configured' | 'unknown' | null;
  /**
   * "עקיפת בדיקת מספר מסוף" on for the kiosk (docs/SPEC_KIOSK.md §20.1): no card lock, and the
   * warning; the level it comes from; what the kiosk itself last reported. Absent: an older server.
   */
  numberCheckBypass?: boolean;
  numberCheckBypassSource?: string | null;
  numberCheckBypassReported?: boolean | null;
}

export interface KioskOpenAlert {
  kind: 'printer' | 'terminal' | 'help';
  key: string;
  reason: string;
  text: string;
  raisedAt: string | null;
  acknowledgedBy: string | null;
}

export interface KioskShopZClose {
  id: string;
  state: 'pending' | 'delivered' | 'done' | 'failed' | 'expired';
  source: 'cloud_shop_z' | 'local_shop_z';
  requestedAt: string | null;
  finishedAt: string | null;
  zNumber: number | null;
  detail: string | null;
}

export interface KioskCandidate {
  machineId: string;
  name: string;
  posNumber: string | null;
  shopId: string | null;
  shopName: string | null;
  online: boolean;
}

export interface KioskSettings {
  level: KioskLevel;
  id: string;
  /** This level's own partial layer. */
  overrides: KioskLayer;
  /** What this level inherits: the defaults, the style's preset and the parent layers merged. */
  inherited: KioskConfig;
  /** What the parent layers set explicitly (no defaults, no preset); absent on an older server. */
  inheritedLayers?: KioskLayer | null;
  effective: KioskConfig;
  configVersion: string;
  /** The shop layer's kiosk menu version ("עריכת תפריט הקיוסק", SPEC_KIOSK §22); null at other levels. */
  menuVersion?: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface KioskDefaults {
  defaults: KioskConfig;
  fonts: KioskFont[];
  kdsAvailable: boolean;
  limits: Record<string, unknown>;
}

export interface KioskEffective {
  configVersion: string;
  config: KioskConfig;
  font: KioskFont | null;
  media: MediaRef[];
}

export type KioskCommandAction =
  | 'pause'
  | 'resume'
  | 'close_shift'
  | 'till_z'
  | 'schedule'
  /** "מצב עבודה": the dashboard's switch, both ways — done by the kiosk when no sale holds it. */
  | 'enter_till'
  | 'return_kiosk'
  /** "הדפס שוב את הבון האחרון" / "הדפס עסקה אחרונה" (the order's local id or "last" in `message`). */
  | 'reprint_bon'
  | 'reprint_receipt';

export interface KioskCommandIn {
  action: KioskCommandAction;
  message?: string;
  force?: boolean;
  /** "נעילה למכירה" (pause): until reopened by hand, HH:MM today, N minutes, or the next opening. */
  untilMode?: 'manual' | 'time' | 'minutes' | 'next_open';
  untilTime?: string;
  minutes?: number;
  /** "פתיחה אוטומטית" (schedule): written to the kiosk's own level. */
  schedule?: { enabled: boolean; days: number[]; open: string; close: string | null; autoCloseAt?: string | null };
}

export interface KioskCommandOut {
  id: string;
  action: KioskCommandAction;
  status: 'applied' | 'requested' | 'refused';
  requestId: string | null;
  detail: string | null;
  createdAt: string;
  source: 'dashboard' | 'till';
  requestedByName: string | null;
}

export type KioskBonStatus = 'none' | 'queued' | 'sent' | 'printed' | 'failed';
export type KioskReceiptStatus = 'printed' | 'declined' | 'failed' | 'skipped' | 'pending';

export interface KioskOrderOut {
  id: string;
  localId: string;
  transactionId: string | null;
  transactionNumber: number | string | null;
  pickupNumber: number;
  pickupLabel: string;
  businessDate: string;
  /** Null: "ללא סוג שירות". */
  serviceType: 'take_away' | 'eat_in' | null;
  tableRef: string | null;
  fulfillmentMode: 'BON' | 'KDS';
  configVersion: string | null;
  customerName: string | null;
  /** Masked to the last 3 digits unless the reader may see it whole. */
  customerPhone: string | null;
  itemCount: number;
  totalAgorot: number;
  tipAgorot: number;
  paidAt: string;
  bonStatus: KioskBonStatus;
  bonDetail: string | null;
  receiptStatus: KioskReceiptStatus;
  status: 'paid' | 'paid_print_failed' | 'recovered';
  createdAt: string | null;
  updatedAt: string | null;
}

/* ----------------------------------------------------------------- kiosks */

export async function fetchKiosks(params: { companyId?: string | null; shopId?: string | null } = {}): Promise<KioskSummary[]> {
  const { data } = await api.get<KioskSummary[]>('/kiosks', {
    params: {
      ...(params.companyId ? { companyId: params.companyId } : {}),
      ...(params.shopId ? { shopId: params.shopId } : {}),
    },
  });
  return Array.isArray(data) ? data : [];
}

export async function fetchKioskDefaults(): Promise<KioskDefaults> {
  const { data } = await api.get<KioskDefaults>('/kiosks/defaults');
  return data;
}

export async function fetchKioskCandidates(shopId?: string | null): Promise<KioskCandidate[]> {
  const { data } = await api.get<KioskCandidate[]>('/kiosks/candidates', {
    params: shopId ? { shopId } : {},
  });
  return Array.isArray(data) ? data : [];
}

export async function createKiosk(body: {
  machineId: string;
  name?: string;
  controllerMachineIds?: string[];
  lockDevice?: boolean;
}): Promise<KioskSummary> {
  const { data } = await api.post<KioskSummary>('/kiosks', body);
  return data;
}

export async function updateKiosk(
  machineId: string,
  body: { name?: string; enabled?: boolean; controllerMachineIds?: string[] },
): Promise<KioskSummary> {
  const { data } = await api.patch<KioskSummary>(`/kiosks/${machineId}`, body);
  return data;
}

/** Back to a regular till; its kiosk orders and the command audit are kept. */
export async function deleteKiosk(machineId: string): Promise<void> {
  await api.delete(`/kiosks/${machineId}`);
}

/* --------------------------------------------------------------- settings */

export async function fetchKioskSettings(level: KioskLevel, id: string): Promise<KioskSettings> {
  const { data } = await api.get<KioskSettings>('/kiosks/settings', { params: { level, id } });
  return data;
}

/**
 * Saves a level's layer. [menuVersion]: the shop's kiosk menu as loaded — a save that changes the
 * menu after a kiosk changed it is refused 409 `kiosk_menu_changed` (isKioskMenuChanged).
 */
export async function saveKioskSettings(level: KioskLevel, id: string, overrides: KioskLayer, menuVersion?: string | null): Promise<KioskSettings> {
  const body = menuVersion ? { overrides, menuVersion } : { overrides };
  const { data } = await api.put<KioskSettings>('/kiosks/settings', body, { params: { level, id } });
  return data;
}

/** The kiosk menu changed on a kiosk since this was loaded ("התפריט השתנה — טען מחדש"). */
export function isKioskMenuChanged(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } } } | null;
  return e?.response?.status === 409 && e.response.data?.detail === 'kiosk_menu_changed';
}

export async function fetchKioskEffective(machineId: string): Promise<KioskEffective> {
  const { data } = await api.get<KioskEffective>(`/kiosks/${machineId}/effective`);
  return data;
}

/** One error of a refused save: `422 { detail: { code: "invalid_kiosk_config", errors } }`. */
export interface KioskServerError {
  path: string;
  /** "required", "out_of_range", "must_be_less", … (app/services/kiosk_config.py). */
  code: string;
  /** The server's English message — shown only for a code this build has no words for. */
  message: string;
}

/** The per-field errors of a refused settings save, or null when it failed otherwise. */
export function kioskConfigErrors(err: unknown): KioskServerError[] | null {
  const detail = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response?.data?.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const d = detail as { code?: unknown; errors?: unknown };
  if (d.code !== 'invalid_kiosk_config' || !Array.isArray(d.errors)) return null;
  return d.errors
    .filter((x): x is { path?: unknown; code?: unknown; message?: unknown } => !!x && typeof x === 'object')
    .map((x) => ({ path: String(x.path ?? ''), code: String(x.code ?? ''), message: String(x.message ?? '') }));
}

/* --------------------------------------------------------------- commands */

export async function sendKioskCommand(machineId: string, body: KioskCommandIn): Promise<KioskCommandOut> {
  const { data } = await api.post<KioskCommandOut>(`/kiosks/${machineId}/commands`, body);
  return data;
}

/** "קיוסק — מצב קופה" at this kiosk's own level: on, off, or null (inherit). A super admin or a distributor only. */
export async function setKioskTillModeGate(machineId: string, enabled: boolean | null): Promise<KioskSummary> {
  const { data } = await api.put<KioskSummary>(`/kiosks/${machineId}/till-mode`, { enabled });
  return data;
}

export async function fetchKioskCommands(machineId: string, limit = 20): Promise<KioskCommandOut[]> {
  const { data } = await api.get<KioskCommandOut[]>(`/kiosks/${machineId}/commands`, { params: { limit } });
  return Array.isArray(data) ? data : [];
}

export async function fetchKioskOrders(machineId: string, date?: string): Promise<KioskOrderOut[]> {
  const { data } = await api.get<KioskOrderOut[]>(`/kiosks/${machineId}/orders`, {
    params: date ? { date } : {},
  });
  return Array.isArray(data) ? data : [];
}

/* -------------------------------------------- the catalog the kiosk sells */

/** One product as a till sees it (`GET /machines/{id}/catalog`). */
export interface KioskSourceProduct {
  id: string;
  name: string;
  /** Shekels, the shop's price. */
  price: number;
  categoryId: string | null;
  imageUrl: string | null;
  /** False = locked / sold out at this till. */
  available: boolean;
  description: string | null;
  /** vegan | vegetarian | dairy | meat | gluten_free | spicy (unknown ones dropped). */
  dietaryTags: DietaryTag[];
}

export interface KioskSourceCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface KioskSourceCatalog {
  machineId: string;
  machineName: string;
  /** In the till's order (sortOrder, then name). */
  categories: KioskSourceCategory[];
  products: KioskSourceProduct[];
}

/**
 * What a till sells, in the till's order — the products on it (its catalog mode and the
 * shop listing applied), the categories that hold them. The editor orders and hides on
 * top of it, and the preview renders it.
 */
export async function fetchKioskSourceCatalog(machineId: string): Promise<KioskSourceCatalog> {
  const { data } = await api.get<{
    machineId: string;
    machineName: string;
    products?: Array<{
      productId: string;
      name: string;
      price: number;
      categoryId: string | null;
      imageUrl: string | null;
      available: boolean;
      onTill: boolean;
      /** "היכן הפריט נמכר" (lib/productChannel.ts); pos_only is not on the kiosk. */
      salesChannel?: string;
      /** "מחייב אישור מנהל במכירה", resolved by the server (its category's too): never on a kiosk. */
      requiresManagerApproval?: boolean;
      description?: string | null;
      dietaryTags?: unknown;
    }>;
    categories?: KioskSourceCategory[];
  }>(`/machines/${machineId}/catalog`);
  const categories = (data.categories ?? [])
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'he'));
  return {
    machineId: String(data.machineId),
    machineName: data.machineName,
    categories: categories.map((c) => ({ id: String(c.id), name: c.name, sortOrder: c.sortOrder ?? 0 })),
    products: (data.products ?? [])
      // "קופות בלבד" is left out, as the kiosk itself leaves it out — and so is "מחייב אישור מנהל במכירה".
      .filter((p) => p.onTill !== false && p.salesChannel !== 'pos_only' && p.requiresManagerApproval !== true)
      .map((p) => ({
        id: String(p.productId),
        name: p.name,
        price: Number(p.price) || 0,
        categoryId: p.categoryId ? String(p.categoryId) : null,
        imageUrl: p.imageUrl ?? null,
        available: p.available !== false,
        description: typeof p.description === 'string' && p.description.trim() ? p.description : null,
        dietaryTags: dietaryTagsOf(p.dietaryTags),
      })),
  };
}

/** The till's own category images (`GET /categories`), by category id. */
export async function fetchCategoryImageUrls(): Promise<Record<string, string>> {
  const { data } = await api.get<unknown>('/categories');
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { items?: unknown[] }).items)
      ? (data as { items: unknown[] }).items
      : [];
  const out: Record<string, string> = {};
  const walk = (list: unknown[]) => {
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const r = row as { id?: unknown; imageUrl?: unknown; children?: unknown };
      if (r.id && typeof r.imageUrl === 'string' && r.imageUrl) out[String(r.id)] = r.imageUrl;
      if (Array.isArray(r.children)) walk(r.children);
    }
  };
  walk(rows);
  return out;
}

/* ------------------------------------------------------------------ media */

export const KIOSK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const KIOSK_VIDEO_TYPES = ['video/mp4', 'video/webm'];
export const KIOSK_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The bytes the server actually serves at `url`. An image may be re-encoded on the way in
 * (the API's own media store scales and re-saves it), so the checksum the kiosk verifies
 * must be of the stored file, not of the one picked. Null when the URL cannot be read
 * from the browser (CORS, network).
 */
async function fetchServedBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/** What `POST /kiosks/media` answers; `sha256` is of the bytes the server stored, null when it cannot know. */
interface KioskMediaUpload {
  url: string;
  kind: 'image' | 'video';
  bytes: number | null;
  sha256: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Upload an image or a short MP4/WebM video (≤ 25 MB) through `POST /kiosks/media` (any
 * kiosk write role) and return the kiosk's MediaRef. The checksum is the server's, taken
 * over the bytes it stored. When it has none (a Cloudinary image), the file is read back
 * from its URL and hashed in the browser; when that read is refused (CORS, network) the
 * ref gets no checksum (`sha256: null`) rather than one the kiosk would reject.
 */
export async function uploadKioskMedia(file: File): Promise<MediaRef> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<KioskMediaUpload>('/kiosks/media', form, {
    // Let the browser set multipart/form-data with its own boundary.
    headers: { 'Content-Type': undefined },
  });
  const kind: MediaRef['kind'] = data.kind === 'video' || file.type.startsWith('video/') ? 'video' : 'image';
  const bytes = typeof data.bytes === 'number' ? data.bytes : null;
  const sha = typeof data.sha256 === 'string' ? data.sha256.toLowerCase() : null;
  if (sha && SHA256_HEX.test(sha)) return { url: data.url, kind, sha256: sha, bytes };
  const served = await fetchServedBytes(data.url);
  if (served) {
    return { url: data.url, kind, sha256: await sha256Hex(served), bytes: served.byteLength };
  }
  return { url: data.url, kind, sha256: null, bytes };
}

/** A copy safe to put into a draft (the API objects are shared with react-query's cache). */
export function cloneConfig(cfg: KioskConfig): KioskConfig {
  return cloneJson(cfg);
}
