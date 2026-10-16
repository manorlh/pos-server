/**
 * "מגירה כשהעובד לא ליד המגירה" (P:/specs/drawer-away.md §5 — the only source of names; pos-android domain/DrawerAway.kt).
 * A cash payment on a device away from a drawer asks where the money goes (`ask`), opens the drawer set for the device
 * (`remote`), keeps the cash with the employee ("הכסף אצלי", `wallet`) or records only (`none`: today's behaviour, and the
 * default — a new feature never changes what a shop sees on deploy). The money kept with an employee is deposited later at a
 * till with a drawer ("הפקדת מזומן מעובד"); until then it is out of every expected drawer and on the Z by employee.
 * Pure: the parameters and the figures in, the decisions out. Money in agorot.
 */

import { MOVEMENT } from './drawer';

export type DrawerAwayPolicy = 'ask' | 'remote' | 'wallet' | 'none';
export type DrawerNear = 'auto' | 'near' | 'away';
export type WalletClockOut = 'warn' | 'block';

export const DRAWER_AWAY_KEYS = {
  POLICY: 'drawerAwayPolicy',
  NEAR: 'drawerNear',
  TARGET: 'drawerAwayTarget',
  CLOCK_OUT: 'walletBlockClockOut',
} as const;

/** The four parameters of §5.1, as the cloud merged them for this device. */
export interface DrawerAwaySettings {
  policy: DrawerAwayPolicy;
  near: DrawerNear;
  /** `drawerAwayTarget`: a drawer host's machine id, or one of this device's receipt printers; null — none set. */
  target: string | null;
  clockOut: WalletClockOut;
}

export const DEFAULT_DRAWER_AWAY: DrawerAwaySettings = { policy: 'none', near: 'auto', target: null, clockOut: 'warn' };

const norm = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim().toLowerCase();

/** An unknown or absent value reads as the default: `none` — today's behaviour (§5.1). */
export function drawerAwaySettingsOf(params: Record<string, unknown>): DrawerAwaySettings {
  const p = norm(params[DRAWER_AWAY_KEYS.POLICY]);
  const n = norm(params[DRAWER_AWAY_KEYS.NEAR]);
  const t = params[DRAWER_AWAY_KEYS.TARGET];
  const target = t === undefined || t === null ? '' : String(t).trim();
  return {
    policy: p === 'ask' || p === 'remote' || p === 'wallet' || p === 'none' ? p : 'none',
    near: n === 'near' || n === 'away' || n === 'auto' ? n : 'auto',
    target: target || null,
    clockOut: norm(params[DRAWER_AWAY_KEYS.CLOCK_OUT]) === 'block' ? 'block' : 'warn',
  };
}

/** Below this shorter side (dp) the device is a handheld or a phone. */
export const HANDHELD_MAX_SMALLEST_DP = 600;

export const isHandheld = (smallestScreenWidthDp: number): boolean => smallestScreenWidthDp >= 1 && smallestScreenWidthDp < HANDHELD_MAX_SMALLEST_DP;

/** §5.2: away when set so; with `auto`, when the device has no drawer of its own or is a handheld or a phone. */
export function isAway(near: DrawerNear, hasOwnDrawer: boolean, handheld: boolean): boolean {
  if (near === 'near') return false;
  if (near === 'away') return true;
  return !hasOwnDrawer || handheld;
}

/** A drawer a payment may open: this device's own (its receipt printer), or another till's (a drawer host, §9ג). */
export interface DrawerChoice {
  id: string;
  name: string;
  /** Another till's drawer: the host's machine id (and its printer of type cloud, when the drawer is that printer's). */
  remote?: { machineId: string; printerId: string | null; label: string } | null;
}

/** What a cash payment on an away device does (§5.3). */
export type AwayPlan =
  | { kind: 'open'; drawer: DrawerChoice }
  | { kind: 'choose'; drawers: DrawerChoice[] }
  | { kind: 'ask'; drawers: DrawerChoice[] }
  | { kind: 'wallet' }
  | { kind: 'none' };

