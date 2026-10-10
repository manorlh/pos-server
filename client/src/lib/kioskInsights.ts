/**
 * "ביצועי קיוסקים" and "תקינות מכשירים" — the wire types of `GET /insights/kiosks`,
 * `GET /kiosks/health` and `GET /kiosks/{id}/health` (pos-server app/routers/kiosk_insights.py,
 * app/services/kiosk_insights.py, app/services/kiosk_health.py) and the pure rules the two
 * dashboard screens apply to them: the codes they word, sorting, filtering and the CSV export.
 *
 * Money is integer agorot, times are seconds, percentages are 0–100 numbers (or null when
 * there is nothing to divide by).
 *
 * Kept free of React, of the `@/` alias and of any import so `npm test` can compile and run
 * it on its own (src/lib/kioskInsights.test.ts). The requests live in lib/kioskInsightsApi.ts.
 */

/* ------------------------------------------------------------------ codes */

/** The funnel's stages, in order (kiosk_funnel.FUNNEL). */
export const FUNNEL_KEYS = ['start', 'catalog', 'item', 'added', 'cart', 'checkout', 'pay', 'paid'] as const;
export type FunnelKey = (typeof FUNNEL_KEYS)[number];

/** The kiosk's screens a session can be on (kiosk_funnel.STEPS), in the order a customer meets them. */
export const STEP_CODES = [
  'attract',
  'service',
  'catalog',
  'item',
  'cart',
  'confirm',
  'details',
  'tip',
  'pay_method',
  'pay',
  'success',
] as const;
export type StepCode = (typeof STEP_CODES)[number];

/** How a session ended. `open`: it never closed (the kiosk restarted, or it is still going). */
export const END_REASONS = ['paid', 'abandoned', 'timeout', 'cancelled', 'help', 'reset', 'open'] as const;
export type EndReason = (typeof END_REASONS)[number];

/** The reasons a session ended unpaid — the stacks of "איפה לקוחות נוטשים", in a fixed order. */
export const LEFT_REASONS = ['abandoned', 'timeout', 'cancelled', 'help', 'reset', 'open'] as const;
export type LeftReason = (typeof LEFT_REASONS)[number];

/** A payment event's result (kiosk_funnel.PAY_RESULTS). */
export const PAY_RESULTS = ['started', 'approved', 'declined', 'cancelled', 'error', 'unknown'] as const;

/** The failure reasons a kiosk commonly sends (free strings — anything else is shown as sent). */
export const PAY_REASON_CODES = [
  'declined',
  'insufficient_funds',
  'cancelled',
  'cancelled_by_customer',
  'cancelled_terminal',
  'no_answer',
  'terminal_error',
  'timeout',
  'card_lock',
  'offline',
  'error',
  'unknown',
] as const;

/** What the terminal itself said, as "עסקאות שלא הושלמו" records it. */
export const TERMINAL_OUTCOMES = [
  'declined',
  'cancelled_terminal',
  'cancelled_cashier',
  'no_answer',
  'terminal_error',
  'card_locked',
] as const;

/** When an upsell window came up. */
export const UPSELL_MOMENTS = ['item', 'steps', 'checkout'] as const;
export type UpsellMoment = (typeof UPSELL_MOMENTS)[number];

/** Payment methods a kiosk commonly reports on "started". */
export const PAY_METHODS = ['card', 'cash', 'till', 'pay_at_till', 'bit', 'apple_pay', 'google_pay', 'voucher'] as const;

/** `code` when it is one of `known`, else null — the page then shows the code as sent. */
export function knownCode<T extends string>(known: readonly T[], code: string | null | undefined): T | null {
  return code && (known as readonly string[]).includes(code) ? (code as T) : null;
}

/* ------------------------------------------------------- the report (wire) */

export interface KioskInsightsParams {
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  from?: string;
  to?: string;
  days?: number;
  /** One kiosk (its machine id). */
  kioskId?: string;
}

export interface KioskRef {
  machineId: string;
  name: string | null;
  machineName: string | null;
  shopId: string | null;
  shopName: string | null;
  /** False: a machine that was a kiosk and was turned back into a till (its history stays). */
  isKiosk: boolean;
}

