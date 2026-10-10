/**
 * The kiosk's own Z — a till Z (`zMode = till`), strictly sequential and never renumbered
 * (pos-server docs/SPEC_OFFLINE_TILL_Z.md §4, SPEC_INDEPENDENT_TILL.md; pos-android
 * domain/OfflineTillZ.kt, data/repo/TillZRepository.kt, data/repo/KioskRepository.kt):
 *
 *  - a Z number, once produced and printed, is final: the cloud allocates the next one exactly
 *    (online) and the kiosk keeps every Z with the number it got;
 *  - the last number known FOR SURE is the higher of this machine's own stored Zs (only rows that
 *    say they are this machine's, in the current epoch, not superseded) and the cloud's
 *    `lastTillZNumber` from the heartbeat — nothing else; none → no offline Z;
 *  - an offline Z is only ever the next one (known + 1), reserved on disk before it is built; a
 *    reservation is taken again only while it is still exactly the next;
 *  - offline Zs go up oldest first and stop at the first that does not go; a conflict keeps the
 *    Z as printed and holds the ones after it — nothing is ever renumbered;
 *  - the automatic close runs at the kiosk's time (operations.autoCloseAt, else the till
 *    parameter autoCloseShiftAt), only when the kiosk is idle and no card is on the terminal;
 *    then, in zMode = till, the Z is asked with one client request id until it is produced
 *    ("owed" survives a restart).
 */

export type ZMode = 'till' | 'cloud';

export function zModeOf(raw: unknown): ZMode {
  return raw === 'till' ? 'till' : 'cloud';
}

/** A Z the kiosk holds (the shape of the cloud's POST till-z answer, plus the local state). */
export interface StoredTillZ {
  id: string;
  machineId: string | null;
  number: number;
  epoch: number;
  closedAt: string;
  businessDate: string | null;
  state: 'printed' | 'pending' | 'synced' | 'conflict' | 'superseded';
}

/** The last Z number known for sure, or null when nothing is known (SPEC §4.1). */
export function lastKnownTillZ(local: readonly StoredTillZ[], machineId: string, epoch: number, cloudLast: number | null): number | null {
  let best: number | null = null;
  for (const z of local) {
    if (z.machineId !== machineId || z.epoch !== epoch || z.state === 'superseded') continue;
    if (best === null || z.number > best) best = z.number;
  }
  if (cloudLast !== null && cloudLast !== undefined && Number.isFinite(cloudLast)) best = best === null ? cloudLast : Math.max(best, cloudLast);
  return best;
}

export function nextOfflineZNumber(known: number | null): number | null {
  return known === null ? null : known + 1;
}

export interface ZReservation {
  machineId: string;
  number: number;
  zId: string;
  clientRequestId: string;
}

/** A reservation from before a crash is used again only while it is still exactly the next. */
export function reservationStillValid(prior: ZReservation | null, machineId: string, known: number | null): boolean {
  return !!prior && prior.machineId === machineId && known !== null && prior.number === known + 1;
}

export type OfflineZState = 'pending' | 'synced' | 'conflict' | 'superseded';

export type UploadAnswer =
  | { kind: 'created' }
  | { kind: 'duplicate' }
  | { kind: 'no_answer' }
  | { kind: 'http'; status: number; detail: string | null };

/** The waiting answers (the cloud has not caught up yet): try again later. */
const WAIT_DETAILS = new Set(['shift_not_closed', 'shift_unknown']);

/** offlineZNext: the upload state machine (SPEC §5.4). */
export function offlineZNext(state: OfflineZState, answer: UploadAnswer | { kind: 'retry_by_person' }): OfflineZState {
  if (state === 'synced' || state === 'superseded') return state;
  if (answer.kind === 'retry_by_person') return state === 'conflict' ? 'pending' : state;
  if (state === 'conflict') return state;
  switch (answer.kind) {
    case 'created':
    case 'duplicate':
      return 'synced';
    case 'no_answer':
      return 'pending';
    case 'http':
      if (answer.status >= 500 || answer.status === 408 || answer.status === 429) return 'pending';
      if (answer.status === 409 && answer.detail && WAIT_DETAILS.has(answer.detail)) return 'pending';
      if (answer.status >= 200 && answer.status < 300) return 'synced';
      return 'conflict';
  }
}

/** Numbers missing between the lowest and the highest Z held ("חסרים דוחות Z ברצף"). */
export function zSequenceHoles(numbers: readonly number[]): number[] {
  if (numbers.length < 2) return [];
  const set = new Set(numbers);
  const lo = Math.min(...numbers);
  const hi = Math.max(...numbers);
  const out: number[] = [];
  for (let n = lo + 1; n < hi; n++) if (!set.has(n)) out.push(n);
  return out;
}

/** What stays: 31 days, everything not in the cloud yet, and always the newest. */
export function tillZsToKeep(zs: readonly StoredTillZ[], nowMs: number, days = 31): StoredTillZ[] {
  if (zs.length === 0) return [];
  const newest = zs.reduce((a, b) => (b.number > a.number ? b : a));
  const cutoff = nowMs - days * 86_400_000;
  return zs.filter((z) => z === newest || z.state === 'pending' || z.state === 'conflict' || Date.parse(z.closedAt) >= cutoff);
}

