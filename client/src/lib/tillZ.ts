/**
 * Z on the till (docs/SHIFTS_API.md §5) — the pure rules the dashboard applies.
 *
 * Kept free of React and of the `@/` alias so `npm test` can compile and run them on
 * their own.
 */

import type {
  TillZRequest,
  TillZRequestStatus,
  ZCandidateMachine,
  ZCandidates,
  ZMode,
} from './types';

/** Absent (an older server) or anything unknown is the default, `cloud`. */
export function zModeOf(x: { zMode?: string | null } | null | undefined): ZMode {
  return x?.zMode === 'till' ? 'till' : 'cloud';
}

/**
 * A shop's Z candidates, split by who produces the Z. `cloud` keeps the shape the
 * cloud-run wizard reads (only its tills); `till` are the tills that make their own.
 */
export function splitCandidatesByZMode(c: ZCandidates): {
  cloud: ZCandidates;
  till: ZCandidateMachine[];
} {
  const cloud: ZCandidateMachine[] = [];
  const till: ZCandidateMachine[] = [];
  for (const m of c.machines) (zModeOf(m) === 'till' ? till : cloud).push(m);
  return { cloud: { ...c, machines: cloud }, till };
}

/**
 * Whether a `till`-mode till can be asked for its Z: one of the shop's own active tills.
 * A till listed only for its old shifts (retired, moved) has nobody to answer.
 */
export function canAskTillForZ(m: Pick<ZCandidateMachine, 'inShop' | 'isActive'>): boolean {
  return m.inShop !== false && m.isActive !== false;
}

export const TILL_Z_PENDING: ReadonlySet<TillZRequestStatus> = new Set<TillZRequestStatus>([
  'waiting',
  'in_progress',
]);

export function isTillZPending(status: TillZRequestStatus): boolean {
  return TILL_Z_PENDING.has(status);
}

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export function tillZStatusVariant(status: TillZRequestStatus): BadgeVariant {
  if (status === 'completed') return 'default';
  if (status === 'failed' || status === 'expired') return 'destructive';
  if (status === 'cancelled') return 'outline';
  return 'secondary';
}

/**
 * What a request's end means for the operator: a Z, nothing to report, or a plain
 * status. `completed` without a Z is the till saying it had nothing to report.
 */
export function tillZOutcome(
  r: Pick<TillZRequest, 'status' | 'zReportId' | 'errorCode'>,
): 'z' | 'nothing' | 'other' {
  if (r.status !== 'completed') return 'other';
  if (r.zReportId) return 'z';
  return 'nothing';
}

/** The newest request of one till in a list (by `createdAt`, then list order). */
export function latestTillZRequestFor(
  list: readonly TillZRequest[],
  machineId: string,
): TillZRequest | null {
  let best: TillZRequest | null = null;
  let bestAt = -Infinity;
  for (const r of list) {
    if (r.machineId !== machineId) continue;
    const at = r.createdAt ? Date.parse(r.createdAt) : NaN;
    const key = Number.isFinite(at) ? at : -Infinity;
    if (!best || key > bestAt) {
      best = r;
      bestAt = key;
    }
  }
  return best;
}

/**
 * How a till names itself on a till Z: its register number when it has a plain one,
 * else its name, else a short id. Never "קופה 0" or a machine code dressed up as a number.
 */
export function tillNameForZ(x: {
  posNumber?: string | null;
  machineName?: string | null;
  machineId?: string | null;
}): string {
  const n = x.posNumber?.trim();
  if (n && /^\d+$/.test(n) && Number(n) > 0) return n;
  const name = x.machineName?.trim();
  if (name) return name;
  return x.machineId ? x.machineId.slice(0, 8) : '—';
}

/** Anything that carries a Z's number: a Z, a list row, a day-summary contributor. */
export interface ZNumberSource {
  origin?: 'cloud' | 'till' | null;
  shopSequenceNumber?: number | null;
  machineSequenceNumber?: number | null;
  posNumber?: string | null;
  machineName?: string | null;
  machineId?: string | null;
}

export type ZNumber =
  | { kind: 'till'; till: string; number: number | null }
  | { kind: 'shop'; number: number | null };

/**
 * A Z's number as it is quoted. A cloud Z is the shop's number; a till Z has no shop
 * number at all and is "קופה {till} · Z {n}" — so a till Z never reads as "#null" or as
 * a shop Z with a missing number.
 */
export function zNumberOf(z: ZNumberSource): ZNumber {
  if (z.origin === 'till') {
    return { kind: 'till', till: tillNameForZ(z), number: z.machineSequenceNumber ?? null };
  }
  return { kind: 'shop', number: z.shopSequenceNumber ?? null };
}

/** What a refused zMode switch says (§5.1), or null for any other failure. */
export type ZModeSwitchRefusal =
  | { code: 'unreported_shifts'; count: number | null }
  | { code: 'z_in_progress' }
  // The owner's rule: the till's shift closed first.
  | { code: 'till_open' };

/**
 * Reads the 409 of `PUT /machines/{id}` `{zMode}`. The count may ride beside `detail`
 * (`{"detail": "unreported_shifts", "count": 3}`) or inside it (`{code, count}`).
 */
export function zModeSwitchRefusal(err: unknown): ZModeSwitchRefusal | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data as
    | { detail?: unknown; count?: unknown }
    | undefined;
  if (!data || typeof data !== 'object') return null;
  const detail = data.detail;
  let code: string | null = null;
  let count: unknown = data.count;
  if (typeof detail === 'string') {
    code = detail.split(/[:\s—]/, 1)[0]?.trim() || null;
  } else if (detail && typeof detail === 'object') {
    const d = detail as { code?: unknown; detail?: unknown; count?: unknown };
    code = typeof d.code === 'string' ? d.code : typeof d.detail === 'string' ? d.detail : null;
    if (count == null) count = d.count;
  }
  if (code === 'unreported_shifts') {
    const n = typeof count === 'number' ? count : Number(count);
    return { code, count: count != null && Number.isFinite(n) ? n : null };
  }
  if (code === 'z_in_progress') return { code };
  if (code === 'till_open') return { code };
  return null;
}