export interface KioskHeadline {
  sessions: number;
  paidSessions: number;
  conversion: number | null;
  abandoned: number;
  upsellShown: number;
  upsellAccepted: number;
  upsellRate: number | null;
  payAttempts: number;
  payFailures: number;
  payFailureRate: number | null;
  basketChanged: number;
  helpRequests: number;
  medianOrderSec: number | null;
  avgOrderSec: number | null;
  orders: number;
  revenue: number;
  tips: number;
  avgBasket: number | null;
  itemsPerOrder: number | null;
}

export interface FunnelStage {
  key: FunnelKey;
  rank: number;
  sessions: number;
  pctOfStart: number | null;
  dropToNext: number | null;
  dropPct: number | null;
}

export type ReasonCounts = Partial<Record<EndReason, number>>;

export interface AbandonStep {
  step: string;
  count: number;
  pct: number | null;
  reasons: ReasonCounts;
}

export interface Abandonment {
  left: number;
  byStep: AbandonStep[];
  endReasons: ReasonCounts;
  worstStep: string | null;
}

export interface OrderTimeBucket {
  fromSec: number;
  toSec: number | null;
  count: number;
}

export interface OrderTime {
  count: number;
  medianSec: number | null;
  avgSec: number | null;
  p90Sec: number | null;
  buckets: OrderTimeBucket[];
}

export interface KioskHourRow {
  hour: number;
  orders: number;
  revenue: number;
  sessions: number;
}

export interface KioskDailyRow {
  date: string;
  sessions: number;
  paid: number;
  orders: number;
  revenue: number;
  conversion: number | null;
}

export interface KioskTopItem {
  productId: string | null;
  name: string | null;
  units: number;
  net: number;
}

export interface UpsellCounts {
  shown: number;
  accepted: number;
  declined: number;
  rate: number | null;
}

export interface UpsellRuleRow extends UpsellCounts {
  ruleId: string | null;
  name: string | null;
}

export interface UpsellMomentRow extends UpsellCounts {
  moment: string;
}

export interface KioskUpsell extends UpsellCounts {
  /** `till_stats`: the kiosks sent no funnel yet; the till's own per-rule counts. */
  source: 'events' | 'till_stats';
  byRule: UpsellRuleRow[];
  byProduct: { productId: string | null; name: string | null; accepted: number }[];
  byMoment: UpsellMomentRow[];
}

export interface KioskPayments {
  attempts: number;
  approved: number;
  failures: number;
  failureRate: number | null;
  results: Record<string, number>;
  byReason: { result: string; reason: string; count: number }[];
  byMethod: { method: string; count: number }[];
  terminalOutcomes: { outcome: string; count: number }[];
}

export interface PerKioskRow extends KioskRef {
  sessions: number;
  paidSessions: number;
  conversion: number | null;
  abandoned: number;
  orders: number;
  revenue: number;
  avgBasket: number | null;
  itemsPerOrder: number | null;
  medianOrderSec: number | null;
  upsellShown: number;
  upsellAccepted: number;
  upsellRate: number | null;
  payAttempts: number;
  payFailures: number;
  payFailureRate: number | null;
}

export interface KioskInsightsReport {
  generatedAt: string;
  timezone: string;
  dayStartHour: number;
  today: string;
  period: { from: string; to: string; days: number; prevFrom: string; prevTo: string };
  historyStart: string | null;
  kiosks: KioskRef[];
  hasKiosks: boolean;
  hasData: boolean;
  headline: { current: KioskHeadline | null; previous: KioskHeadline | null };
  funnel: FunnelStage[];
  abandonment: Abandonment;
  orderTime: OrderTime;
  byHour: KioskHourRow[];
  daily: KioskDailyRow[];
  topItems: KioskTopItem[];
  upsell: KioskUpsell;
  payments: KioskPayments;
  perKiosk: PerKioskRow[];
}

/* ------------------------------------------------------------- formatting */

