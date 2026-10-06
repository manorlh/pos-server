/**
 * The shop Z in local mode ("קופה עצמאית בתוך סניף", docs/SPEC_INDEPENDENT_TILL.md §8): the
 * shop works over its main till on the LAN, so the dashboard never starts the shop Z — it
 * asks the main till for it ("בקש מהקופה הראשית"). The main till gets the request on its
 * next heartbeat, closes every till in the shop Z over the LAN and produces the Z itself.
 * pos-server `GET/POST/DELETE /shops/{id}/local-shop-z-request`.
 *
 * Pure rules: what a request's status reads as, when to poll, what may be pressed, and the
 * refusals that carry the server's Hebrew. No imports, so `npm test` compiles it alone.
 * The API calls are in lib/localShopZRequestApi.ts.
 */

export type LocalShopZStatus = 'waiting' | 'in_progress' | 'failed' | 'completed' | 'cancelled' | 'expired';

export interface LocalShopZTill {
  machineId: string;
  posNumber?: string | null;
  name?: string | null;
}

export interface LocalShopZRequest {
  id: string;
  status: LocalShopZStatus | string;
  mainTill?: LocalShopZTill | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  createdBy?: string | null;
  /** When the main till took it (its heartbeat); null until then. */
  sentAt?: string | null;
  /** `failed`: the main till's Hebrew word on the till that blocks the Z. */
  message?: string | null;
  zReportId?: string | null;
  shopSequenceNumber?: number | null;
  completedAt?: string | null;
}

export interface LocalShopZState {
  request: LocalShopZRequest | null;
  /** The shop works over a LAN main till: its shop Z is the main till's alone. */
  localMode: boolean;
  mainTill: LocalShopZTill | null;
}

/**
 * Still open: the main till has it, or will on its next heartbeat. A `failed` request is
 * too — the main till tries again by itself about every minute until it is cancelled or
 * expires.
 */
const PENDING: ReadonlySet<string> = new Set(['waiting', 'in_progress', 'failed']);

export function isPendingRequest(r: Pick<LocalShopZRequest, 'status'> | null | undefined): boolean {
  return !!r && PENDING.has(r.status);
}

/** How often to ask again: every 5 s while a request is open, else not at all. */
export const LOCAL_SHOP_Z_POLL_MS = 5000;

export function pollIntervalOf(state: LocalShopZState | null | undefined): number | false {
  return isPendingRequest(state?.request) ? LOCAL_SHOP_Z_POLL_MS : false;
}

/** "בקש מהקופה הראשית": only in local mode, and only with no request open. */
export function canRequestShopZ(state: LocalShopZState | null | undefined): boolean {
  return !!state && state.localMode && !isPendingRequest(state.request);
}

/** "בטל בקשה": while it is open. */
export function canCancelShopZ(state: LocalShopZState | null | undefined): boolean {
  return isPendingRequest(state?.request);
}

export type RequestTone = 'pending' | 'progress' | 'error' | 'success' | 'muted';

/** A request's status line: a message key under `independentTill.localShopZ.status`, its values, its tone. */
export interface RequestView {
  key:
    | 'waiting'
    | 'inProgress'
    | 'failed'
    | 'failedNoMessage'
    | 'completed'
    | 'completedNoNumber'
    | 'cancelled'
    | 'expired'
    | 'unknown';
  values: Record<string, string>;
  tone: RequestTone;
}

export function requestViewOf(r: LocalShopZRequest): RequestView {
  switch (r.status) {
    case 'waiting':
      return { key: 'waiting', values: {}, tone: 'pending' };
    case 'in_progress':
      return { key: 'inProgress', values: {}, tone: 'progress' };
    case 'failed': {
      const message = r.message?.trim();
      return message
        ? { key: 'failed', values: { message }, tone: 'error' }
        : { key: 'failedNoMessage', values: {}, tone: 'error' };
    }
    case 'completed':
      return r.shopSequenceNumber != null
        ? { key: 'completed', values: { n: String(r.shopSequenceNumber) }, tone: 'success' }
        : { key: 'completedNoNumber', values: {}, tone: 'success' };
    case 'cancelled':
      return { key: 'cancelled', values: {}, tone: 'muted' };
    case 'expired':
      return { key: 'expired', values: {}, tone: 'muted' };
    default:
      return { key: 'unknown', values: { status: String(r.status) }, tone: 'muted' };
  }
}

/** The Z report a completed request produced, if the server named it. */
export function zReportHrefOf(r: LocalShopZRequest | null | undefined): string | null {
  return r && r.status === 'completed' && r.zReportId ? `/dashboard/z-reports/${r.zReportId}` : null;
}

/** The server's Hebrew text on a refusal: `{detail: {message}}` or `{detail, message}`. */
export function serverMessageOf(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== 'object') return null;
  const d = data as { detail?: unknown; message?: unknown };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  if (d.detail && typeof d.detail === 'object' && !Array.isArray(d.detail)) {
    const inner = str((d.detail as { message?: unknown }).message);
    if (inner) return inner;
  }
  return str(d.message);
}

/**
 * `POST /z-runs` refused a shop Z that is the main till's (409 `z_only_from_main_till`);
 * `localMode` = the shop is in local mode, where the dashboard asks the main till instead.
 */
export function mainTillOnlyRefusalOf(
  err: unknown,
): { localMode: boolean; mainTill: LocalShopZTill | null; message: string | null } | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const d = detail as { code?: unknown; localMode?: unknown; mainTill?: unknown; message?: unknown };
  if (d.code !== 'z_only_from_main_till') return null;
  const main = d.mainTill && typeof d.mainTill === 'object' ? (d.mainTill as LocalShopZTill) : null;
  return {
    localMode: d.localMode === true,
    mainTill: main && typeof main.machineId === 'string' ? main : null,
    message: typeof d.message === 'string' && d.message.trim() ? d.message : null,
  };
}
