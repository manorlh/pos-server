/**
 * The control board (the dashboard's home, `/dashboard`): the rules behind its filters
 * and comparisons, as pure functions so they can be tested on their own.
 *
 * * which two days are compared (`?date=` and `?cmp=` / `?cmpDate=` in the URL);
 * * the change between two figures, and whether it is good news;
 * * the scope's own figures out of one day's overview (a point of sale is a shop's area);
 * * the day by the hour, the chosen day against the compared one;
 * * the tenders as one stacked bar, and the best sellers of two days side by side;
 * * which tills the alerts card speaks of.
 *
 * No React, no path aliases: `npm test` compiles this file on its own.
 */

// ── Days ─────────────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A local calendar day as `YYYY-MM-DD`. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A real calendar day in `YYYY-MM-DD`, or null (a typed URL can say anything). */
export function parseIsoDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = ISO_DAY.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return isoDay(d) === raw.trim() ? raw.trim() : null;
}

/** `day` moved by `n` calendar days (noon-anchored, so a DST night never skips one). */
export function shiftIsoDay(day: string, n: number): string {
  const m = ISO_DAY.exec(day);
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n, 12);
  return isoDay(d);
}

/** 0 = Sunday … 6 = Saturday, of a `YYYY-MM-DD`. */
export function weekdayOf(day: string): number {
  const m = ISO_DAY.exec(day);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getDay();
}

/** What the chosen day is compared with. */
export type CompareMode = 'none' | 'prevDay' | 'lastWeek' | 'custom';
export const COMPARE_MODES: CompareMode[] = ['none', 'prevDay', 'lastWeek', 'custom'];
/** With nothing in the URL: the same weekday last week — the comparison a shop reads. */
export const DEFAULT_COMPARE: CompareMode = 'lastWeek';

export interface BoardParams {
  /** The day looked at; null = today. */
  date: string | null;
  cmp: CompareMode;
  /** The day compared with, for `custom`. */
  cmpDate: string | null;
  /** The point of sale (a shop's area), only meaningful with a shop. */
  area: string | null;
}

/** The board's own URL params (the company / shop / till are the shared scope's). */
export const BOARD_PARAM = { date: 'date', cmp: 'cmp', cmpDate: 'cmpDate', area: 'area' } as const;

export function parseBoardParams(get: (key: string) => string | null): BoardParams {
  const rawCmp = get(BOARD_PARAM.cmp);
  const cmp = (COMPARE_MODES as string[]).includes(rawCmp ?? '') ? (rawCmp as CompareMode) : DEFAULT_COMPARE;
  const cmpDate = parseIsoDay(get(BOARD_PARAM.cmpDate));
  const area = (get(BOARD_PARAM.area) ?? '').trim() || null;
  return {
    date: parseIsoDay(get(BOARD_PARAM.date)),
    // A custom comparison with no day to compare with is no comparison yet.
    cmp: cmp === 'custom' && !cmpDate ? 'none' : cmp,
    cmpDate,
    area,
  };
}

/**
 * The two days on the board: A, the day looked at, and B, the day it is compared with
 * (null for none). A day never compares with itself.
 */
export function boardDays(params: BoardParams, today: string): { dayA: string; dayB: string | null } {
  const dayA = params.date && params.date <= today ? params.date : today;
  let dayB: string | null = null;
  if (params.cmp === 'prevDay') dayB = shiftIsoDay(dayA, -1);
  else if (params.cmp === 'lastWeek') dayB = shiftIsoDay(dayA, -7);
  else if (params.cmp === 'custom') dayB = params.cmpDate;
  return { dayA, dayB: dayB && dayB !== dayA ? dayB : null };
}

// ── Change ───────────────────────────────────────────────────────────────────

/** Percent change from b to a; null when b is 0 and a is not ("new"). */
export function pctChange(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return ((a - b) / Math.abs(b)) * 100;
}

export type DeltaTone = 'up' | 'down' | 'flat';

/**
 * Whether a change is good news. `invert` for the figures where less is better
 * (refunds, discounts): a rise is then bad.
 */
export function deltaTone(a: number, b: number, invert = false): { direction: DeltaTone; good: boolean | null } {
  // Cents: two money figures that print the same are the same.
  if (Math.abs(a - b) < 0.005) return { direction: 'flat', good: null };
  const up = a > b;
  return { direction: up ? 'up' : 'down', good: invert ? !up : up };
}