/** Seconds as "1:05" (m:ss), or "1:02:05" past an hour; null → "—". */
export function durationText(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "57.1%"; null → "—". */
export function pctText(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(digits)}%`;
}

/** A "time to order" bucket in minutes: `{ from: 0, to: 1 }`, the last one open (`to: null`). */
export function bucketMinutes(b: OrderTimeBucket): { from: number; to: number | null } {
  const min = (sec: number) => Math.round((sec / 60) * 10) / 10;
  return { from: min(b.fromSec), to: b.toSec === null ? null : min(b.toSec) };
}

/** Agorot as a plain shekel number for a spreadsheet (12345 → 123.45); null stays null. */
export function shekels(agorot: number | null | undefined): number | null {
  if (agorot === null || agorot === undefined || !Number.isFinite(agorot)) return null;
  return Math.round(agorot) / 100;
}

/* ------------------------------------------------------------ the shapes */

export type AbandonRow = { step: string; count: number; pct: number | null; worst: boolean } & Record<LeftReason, number>;

/**
 * "איפה לקוחות נוטשים": one row per step with every unpaid reason (0 when absent), in the
 * steps' own order (unknown steps last), the worst step marked. A reason the kiosk sent
 * that is not known folds into `open`.
 */
export function abandonmentRows(a: Abandonment | null | undefined): AbandonRow[] {
  if (!a) return [];
  const order = (step: string) => {
    const i = (STEP_CODES as readonly string[]).indexOf(step);
    return i < 0 ? STEP_CODES.length : i;
  };
  return [...a.byStep]
    .sort((x, y) => order(x.step) - order(y.step))
    .map((s) => {
      const row = { step: s.step, count: s.count, pct: s.pct, worst: !!a.worstStep && s.step === a.worstStep } as AbandonRow;
      for (const r of LEFT_REASONS) row[r] = 0;
      for (const [reason, n] of Object.entries(s.reasons ?? {})) {
        const key = knownCode(LEFT_REASONS, reason) ?? 'open';
        row[key] += Number(n) || 0;
      }
      return row;
    });
}

export type FunnelRow = FunnelStage & { biggestDrop: boolean };

/** The funnel with the stage that loses the most (by `dropPct`) marked. */
export function funnelRows(funnel: FunnelStage[] | null | undefined): FunnelRow[] {
  const rows = funnel ?? [];
  let worst = -1;
  let worstPct = 0;
  rows.forEach((s, i) => {
    if (s.dropPct !== null && s.dropPct > worstPct) {
      worst = i;
      worstPct = s.dropPct;
    }
  });
  return rows.map((s, i) => ({ ...s, biggestDrop: i === worst }));
}

export type SortDir = 'asc' | 'desc';

/**
 * Rows sorted by one field, numbers by value and text in Hebrew order; empty values (null,
 * undefined, "") always last whichever the direction. Stable; never mutates `rows`.
 */
export function sortRows<T extends object>(rows: readonly T[], key: keyof T, dir: SortDir): T[] {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const x = a.row[key] as unknown;
      const y = b.row[key] as unknown;
      if (empty(x) || empty(y)) return empty(x) && empty(y) ? a.i - b.i : empty(x) ? 1 : -1;
      const c =
        typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'he', { numeric: true });
      return c === 0 ? a.i - b.i : dir === 'asc' ? c : -c;
    })
    .map((e) => e.row);
}

/* -------------------------------------------------------------------- CSV */

export type CsvValue = string | number | boolean | null | undefined;

/** One cell: quoted when it would break the row; a leading formula sign neutralised (as lib/csv.ts). */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The columns of the per-kiosk table, as the page shows them and the CSV exports them. */
export const PER_KIOSK_COLUMNS = [
  'name',
  'shopName',
  'sessions',
  'paidSessions',
  'conversion',
  'abandoned',
  'orders',
  'revenue',
  'avgBasket',
  'itemsPerOrder',
  'medianOrderSec',
  'upsellShown',
  'upsellAccepted',
  'upsellRate',
  'payAttempts',
  'payFailures',
  'payFailureRate',
] as const satisfies readonly (keyof PerKioskRow)[];
export type PerKioskColumn = (typeof PER_KIOSK_COLUMNS)[number];

const MONEY_COLUMNS: ReadonlySet<string> = new Set(['revenue', 'avgBasket']);

/** A per-kiosk cell as a spreadsheet wants it: money in shekels, times in seconds, the rest as sent. */
export function perKioskValue(row: PerKioskRow, col: PerKioskColumn): CsvValue {
  if (col === 'name') return row.name ?? row.machineName;
  const value = row[col];
  if (MONEY_COLUMNS.has(col)) return shekels(value as number | null);
  return value as CsvValue;
}

/**
 * The words the CSV needs, by key: `csv.<section>` titles, `csv.col.<column>` headers,
 * `funnel.<key>`, `steps.<code>`, `reasons.<code>`. The page passes its translations;
 * an unknown code may come back as the code itself.
 */
export type CsvLabel = (key: string) => string;

/**
 * "ייצוא CSV": the per-kiosk table, then the funnel, then where they leave (by step and
 * reason) — each a titled block, blocks apart by a blank line. UTF-8 with a byte-order mark
 * so Excel reads the Hebrew; CRLF rows.
 */
export function buildKioskCsv(report: Pick<KioskInsightsReport, 'period' | 'perKiosk' | 'funnel' | 'abandonment'>, label: CsvLabel): string {
  const lines: CsvValue[][] = [];
  const blank = () => lines.push([]);

  lines.push([label('csv.title'), `${report.period.from} – ${report.period.to}`]);
  blank();

  lines.push([label('csv.perKiosk')]);
  lines.push(PER_KIOSK_COLUMNS.map((c) => label(`csv.col.${c}`)));
  for (const row of report.perKiosk) lines.push(PER_KIOSK_COLUMNS.map((c) => perKioskValue(row, c)));
  blank();

  lines.push([label('csv.funnel')]);
  lines.push([label('csv.col.stage'), label('csv.col.stageSessions'), label('csv.col.pctOfStart'), label('csv.col.dropToNext'), label('csv.col.dropPct')]);
  for (const s of report.funnel) {
    lines.push([label(`funnel.${s.key}`), s.sessions, s.pctOfStart, s.dropToNext, s.dropPct]);
  }
  blank();

  lines.push([label('csv.abandonment')]);
  lines.push([label('csv.col.step'), label('csv.col.left'), label('csv.col.leftPct'), ...LEFT_REASONS.map((r) => label(`reasons.${r}`))]);
  for (const r of abandonmentRows(report.abandonment)) {
    const step = knownCode(STEP_CODES, r.step) ? label(`steps.${r.step}`) : r.step;
    lines.push([step, r.count, r.pct, ...LEFT_REASONS.map((reason) => r[reason])]);
  }

  return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** `kiosk-performance_2026-09-01_2026-09-28.csv` */
export function kioskCsvFilename(period: { from: string; to: string }): string {
  const clean = (s: string) => s.replace(/[^0-9A-Za-z-]/g, '');
  return `kiosk-performance_${clean(period.from)}_${clean(period.to)}.csv`;
}

/* ===================================================== תקינות מכשירים */

export const PART_KEYS = ['app', 'terminal', 'printer', 'tillLink', 'kds', 'media', 'uploads', 'battery', 'bridge'] as const;
export type HealthPartKey = (typeof PART_KEYS)[number];

export const PART_LEVELS = ['ok', 'info', 'warn', 'error', 'off', 'unknown'] as const;
export type HealthLevel = (typeof PART_LEVELS)[number];

/** A kiosk's overall state, worst first as the page sorts them. */
export const OVERALL_STATES = ['error', 'offline', 'warn', 'ok', 'off'] as const;
export type HealthOverall = (typeof OVERALL_STATES)[number];

/** Each part's codes (kiosk_health.*_part); anything else is shown as sent. */
export const PART_CODES: Record<HealthPartKey, readonly string[]> = {
  app: ['disabled', 'offline', 'paused', 'till_mode', 'closed', 'setup', 'no_payment', 'config_pending', 'running'],
  terminal: ['card_lock', 'card_unknown', 'ready', 'busy', 'unreachable', 'not_ready', 'not_configured', 'none', 'not_reported'],
  printer: ['no_paper', 'offline', 'unavailable', 'error', 'usb_detached', 'usb_permission', 'usb_several', 'overheated', 'unprinted', 'ok', 'none', 'not_reported'],
  tillLink: ['not_reported', 'none', 'down', 'lan', 'cloud', 'ok'],
  kds: ['bon', 'no_screens', 'screens_offline', 'down', 'ok'],
  media: ['not_reported', 'missing', 'ready', 'loading'],
  uploads: ['not_reported', 'none', 'stuck', 'pending'],
  // "סוללה חלשה" (pos-server app/services/battery_alerts.py): the open alert first, then the reading.
  battery: ['critical', 'low', 'charging', 'discharging', 'none'],
  // "גשר Windows" of a browser kiosk (docs/SPEC_KIOSK.md §28; kiosk_health.bridge_part) — only when it has one.
  bridge: ['ok', 'down', 'not_paired', 'not_linked'],
};

/** The screens and flow states a kiosk reports as where it is now. */
export const SCREEN_CODES = [
  ...STEP_CODES,
  'ordering',
  'paying',
  'paused',
  'closed',
  'admin',
  'setup',
  'no_payment',
  'till_mode',
] as const;

export interface HealthPart {
  key: HealthPartKey;
  level: HealthLevel;
  code: string;
  detail: Record<string, unknown>;
}

export interface HealthAlert {
  kind: string;
  key: string;
  reason: string;
  text: string;
  raisedAt: string | null;
  acknowledgedBy: string | null;
  /** Raised by the cloud itself (offline for N minutes, "KDS לא מחובר"); gone when it clears. */
  cloud?: boolean;
}

export interface HealthUnprintedOrder {
  localId: string;
  label: string | null;
  paidAt: string | null;
  detail: string | null;
}

export interface HealthKdsScreen {
  id: string;
  name: string;
  role: string;
  active: boolean;
  lastSeenAt: string | null;
  online: boolean;
}

/** A device's battery as last reported; `stale`: older than 10 minutes ("as of"). */
export interface HealthBattery {
  percent: number | null;
  status: string | null;
  charging: boolean;
  reportedAt: string | null;
  stale: boolean;
}

export interface KioskHealthRow {
  machineId: string;
  name: string;
  machineName: string | null;
  posNumber: string | null;
  shopId: string | null;
  shopName: string | null;
  enabled: boolean;
  platform: 'android' | 'windows' | null;
  appVersion: string | null;
  online: boolean;
  lastContactAt: string | null;
  lastHeartbeatAt: string | null;
  network: { online?: boolean; since?: string; route?: string } | null;
  screen: string | null;
  flowState: string | null;
  paused: boolean | null;
  pauseMessage: string | null;
  pausedUntil: string | null;
  shiftOpen: boolean | null;
  fulfillmentMode: 'BON' | 'KDS' | null;
  configUpToDate: boolean | null;
  overall: HealthOverall;
  parts: HealthPart[];
  alerts: HealthAlert[];
  unprintedOrders: HealthUnprintedOrder[];
  kdsScreens: HealthKdsScreen[];
  ordersToday: number | null;
  salesTodayAgorot: number | null;
  lastOrderAt: string | null;
  battery?: HealthBattery | null;
}

/** Any other active device of the scope (tills, handhelds, tablets) — for its battery. */
export interface HealthDevice {
  machineId: string;
  name: string;
  posNumber: string | null;
  shopId: string | null;
  shopName: string | null;
  /** How the tills name it: "המסופון" / "הטאבלט" / "הקופה" / "הקיוסק". */
  device: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  online: boolean;
  lastHeartbeatAt: string | null;
  battery: HealthBattery | null;
  batteryPart: HealthPart;
  overall: 'ok' | 'warn' | 'error' | 'offline';
}

/** One low-battery alert, open or cleared (newest first). */
export interface BatteryEvent {
  id: string;
  machineId: string;
  /** The threshold that fired (15 / 10 / 5 by default). */
  level: number;
  percent: number | null;
  lastPercent: number | null;
  severity: 'warning' | 'critical';
  raisedAt: string | null;
  clearedAt: string | null;
  clearReason: 'charging' | 'recovered' | 'escalated' | null;
  acknowledgedBy: string | null;
}

export interface KiosksHealth {
  generatedAt: string;
  counts: Record<HealthOverall, number>;
  shops: { shopId: string; kdsScreens: HealthKdsScreen[] }[];
  kiosks: KioskHealthRow[];
  devices?: HealthDevice[];
  batteryHistory?: BatteryEvent[];
}

export interface KioskHealthEvent {
  at: string | null;
  type: 'alert_raised' | 'alert_cleared' | 'command' | 'offline';
  kind?: string | null;
  reason?: string | null;
  text?: string | null;
  by?: string | null;
  action?: string | null;
  status?: string | null;
  backAt?: string | null;
  minutes?: number | null;
}

export interface KioskHealthSession {
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  lastStep: string | null;
  paid: boolean;
  orderSec: number | null;
  basketAgorot: number | null;
  items: number | null;
  payFailures: number;
  help: boolean;
}

export interface KioskHealthTerminalIdentity {
  expected: string | null;
  expectedSource: string | null;
  reportedNumber: string | null;
  reportedMerchant: string | null;
  reportedAt: string | null;
  cardLock: string | null;
  /** "עקיפת בדיקת מספר מסוף" on for the kiosk (docs/SPEC_KIOSK.md §20.1); absent: an older server. */
  numberCheckBypass?: boolean;
  numberCheckBypassSource?: string | null;
  numberCheckBypassReported?: boolean | null;
}

export interface KioskHealthDetail {
  generatedAt: string;
  kiosk: KioskHealthRow;
  events: KioskHealthEvent[];
  sessions: KioskHealthSession[];
  terminalIdentity: KioskHealthTerminalIdentity | null;
  /** The kiosk's own last `status.health` report, as stored. */
  health: Record<string, unknown> | null;
  batteryHistory?: BatteryEvent[];
}

/** The part of a row by key, or null when the server sent none. */
export function partOf(row: Pick<KioskHealthRow, 'parts'>, key: HealthPartKey): HealthPart | null {
  return row.parts.find((p) => p.key === key) ?? null;
}

/** The parts in the page's fixed order (missing ones left out). */
export function orderedParts(row: Pick<KioskHealthRow, 'parts'>): HealthPart[] {
  return PART_KEYS.map((k) => partOf(row, k)).filter((p): p is HealthPart => p !== null);
}

/** A part's code when known for its key, else null (shown as sent). */
export function partCode(part: Pick<HealthPart, 'key' | 'code'>): string | null {
  return (PART_CODES[part.key] ?? []).includes(part.code) ? part.code : null;
}

/** The card lock as the wording keys it: `terminal_mismatch` / `mismatch` → `mismatch`. */
export function cardLockKey(lock: unknown): 'mismatch' | 'not_configured' | 'unknown' | null {
  if (typeof lock !== 'string' || !lock) return null;
  const bare = lock.startsWith('terminal_') ? lock.slice('terminal_'.length) : lock;
  return bare === 'mismatch' || bare === 'not_configured' || bare === 'unknown' ? bare : null;
}

/** The colour family a level is drawn in. */
export type HealthTone = 'ok' | 'info' | 'warn' | 'error' | 'muted';

export function levelTone(level: HealthLevel | string): HealthTone {
  if (level === 'ok') return 'ok';
  if (level === 'info') return 'info';
  if (level === 'warn') return 'warn';
  if (level === 'error') return 'error';
  return 'muted';
}

export function overallTone(overall: HealthOverall | string): HealthTone {
  if (overall === 'ok') return 'ok';
  if (overall === 'warn') return 'warn';
  if (overall === 'error' || overall === 'offline') return 'error';
  return 'muted';
}

export interface HealthFilter {
  /** '' = every state. */
  overall: HealthOverall | '';
  /** '' = every shop. */
  shopId: string;
  search: string;
}

/** Folded for a search: case, niqqud, geresh and extra spaces dropped. */
export function foldSearch(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFKD')
    .replace(/[֑-ׇ]/g, '')
    .replace(/["'`׳״]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The rows the filters keep: state, shop, and a search over the kiosk's, till's and shop's names and number. */
