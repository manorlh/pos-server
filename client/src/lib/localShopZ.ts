/**
 * The shop Z in local mode ("קופה עצמאית בתוך סניף", docs/SPEC_INDEPENDENT_TILL.md §8): the
 * shop works over its main till on the LAN, so the dashboard never starts the shop Z — it
 * asks the main till for it ("בקש מהקופה הראשית"). The main till gets the request on its
 * next heartbeat, closes every till in the shop Z over the LAN and produces the Z itself.
 * pos-server `GET/POST/DELETE /shops/{id}/local-shop-z-request`.
 *
 * Pure rules: what a request's status reads as, when to poll, what may be pressed, and the
 * refusals that carry the server's Hebrew. Pure (it imports only lib/zParticipation.ts and
 * types), so `npm test` compiles it on its own.
 * The API calls are in lib/localShopZRequestApi.ts.
 */
import { isShopZ } from './zParticipation';
import type { ZVerification, ZVerificationTill } from './types';

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
  /** The shop Z's one producer now, and a handover waiting on it (lib/zParticipation.ts). */
  producer?: { kind: 'cloud' | 'local'; machine: LocalShopZTill | null; since?: string | null } | null;
  handover?: { reason: string; message?: string | null; pending?: number | null } | null;
  conflicts?: { zId: string; message?: string | null }[];
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

/**
 * A local shop Z stored as printed: the main till's printed Z IS the Z (figures, ranges,
 * number), never corrected by the cloud. From the header's `asPrinted` when the server sends
 * it, else any shop Z closed offline (which only the main till produces). Null otherwise.
 */
export function asPrintedOf(z: {
  business?: { asPrinted?: { producedBy?: LocalShopZTill | null; note?: string | null } | null } | null;
  builtOffline?: boolean | null;
  scope?: { kind?: string | null } | null;
  origin?: string | null;
  legacy?: boolean | null;
}): { note: string | null; producedBy: LocalShopZTill | null } | null {
  const stamp = z.business?.asPrinted;
  if (stamp) {
    return {
      note: typeof stamp.note === 'string' && stamp.note.trim() ? stamp.note : null,
      producedBy: stamp.producedBy ?? null,
    };
  }
  return z.builtOffline && isShopZ(z) ? { note: null, producedBy: null } : null;
}

/**
 * The Z an exception is about (`details.zReportId`, `details.zNumber`) — `offline_z_conflict`,
 * `local_shop_z_mismatch` — for a link to it; null when it names none.
 */
export function zExceptionRefOf(details: Record<string, unknown> | null | undefined): {
  zReportId: string;
  zNumber: string | null;
} | null {
  const id = details?.zReportId;
  if (typeof id !== 'string' || !id) return null;
  const n = details?.zNumber;
  return { zReportId: id, zNumber: typeof n === 'number' || (typeof n === 'string' && n) ? String(n) : null };
}

/** One line of a local shop Z's mismatch: what was printed (the Z) beside the cloud's check. */
export interface MismatchRow {
  key: string;
  /** The key without its `summary:` prefix, for a label lookup. */
  field: string;
  printed: unknown;
  cloud: unknown;
}

/**
 * `discrepancies` [{key, printed, cloud}] of a `local_shop_z_mismatch` (or of a Z's
 * verification), as rows. An older row named the printed side `till`.
 */
export function mismatchRowsOf(details: Record<string, unknown> | null | undefined): MismatchRow[] {
  const list = details?.discrepancies;
  if (!Array.isArray(list)) return [];
  return list
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof (d as { key?: unknown }).key === 'string')
    .map((d) => {
      const key = d.key as string;
      const printed = 'printed' in d ? d.printed : d.till;
      return { key, field: key.startsWith('summary:') ? key.slice('summary:'.length) : key, printed, cloud: d.cloud };
    });
}

// ── A local shop Z's verification against the cloud's documents ──────────────
//
// Stored as printed; compared only once every document it names has arrived. Until then
// a till part waits ("ממתין למסמכים מקופה N"); a dead, removed or 24 h-late till is
// "incomplete", for support to close; "mismatch" — everything arrived and the same
// computation disagrees — is a bug.