/**
 * The drawers `target` names among `candidates` (this device's drawers first, then the drawer hosts): a receipt printer's id,
 * or a host's machine id; null target — all of them. A target that names none of them is as if none were set.
 */
export function targeted(candidates: DrawerChoice[], target: string | null): DrawerChoice[] {
  if (target === null) return candidates;
  const hit = candidates.filter((c) => c.id === target || c.remote?.machineId === target || c.remote?.printerId === target);
  return hit.length > 0 ? hit : candidates;
}

/** §5.3, the policy's table. */
export function awayPlan(settings: DrawerAwaySettings, candidates: DrawerChoice[]): AwayPlan {
  const drawers = targeted(candidates, settings.target);
  switch (settings.policy) {
    case 'none':
      return { kind: 'none' };
    case 'wallet':
      return { kind: 'wallet' };
    case 'ask':
      return { kind: 'ask', drawers };
    case 'remote':
      if (drawers.length === 0) return { kind: 'none' };
      if (drawers.length === 1) return { kind: 'open', drawer: drawers[0] };
      return { kind: 'choose', drawers };
  }
}

/** The audit's `details.drawerAway` for a cash payment kept with the employee, or recorded only (§5.3). */
export const AWAY_WALLET = 'wallet';
export const AWAY_NONE = 'none';

/** "הכסף אצלי": `cash_movements.reason` of each wallet movement, and an accrual's `source`. */
export const WALLET_REASON_IN = 'WALLET';
export const WALLET_REASON_DEPOSIT = 'WALLET_DEPOSIT';
export const walletSourceOf = (saleId: string | null | undefined): string | null => (saleId ? `sale:${saleId}` : null);
/** A deposit's variance: counted − expected (0 when they match). */
export const walletVariance = (countedAgorot: number, expectedAgorot: number): number => countedAgorot - expectedAgorot;

/** One employee's cash not deposited yet ("מזומן אצל עובדים (טרם הופקד)"). */
export interface WalletBalance {
  employeeId: string;
  employeeName: string | null;
  balanceAgorot: number;
  accruals: number;
  firstAt?: string | null;
  lastAt?: string | null;
}

/** One wallet row as the device holds it: who, which type, how much, and whether the cloud has it yet. */
export interface WalletRow {
  type: string;
  employeeId: string | null;
  employeeName: string | null;
  amountAgorot: number;
  /** A deposit's settled amount (`expectedBefore`); null — its amount. */
  settledAgorot?: number | null;
  pending?: boolean;
}

/** `GET /sync/{m}/cash-wallets` (§5.5); null when it is not that answer. */
export function parseWallets(body: unknown): WalletBalance[] | null {
  if (!body || typeof body !== 'object') return null;
  const arr = (body as { wallets?: unknown }).wallets;
  if (!Array.isArray(arr)) return null;
  const out: WalletBalance[] = [];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const id = typeof r.employeeId === 'string' ? r.employeeId.trim() : '';
    if (!id) continue;
    const bal = typeof r.balance === 'number' && Number.isFinite(r.balance) ? r.balance : Number(r.balance);
    out.push({
      employeeId: id,
      employeeName: typeof r.employeeName === 'string' && r.employeeName.trim() ? r.employeeName : null,
      balanceAgorot: Number.isFinite(bal) ? Math.round(bal * 100) : 0,
      accruals: typeof r.accruals === 'number' ? Math.trunc(r.accruals) : 0,
      firstAt: typeof r.firstAt === 'string' && r.firstAt ? r.firstAt : null,
      lastAt: typeof r.lastAt === 'string' && r.lastAt ? r.lastAt : null,
    });
  }
  return out;
}

/**
 * Each employee's balance from `rows` on their own: Σ accruals − Σ deposits' settled amounts, only the ones above zero,
 * largest first — the device's own view (an X's lines; a clock-out with no cloud).
 */