/** offlineTillZAllowed (SPEC §2): per-till Z, the parameter on, no cloud, paired. */
export function offlineTillZAllowed(paramOn: boolean, zMode: ZMode, cloudUnreachable: boolean, paired: boolean): boolean {
  return paramOn && zMode === 'till' && cloudUnreachable && paired;
}

/* ------------------------------------------------------- the online Z */

export type TillZRefusal =
  | 'nothing_to_report'
  | 'empty_z'
  | 'shift_not_closed'
  | 'z_run_in_progress'
  | 'till_z_disabled'
  | 'shift_unknown'
  | 'shift_belongs_to_another_machine';

/**
 * The cloud's refusals that mean "no Z will come of this request" (TillZRefusal). `empty_z` (a
 * day without a sale — "אין Z על 0") is one too: the Android kiosk lacks it and would ask again
 * every 30 s forever; here it clears the owed Z like nothing_to_report.
 */
export function tillZRefusalOf(status: number, detail: string | null): TillZRefusal | null {
  if (status !== 409 && status !== 403) return null;
  if (!detail) return null;
  if (detail.startsWith('z_run_in_progress')) return 'z_run_in_progress';
  const known: TillZRefusal[] = ['nothing_to_report', 'empty_z', 'shift_not_closed', 'till_z_disabled', 'shift_unknown'];
  if (status === 409 && (known as string[]).includes(detail)) return detail as TillZRefusal;
  if (status === 403 && detail === 'shift_belongs_to_another_machine') return 'shift_belongs_to_another_machine';
  return null;
}

/** A refusal that ends the owed Z (nothing to number) vs. one to wait out and ask again. */
export function refusalClearsOwed(r: TillZRefusal): boolean {
  return r !== 'shift_not_closed' && r !== 'z_run_in_progress' && r !== 'shift_unknown';
}

/* --------------------------------------------------- the automatic close */

/** "HH:MM" or "H:MM" → minutes of the day, else null. */
export function hhmm(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** The close time: the kiosk's operations.autoCloseAt, else the till parameter autoCloseShiftAt. */
export function autoCloseTimeOf(kioskAt: unknown, paramAt: unknown): string | null {
  if (hhmm(kioskAt) !== null) return String(kioskAt).trim();
  if (hhmm(paramAt) !== null) return String(paramAt).trim();
  return null;
}

/** Today's moment `at` (local time) for `now`. */
export function todayAt(nowMs: number, at: string): number {
  const mins = hhmm(at);
  if (mins === null) return Number.NaN;
  const d = new Date(nowMs);
  d.setHours(Math.trunc(mins / 60), mins % 60, 0, 0);
  return d.getTime();
}

/**
 * closeIfDue: past today's moment, and the open shift began before it (a shift opened after the
 * moment waits for tomorrow's).
 */
export function autoCloseDue(nowMs: number, at: string, shiftOpenedAtMs: number | null): boolean {
  if (shiftOpenedAtMs === null) return false;
  const moment = todayAt(nowMs, at);
  return Number.isFinite(moment) && nowMs >= moment && shiftOpenedAtMs < moment;
}

/** KioskAutoClose.mayRun: idle (no customer on it), nothing held, no card on the terminal. */
export function autoCloseMayRun(input: { kiosk: boolean; flowIdle: boolean; flowBusy: boolean; cardInFlight: boolean }): boolean {
  return input.kiosk && input.flowIdle && !input.flowBusy && !input.cardInFlight;
}

/** asksTillZ: after the close, a till Z is produced only in zMode = till. */
export function asksTillZ(zMode: ZMode): boolean {
  return zMode === 'till';
}

/** The `till` totals of the shifts a Z covers (tillZTotalsOf), summed from their closes' `till`. */
export interface TillTotals {
  totalSales: number;
  totalDiscounts?: number;
  totalRefunds: number;
  totalCash: number;
  totalCard: number;
  totalExchange?: number;
  totalTips: number;
  vatTotal?: number;
  transactionsCount: number;
}

export function sumTillTotals(closes: ReadonlyArray<Record<string, unknown> | null>): TillTotals | null {
  if (closes.length === 0 || closes.some((c) => !c)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  let vatComplete = true;
  const out: TillTotals = { totalSales: 0, totalDiscounts: 0, totalRefunds: 0, totalCash: 0, totalCard: 0, totalTips: 0, vatTotal: 0, transactionsCount: 0 };
  for (const c of closes as Record<string, unknown>[]) {
    out.totalSales += num(c.totalSales);
    out.totalDiscounts! += num(c.totalDiscounts);
    out.totalRefunds += num(c.totalRefunds);
    out.totalCash += num(c.totalCash);
    out.totalCard += num(c.totalCard);
    out.totalTips += num(c.totalTips);
    if (typeof c.vatTotal === 'number') out.vatTotal! += c.vatTotal;
    else vatComplete = false;
    out.transactionsCount += Math.trunc(num(c.transactionsCount));
  }
  for (const k of ['totalSales', 'totalDiscounts', 'totalRefunds', 'totalCash', 'totalCard', 'totalTips', 'vatTotal'] as const) {
    if (out[k] !== undefined) out[k] = r2(out[k] as number);
  }
  if (!vatComplete) delete out.vatTotal;
  return out;
}