// ── The scope's figures ──────────────────────────────────────────────────────

export interface SalesFigures {
  salesToday: number;
  gross: number;
  discounts: number;
  refunds: number;
  documentsToday: number;
  salesCount: number;
  refundsCount: number;
  cash: number;
  card: number;
  other: number;
  tips: number;
}

export const ZERO_FIGURES: SalesFigures = {
  salesToday: 0,
  gross: 0,
  discounts: 0,
  refunds: 0,
  documentsToday: 0,
  salesCount: 0,
  refundsCount: 0,
  cash: 0,
  card: 0,
  other: 0,
  tips: 0,
};

interface OverviewLike {
  kpis: SalesFigures;
  companies: {
    shops: (SalesFigures & {
      id: string;
      machines: (SalesFigures & { id: string })[];
      areas?: (SalesFigures & { id: string; machineIds: string[] })[];
    })[];
  }[];
}

/** The server's average ticket: (gross − discounts) per sale; 0 with no sales. */
export function averageTicket(s: SalesFigures): number {
  return s.salesCount > 0 ? (s.gross - s.discounts) / s.salesCount : 0;
}

/**
 * The scope's own figures from one day's overview. The server already narrowed the
 * report to the company, shop or till, so its `kpis` are the scope's — except a point of
 * sale, which the overview carries inside its shop (`areas`), and a till, picked by id so
 * a report from before the scope changed never lends its total.
 */
export function scopeFigures(
  report: OverviewLike | undefined,
  scope: { shopId?: string | null; areaId?: string | null; machineId?: string | null },
): SalesFigures {
  if (!report) return ZERO_FIGURES;
  const shops = report.companies.flatMap((c) => c.shops);
  if (scope.machineId) {
    const m = shops.flatMap((s) => s.machines).find((x) => x.id === scope.machineId);
    return m ?? ZERO_FIGURES;
  }
  if (scope.areaId && scope.shopId) {
    const area = shops.find((s) => s.id === scope.shopId)?.areas?.find((a) => a.id === scope.areaId);
    if (area) return area;
  }
  return report.kpis;
}

// ── By the hour ──────────────────────────────────────────────────────────────

export interface HourPoint {
  hour: number;
  label: string;
  /** Null after the current hour of a day still running: no line into the future. */
  a: number | null;
  b: number | null;
  /** Running totals. */
  ca: number | null;
  cb: number | null;
}

/**
 * The chosen day (A) and the compared one (B) by the hour, every hour from the first
 * that sold on either day to the last (gaps are zero, so the line does not skip a quiet
 * hour). `nowHour`, for a day still running, ends A's line at the current hour.
 */
export function mergeHourly(
  a: { hour: number; net: number }[],
  b: { hour: number; net: number }[] | null,
  nowHour: number | null = null,
): HourPoint[] {
  const hours = [...a, ...(b ?? [])].filter((r) => r.net !== 0).map((r) => r.hour);
  if (hours.length === 0) return [];
  let from = Math.min(...hours);
  let to = Math.max(...hours);
  if (nowHour !== null) {
    from = Math.min(from, nowHour);
    to = Math.max(to, nowHour);
  }
  const net = (rows: { hour: number; net: number }[], h: number) =>
    rows.find((r) => r.hour === h)?.net ?? 0;
  const out: HourPoint[] = [];
  let ca = 0;
  let cb = 0;
  for (let h = from; h <= to; h++) {
    const future = nowHour !== null && h > nowHour;
    const va = net(a, h);
    ca += va;
    let vb: number | null = null;
    if (b) {
      vb = net(b, h);
      cb += vb;
    }
    out.push({
      hour: h,
      label: `${String(h).padStart(2, '0')}:00`,
      a: future ? null : va,
      b: vb,
      ca: future ? null : ca,
      cb: b ? cb : null,
    });
  }
  return out;
}

/** The busiest hour of A (null with no sales). */
export function peakHour(points: HourPoint[]): number | null {
  let best: HourPoint | null = null;
  for (const p of points) if ((p.a ?? 0) > 0 && (!best || (p.a ?? 0) > (best.a ?? 0))) best = p;
  return best ? best.hour : null;
}