export function walletBalances(rows: readonly WalletRow[]): WalletBalance[] {
  const by = new Map<string, { name: string | null; sum: number; count: number }>();
  for (const r of rows) {
    if (!r.employeeId) continue;
    const cur = by.get(r.employeeId) ?? { name: r.employeeName, sum: 0, count: 0 };
    if (r.type === MOVEMENT.WALLET_IN) {
      cur.sum += r.amountAgorot;
      cur.count += 1;
    } else if (r.type === MOVEMENT.WALLET_DEPOSIT) cur.sum -= r.settledAgorot ?? r.amountAgorot;
    cur.name = cur.name ?? r.employeeName;
    by.set(r.employeeId, cur);
  }
  return [...by.entries()]
    .filter(([, v]) => v.sum > 0)
    .map(([id, v]) => ({ employeeId: id, employeeName: v.name, balanceAgorot: v.sum, accruals: v.count }))
    .sort((a, b) => b.balanceAgorot - a.balanceAgorot);
}

/** §5.5: the cloud's balances plus this device's accruals it does not have yet (pending rows), by employee. */
export function withPending(cloud: readonly WalletBalance[], pending: readonly WalletRow[]): WalletBalance[] {
  const extra = walletBalances(pending.filter((r) => r.pending));
  const out = new Map<string, WalletBalance>();
  for (const c of cloud) out.set(c.employeeId, c);
  for (const e of extra) {
    const c = out.get(e.employeeId);
    out.set(e.employeeId, c ? { ...c, balanceAgorot: c.balanceAgorot + e.balanceAgorot, accruals: c.accruals + e.accruals } : e);
  }
  return [...out.values()].filter((w) => w.balanceAgorot > 0).sort((a, b) => b.balanceAgorot - a.balanceAgorot);
}

/** What a clock-out with money not deposited does (§5.5). */
export type WalletClockOutCheck = { kind: 'allowed' } | { kind: 'warning'; amountAgorot: number } | { kind: 'blocked'; amountAgorot: number };

export function walletClockOutCheck(amountAgorot: number | null, mode: WalletClockOut, approved: boolean, acknowledged: boolean): WalletClockOutCheck {
  if (amountAgorot === null || amountAgorot <= 0 || approved) return { kind: 'allowed' };
  if (mode === 'block') return { kind: 'blocked', amountAgorot };
  if (acknowledged) return { kind: 'allowed' };
  return { kind: 'warning', amountAgorot };
}

/** Android's words (strings_drawer_away.xml, strings.xml wallet_deposit_*). */
export const AWAY_TEXT = {
  title: 'המזומן — איפה הכסף?',
  amount: (s: string) => `מזומן: ${s}`,
  open: (where: string) => `פתח מגירה ב${where}`,
  wallet: 'הכסף אצלי, אפקיד אחר כך',
  none: 'בלי מגירה (רישום בלבד)',
  walletDone: (s: string) => `${s} נרשמו אצלך להפקדה`,
  depositTitle: 'הפקדת מזומן מעובד',
  depositOffline: 'אין חיבור לשרת — לא ניתן לבדוק כמה צפוי',
  depositEmpty: 'אין מזומן אצל עובדים',
  depositDone: (s: string, who: string) => `הופקדו ${s} מ${who}`,
  depositDoneGap: (s: string, who: string, gap: string) => `הופקדו ${s} מ${who} · פער ${gap}`,
  walletBody: (s: string) => `יש בידך ${s} להפקדה`,
  walletBlockedBody: (s: string) => `יש בידך ${s} להפקדה. יש להפקיד בקופה עם מגירה לפני סיום המשמרת, או לקבל אישור מנהל.`,
  xWalletIn: 'הכסף אצל עובדים',
  xWalletDeposits: 'הפקדות מעובדים',
  xWalletStaff: 'מזומן אצל עובדים (טרם הופקד)',
} as const;