export function filterHealth(rows: readonly KioskHealthRow[], f: HealthFilter): KioskHealthRow[] {
  const q = foldSearch(f.search);
  return rows.filter((r) => {
    if (f.overall && r.overall !== f.overall) return false;
    if (f.shopId && r.shopId !== f.shopId) return false;
    if (!q) return true;
    return [r.name, r.machineName, r.shopName, r.posNumber].some((s) => foldSearch(s).includes(q));
  });
}

/** Worst state first, then by shop and name. Never mutates `rows`. */
export function sortHealth(rows: readonly KioskHealthRow[]): KioskHealthRow[] {
  const rank = (o: string) => {
    const i = (OVERALL_STATES as readonly string[]).indexOf(o);
    return i < 0 ? OVERALL_STATES.length : i;
  };
  return [...rows].sort(
    (a, b) =>
      rank(a.overall) - rank(b.overall) ||
      (a.shopName ?? '').localeCompare(b.shopName ?? '', 'he') ||
      (a.name ?? '').localeCompare(b.name ?? '', 'he'),
  );
}

/** The shops the rows (kiosks and other devices) sit in, by name, for the shop filter. */
export function healthShops(rows: readonly { shopId: string | null; shopName: string | null }[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) if (r.shopId && !seen.has(r.shopId)) seen.set(r.shopId, r.shopName ?? r.shopId);
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'he'));
}