/** The full object on the detail (`offlineReport.verification`), else the list's. */
export function verificationOf(z: {
  verification?: ZVerification | null;
  offlineReport?: Record<string, unknown> | null;
}): ZVerification | null {
  const full = z.offlineReport?.verification;
  if (full && typeof full === 'object' && typeof (full as { state?: unknown }).state === 'string') {
    return full as ZVerification;
  }
  return z.verification ?? null;
}

export type VerificationTone = 'success' | 'pending' | 'warning' | 'error' | 'muted';

export function verificationToneOf(state: string | null | undefined): VerificationTone {
  switch (state) {
    case 'verified':
      return 'success';
    case 'waiting':
      return 'pending';
    case 'incomplete':
      return 'warning';
    case 'mismatch':
      return 'error';
    default:
      // closed_by_support, unverified, anything new.
      return 'muted';
  }
}

/**
 * The Z list's small badge (a message key under `independentTill.verification.listBadge`):
 * waiting, a till that did not finish syncing, or — for a super admin only — a mismatch.
 * Nothing on a verified Z (or a closed / unverified one).
 */
export function verificationListBadgeOf(
  v: Pick<ZVerification, 'state'> | null | undefined,
  isSuperAdmin: boolean,
): 'waiting' | 'incomplete' | 'mismatch' | null {
  if (!v) return null;
  if (v.state === 'waiting') return 'waiting';
  if (v.state === 'incomplete') return 'incomplete';
  if (v.state === 'mismatch') return isSuperAdmin ? 'mismatch' : null;
  return null;
}

/**
 * A till can have two parts in one local shop Z: its regular part and a "late documents"
 * part (documents from an earlier period). The late one has `late: true`, a `label`, and
 * the key "<machineId>:late".
 */
export function isLatePart(x: { key?: string | null; late?: boolean | null }): boolean {
  return x.late === true || (typeof x.key === 'string' && x.key.endsWith(':late'));
}

/** A verification row's identity: its `key`, else the till's id (and ":late" for a late part). */
export function verificationRowKey(x: { key?: string | null; machineId: string; late?: boolean | null }): string {
  if (typeof x.key === 'string' && x.key) return x.key;
  return isLatePart(x) ? `${x.machineId}:late` : x.machineId;
}

/** A per-till section's identity on the Z: the till, and ":late" for its late part. */
export function sectionKeyOf(s: { machineId: string; late?: boolean | null }): string {
  return s.late === true ? `${s.machineId}:late` : s.machineId;
}

/**
 * The shifts of one per-till section. A till with two sections (regular + late) splits
 * them by each section's `shiftIds`; otherwise every shift of the till, as before.
 */
export function sectionShiftsOf<S extends { id: string; machineId: string }>(
  section: { machineId: string; shiftIds?: string[] | null },
  sections: { machineId: string }[],
  shifts: S[],
): S[] {
  const parts = sections.filter((x) => x.machineId === section.machineId).length;
  if (parts > 1 && section.shiftIds && section.shiftIds.length > 0) {
    const ids = new Set(section.shiftIds);
    return shifts.filter((s) => ids.has(s.id));
  }
  return shifts.filter((s) => s.machineId === section.machineId);
}

/** A late part's title — its `label` — or null for a regular part (titled "קופה N"). */
export function latePartTitleOf(x: { key?: string | null; late?: boolean | null; label?: string | null }): string | null {
  if (!isLatePart(x)) return null;
  return x.label?.trim() || null;
}

/** "סגירה ע״י התמיכה": only a till part still waiting or incomplete. */
export function canSupportCloseTill(t: Pick<ZVerificationTill, 'state'>): boolean {
  return t.state === 'waiting' || t.state === 'incomplete';
}

/** A list of ids, or a count, as a count; null when there is neither. */
export function countOf(x: unknown): number | null {
  if (Array.isArray(x)) return x.length;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * The "N:missing" rows of a local shop Z's `offlineDiscrepancies`: a till (by register
 * number) that had closed shifts not on the paper, and how many.
 */
export function missingShiftRowsOf(
  list: { key: string; till?: unknown; cloud?: unknown }[] | null | undefined,
): { posNumber: string; shifts: number | null }[] {
  return (list ?? [])
    .map((d) => {
      const m = /^([^:]+):missing$/.exec(d.key);
      return m ? { posNumber: m[1], shifts: countOf(d.cloud) } : null;
    })
    .filter((x): x is { posNumber: string; shifts: number | null } => x !== null);
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