// ── Tenders ──────────────────────────────────────────────────────────────────

export type TenderKey = 'card' | 'cash' | 'other';

export interface TenderShare {
  key: TenderKey;
  amount: number;
  /** Whole percent of the tenders' total; the shown shares add up to 100. */
  share: number;
}

/**
 * Card, cash and other (vouchers, credit…) as shares of their sum, for one stacked bar.
 * Only positive amounts take a share (a day of refunds only has nothing to stack); the
 * rounding goes to the largest share so the labels add up to 100.
 */
export function tenderShares(s: Pick<SalesFigures, 'card' | 'cash' | 'other'>): TenderShare[] {
  const rows: TenderShare[] = (['card', 'cash', 'other'] as TenderKey[]).map((key) => ({
    key,
    amount: s[key],
    share: 0,
  }));
  const total = rows.reduce((sum, r) => sum + Math.max(0, r.amount), 0);
  if (total <= 0) return rows;
  for (const r of rows) r.share = Math.round((Math.max(0, r.amount) / total) * 100);
  const drift = 100 - rows.reduce((sum, r) => sum + r.share, 0);
  if (drift !== 0) {
    const largest = rows.reduce((p, r) => (r.amount > p.amount ? r : p), rows[0]);
    largest.share += drift;
  }
  return rows;
}

// ── Best sellers ─────────────────────────────────────────────────────────────

export interface ItemRow {
  productId?: string | null;
  name?: string | null;
  qty: number;
  net: number;
}

export interface ComparedItem {
  key: string;
  name: string;
  qtyA: number;
  netA: number;
  qtyB: number;
  netB: number;
}

/**
 * The chosen day's best sellers by net, each with what it did on the compared day. An
 * item sold only on B is not a best seller of A, so it does not appear.
 */
export function compareItems(a: ItemRow[], b: ItemRow[] | null, limit: number): ComparedItem[] {
  const key = (r: ItemRow) => r.productId ?? `name:${r.name ?? ''}`;
  const onB = new Map<string, ItemRow>();
  for (const r of b ?? []) {
    const k = key(r);
    const prev = onB.get(k);
    onB.set(k, prev ? { ...prev, qty: prev.qty + r.qty, net: prev.net + r.net } : r);
  }
  return [...a]
    .filter((r) => r.net > 0 || r.qty > 0)
    .sort((x, y) => y.net - x.net || y.qty - x.qty)
    .slice(0, limit)
    .map((r) => {
      const k = key(r);
      const other = onB.get(k);
      return {
        key: k,
        name: r.name ?? '—',
        qtyA: r.qty,
        netA: r.net,
        qtyB: other?.qty ?? 0,
        netB: other?.net ?? 0,
      };
    });
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export type TillAlertKind = 'unsynced' | 'offline' | 'flags';

/**
 * Why a till is on the alerts card, the loudest reason first — or null.
 *
 * * `unsynced`: offline holding sales it has not sent (the server's
 *   `offline_with_unsynced`, its most alarming state);
 * * `offline`: unreachable with its shift open (`offline`). A till that closed its shift
 *   and was switched off reads `no_open_shift`, behaves correctly and is no alert — or
 *   every evening would raise a row of them;
 * * `flags`: reachable, with something to look at (the overview's alert count).
 */
export function tillAlertKind(till: { status?: string | null; alerts: number }): TillAlertKind | null {
  if (till.status === 'offline_with_unsynced') return 'unsynced';
  if (till.status === 'offline') return 'offline';
  if (till.alerts > 0) return 'flags';
  return null;
}

const ALERT_ORDER: Record<TillAlertKind, number> = { unsynced: 0, offline: 1, flags: 2 };

/** The tills the alerts card lists, loudest first, then by register number. */
export function alertTills<T extends { status?: string | null; alerts: number; registerNumber: number | null }>(
  tills: T[],
): { till: T; kind: TillAlertKind }[] {
  return tills
    .map((till) => ({ till, kind: tillAlertKind(till) }))
    .filter((x): x is { till: T; kind: TillAlertKind } => x.kind !== null)
    .sort(
      (x, y) =>
        ALERT_ORDER[x.kind] - ALERT_ORDER[y.kind] ||
        (x.till.registerNumber ?? 9999) - (y.till.registerNumber ?? 9999),
    );
}