/**
 * The other devices the filters keep: state (a device is never "off"), shop, and a search over
 * its name, number, shop and kind.
 */
export function filterDevices(rows: readonly HealthDevice[], f: HealthFilter): HealthDevice[] {
  const q = foldSearch(f.search);
  return rows.filter((d) => {
    if (f.overall && d.overall !== f.overall) return false;
    if (f.shopId && d.shopId !== f.shopId) return false;
    if (!q) return true;
    return [d.name, d.posNumber, d.shopName, d.device, d.deviceModel].some((s) => foldSearch(s).includes(q));
  });
}

/** Devices worst first (a low battery before a good one), then by shop and name. */
export function sortDevices(rows: readonly HealthDevice[]): HealthDevice[] {
  const rank = (o: string) => {
    const i = (OVERALL_STATES as readonly string[]).indexOf(o);
    return i < 0 ? OVERALL_STATES.length : i;
  };
  return [...rows].sort(
    (a, b) =>
      rank(a.overall) - rank(b.overall) ||
      (a.shopName ?? '').localeCompare(b.shopName ?? '', 'he') ||
      (a.name ?? '').localeCompare(b.name ?? '', 'he'),
  );
}

/** The chips' counts over kiosks and the other devices together. */
export function combinedCounts(kiosks: Record<HealthOverall, number>, devices: readonly Pick<HealthDevice, 'overall'>[]): Record<HealthOverall, number> {
  const out = { ...kiosks };
  for (const d of devices) if (d.overall in out) out[d.overall] += 1;
  return out;
}

/** "המסופון" → "מסופון": the server's device word as a label. Unknown words stay as sent. */
export function deviceKind(label: string | null | undefined): string | null {
  if (!label) return null;
  const bare: Record<string, string> = { המסופון: 'מסופון', הטאבלט: 'טאבלט', הקופה: 'קופה', הקיוסק: 'קיוסק' };
  return bare[label] ?? label;
}

export type BatteryEventRow = BatteryEvent & { name: string; shopId: string | null; shopName: string | null; kind: string | null };

/**
 * The low-battery history with each device named from the kiosks and devices of the same
 * response (a device that left the scope keeps a short id), filtered by shop and search.
 */
export function batteryHistoryRows(
  history: readonly BatteryEvent[] | null | undefined,
  kiosks: readonly Pick<KioskHealthRow, 'machineId' | 'name' | 'shopId' | 'shopName'>[],
  devices: readonly Pick<HealthDevice, 'machineId' | 'name' | 'shopId' | 'shopName' | 'device'>[],
  f: Pick<HealthFilter, 'shopId' | 'search'> = { shopId: '', search: '' },
): BatteryEventRow[] {
  const byId = new Map<string, { name: string; shopId: string | null; shopName: string | null; kind: string | null }>();
  for (const k of kiosks) byId.set(k.machineId, { name: k.name, shopId: k.shopId, shopName: k.shopName, kind: 'קיוסק' });
  for (const d of devices) byId.set(d.machineId, { name: d.name, shopId: d.shopId, shopName: d.shopName, kind: deviceKind(d.device) });
  const q = foldSearch(f.search);
  return (history ?? [])
    .map((e) => {
      const who = byId.get(e.machineId);
      return { ...e, name: who?.name ?? e.machineId.slice(0, 8), shopId: who?.shopId ?? null, shopName: who?.shopName ?? null, kind: who?.kind ?? null };
    })
    .filter((r) => (!f.shopId || r.shopId === f.shopId) && (!q || [r.name, r.shopName, r.kind].some((s) => foldSearch(s).includes(q))));
}

/** The counts by overall state; the server's when sent, else counted from the rows. */
export function healthCounts(data: Pick<KiosksHealth, 'kiosks'> & { counts?: Partial<Record<HealthOverall, number>> }): Record<HealthOverall, number> {
  const out = { error: 0, offline: 0, warn: 0, ok: 0, off: 0 } as Record<HealthOverall, number>;
  if (data.counts) {
    for (const k of OVERALL_STATES) out[k] = Number(data.counts[k]) || 0;
    return out;
  }
  for (const r of data.kiosks) if (r.overall in out) out[r.overall] += 1;
  return out;
}
