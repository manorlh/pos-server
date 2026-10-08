/**
 * The home page's comparisons (השוואות, `/dashboard?view=compare`): the rules behind its
 * filters, its numbers and its exports, as pure functions so they can be tested on their own.
 *
 * * the URL: every filter lives in the query (`view`, `period`, `date`, `from`/`to`, `vs`,
 *   `vsFrom`/`vsTo`, `event`/`vsEvent`, `mode`, `side`, `ids`) next to the shared scope's
 *   `company`/`shop`/`machine` and the board's `area`, so a refresh or a shared link opens
 *   the same comparison; a default is left out of the URL;
 * * the periods: a day, a week (Sunday–Saturday), a month or any range — and what it is
 *   compared with: the previous period (like for like: a week still running against the
 *   same days of the week before), the same weekday last week, the same period last year,
 *   any range, or an event;
 * * each figure's change as a number and a percent ("new" from zero, never a division by
 *   zero), the curves as chart points with running totals;
 * * the comparison and side-by-side exports, as `ExcelSheet`s.
 *
 * No React, no path aliases: `npm test` compiles this file on its own.
 */

import {
  pctChange,
  parseIsoDay,
  shiftIsoDay,
  tenderShares,
  weekdayOf,
  type HourPoint,
  type SalesFigures,
  type TenderShare,
} from './controlBoard';
import type { ExcelSheet, ExcelValue } from './excelExport';

// ── The URL ──────────────────────────────────────────────────────────────────

export type HomeView = 'board' | 'compare';
export type PeriodKind = 'day' | 'week' | 'month' | 'range';
export const PERIOD_KINDS: PeriodKind[] = ['day', 'week', 'month', 'range'];
/** What period A is compared with. */
export type VsKind = 'prev' | 'lastWeek' | 'lastYear' | 'custom' | 'event' | 'none';
export const VS_KINDS: VsKind[] = ['prev', 'lastWeek', 'lastYear', 'custom', 'event', 'none'];
export type CompareViewMode = 'periods' | 'side';
export type SideKind = 'shop' | 'area' | 'machine' | 'cashier';
export const SIDE_KINDS: SideKind[] = ['shop', 'area', 'machine', 'cashier'];
/** Side by side is for a glance: two to four columns (the server refuses more). */
export const SIDE_MIN = 2;
export const SIDE_MAX = 4;
/** The reports' widest window (server `MAX_REPORT_DAYS`). */
export const MAX_RANGE_DAYS = 366;

export const COMPARE_PARAM = {
  view: 'view',
  period: 'period',
  date: 'date',
  from: 'from',
  to: 'to',
  vs: 'vs',
  vsFrom: 'vsFrom',
  vsTo: 'vsTo',
  event: 'event',
  vsEvent: 'vsEvent',
  mode: 'mode',
  side: 'side',
  ids: 'ids',
} as const;

export interface CompareParams {
  view: HomeView;
  period: PeriodKind;
  /** The day the period is anchored on (its week, its month); null = today. */
  date: string | null;
  /** A range's own days (`period=range`). */
  from: string | null;
  to: string | null;
  vs: VsKind;
  vsFrom: string | null;
  vsTo: string | null;
  /** Period A is this event ("אירוע") instead of days. */
  event: string | null;
  /** Compared with this event (`vs=event`). */
  vsEvent: string | null;
  mode: CompareViewMode;
  side: SideKind;
  ids: string[];
}

/** With nothing in the URL: a day against the same weekday last week; longer periods against the one before. */
export function defaultVs(period: PeriodKind): VsKind {
  return period === 'day' ? 'lastWeek' : 'prev';
}

const ID_SHAPE = /^[A-Za-z0-9:_.-]{1,100}$/;

function cleanId(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  return value && ID_SHAPE.test(value) ? value : null;
}

export function parseCompareParams(get: (key: string) => string | null): CompareParams {
  const pick = <T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
  const period = pick(get(COMPARE_PARAM.period), PERIOD_KINDS, 'day');
  const event = cleanId(get(COMPARE_PARAM.event));
  const vsEvent = cleanId(get(COMPARE_PARAM.vsEvent));
  let vs = pick(get(COMPARE_PARAM.vs), VS_KINDS, defaultVs(period));
  const vsFrom = parseIsoDay(get(COMPARE_PARAM.vsFrom));
  const vsTo = parseIsoDay(get(COMPARE_PARAM.vsTo));
  // A comparison that names nothing to compare with is none yet.
  if (vs === 'custom' && !(vsFrom || vsTo)) vs = 'none';
  if (vs === 'event' && !vsEvent) vs = 'none';
  // An event is compared with another event or with nothing.
  if (event && vs !== 'event' && vs !== 'custom') vs = 'none';
  const ids: string[] = [];
  for (const part of (get(COMPARE_PARAM.ids) ?? '').split(',')) {
    const id = cleanId(part);
    if (id && !ids.includes(id) && ids.length < SIDE_MAX) ids.push(id);
  }
  return {
    view: get(COMPARE_PARAM.view) === 'compare' ? 'compare' : 'board',
    period,
    date: parseIsoDay(get(COMPARE_PARAM.date)),
    from: parseIsoDay(get(COMPARE_PARAM.from)),
    to: parseIsoDay(get(COMPARE_PARAM.to)),
    vs,
    vsFrom,
    vsTo,
    event,
    vsEvent: vs === 'event' ? vsEvent : null,
    mode: get(COMPARE_PARAM.mode) === 'side' ? 'side' : 'periods',
    side: pick(get(COMPARE_PARAM.side), SIDE_KINDS, 'shop'),
    ids,
  };
}

/**
 * The URL params for `next` — a default is null (left out), so the URL says only what was
 * chosen. Keys not in `next` are not touched (the caller merges it into the current query).
 */
export function compareQuery(next: Partial<CompareParams>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const period = next.period ?? 'day';
  if ('view' in next) out[COMPARE_PARAM.view] = next.view === 'compare' ? 'compare' : null;
  if ('period' in next) out[COMPARE_PARAM.period] = period === 'day' ? null : period;
  if ('date' in next) out[COMPARE_PARAM.date] = next.date ?? null;
  if ('from' in next) out[COMPARE_PARAM.from] = next.from ?? null;
  if ('to' in next) out[COMPARE_PARAM.to] = next.to ?? null;
  if ('vs' in next) out[COMPARE_PARAM.vs] = !next.vs || next.vs === defaultVs(period) ? null : next.vs;
  if ('vsFrom' in next) out[COMPARE_PARAM.vsFrom] = next.vsFrom ?? null;
  if ('vsTo' in next) out[COMPARE_PARAM.vsTo] = next.vsTo ?? null;
  if ('event' in next) out[COMPARE_PARAM.event] = next.event ?? null;
  if ('vsEvent' in next) out[COMPARE_PARAM.vsEvent] = next.vsEvent ?? null;
  if ('mode' in next) out[COMPARE_PARAM.mode] = next.mode === 'side' ? 'side' : null;
  if ('side' in next) out[COMPARE_PARAM.side] = !next.side || next.side === 'shop' ? null : next.side;
  if ('ids' in next) out[COMPARE_PARAM.ids] = next.ids && next.ids.length ? next.ids.join(',') : null;
  return out;
}

// ── Days ─────────────────────────────────────────────────────────────────────

export interface DayRange {
  from: string;
  to: string;
}

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y, m, d];
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days in month `m` (1–12) of year `y`. */
export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0, 12).getDate();
}

/** Inclusive number of days from `r.from` to `r.to`. */
export function rangeDays(r: DayRange): number {
  const [y1, m1, d1] = parts(r.from);
  const [y2, m2, d2] = parts(r.to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

/** The Sunday that starts `day`'s week (the Israeli week). */
export function weekStart(day: string): string {
  return shiftIsoDay(day, -weekdayOf(day));
}

export function monthStart(day: string): string {
  const [y, m] = parts(day);
  return fmt(y, m, 1);
}

export function monthEnd(day: string): string {
  const [y, m] = parts(day);
  return fmt(y, m, daysInMonth(y, m));
}

/** The same date `n` years later (29 Feb → 28 Feb). */
export function addYears(day: string, n: number): string {
  const [y, m, d] = parts(day);
  return fmt(y + n, m, Math.min(d, daysInMonth(y + n, m)));
}

/** The same day of the month `n` months later, held to that month's last day. */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const index = y * 12 + (m - 1) + n;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

const minDay = (a: string, b: string) => (a < b ? a : b);

/** Period A's days: the anchor's day, week or month (never past today), or the range asked for. */
export function periodRange(p: Pick<CompareParams, 'period' | 'date' | 'from' | 'to'>, today: string): DayRange {
  const anchor = p.date && p.date <= today ? p.date : today;
  if (p.period === 'week') {
    const from = weekStart(anchor);
    return { from, to: minDay(shiftIsoDay(from, 6), today) };
  }
  if (p.period === 'month') {
    return { from: monthStart(anchor), to: minDay(monthEnd(anchor), today) };
  }
  if (p.period === 'range') {
    return orderedRange(p.from ?? p.to ?? today, p.to ?? p.from ?? today, today);
  }
  return { from: anchor, to: anchor };
}

/** Two days as a range: in order, never past today, at most the reports' widest window. */
export function orderedRange(x: string, y: string, today: string): DayRange {
  let from = x <= y ? x : y;
  let to = x <= y ? y : x;
  if (to > today) to = today;
  if (from > to) from = to;
  if (rangeDays({ from, to }) > MAX_RANGE_DAYS) from = shiftIsoDay(to, -(MAX_RANGE_DAYS - 1));
  return { from, to };
}

/**
 * Period B's days, or null (no comparison, or an event — which the server resolves).
 *
 * * `prev` — the period before, like for like: a day the day before; a week the week
 *   before, as many days as A has; a month the month before, from its 1st, as many days as
 *   A has (a whole month: the whole month before); a range the same length just before it.
 * * `lastWeek` — seven days back (a day: the same weekday last week).
 * * `lastYear` — a day or a week: 364 days back (the same weekdays); a month or a range: the
 *   same dates a year back.
 * * `custom` — the days asked for (ordered, never past today).
 */
export function comparedRange(
  p: Pick<CompareParams, 'period' | 'vs' | 'vsFrom' | 'vsTo'>,
  a: DayRange,
  today: string,
): DayRange | null {
  const len = rangeDays(a);
  switch (p.vs) {
    case 'prev': {
      if (p.period === 'month') {
        const from = addMonths(monthStart(a.from), -1);
        const whole = a.to === monthEnd(a.from);
        const to = whole ? monthEnd(from) : minDay(shiftIsoDay(from, len - 1), monthEnd(from));
        return { from, to };
      }
      const back = p.period === 'week' ? 7 : len;
      return { from: shiftIsoDay(a.from, -back), to: shiftIsoDay(a.to, -back) };
    }
    case 'lastWeek':
      return { from: shiftIsoDay(a.from, -7), to: shiftIsoDay(a.to, -7) };
    case 'lastYear':
      if (p.period === 'day' || p.period === 'week') {
        return { from: shiftIsoDay(a.from, -364), to: shiftIsoDay(a.to, -364) };
      }
      if (p.period === 'month') {
        const from = addYears(monthStart(a.from), -1);
        const whole = a.to === monthEnd(a.from);
        return { from, to: whole ? monthEnd(from) : minDay(shiftIsoDay(from, len - 1), monthEnd(from)) };
      }
      return { from: addYears(a.from, -1), to: addYears(a.to, -1) };
    case 'custom': {
      const x = p.vsFrom ?? p.vsTo;
      const y = p.vsTo ?? p.vsFrom;
      return x && y ? orderedRange(x, y, today) : null;
    }
    default:
      return null;
  }
}

/** One step back or forward for the period's arrows (a day, a week, a month, a range's length). */
export function stepAnchor(p: Pick<CompareParams, 'period'>, a: DayRange, dir: -1 | 1): string {
  if (p.period === 'week') return shiftIsoDay(a.from, 7 * dir);
  if (p.period === 'month') return addMonths(monthStart(a.from), dir);
  return shiftIsoDay(a.from, rangeDays(a) * dir);
}

// ── Change ───────────────────────────────────────────────────────────────────

export interface Delta {
  /** a − b. */
  abs: number;
  /** % from b; null when b is 0 and a is not ("new"), 0 when both are 0. */
  pct: number | null;
}

export function delta(a: number, b: number): Delta {
  const pct = pctChange(a, b);
  return { abs: Math.round((a - b) * 1000) / 1000, pct: pct === null ? null : Math.round(pct * 100) / 100 };
}

/** "+12.5%", "−3.0%", "0%" — or null for "new" (the caller says it in words). */
export function pctText(pct: number | null): string | null {
  if (pct === null) return null;
  if (Math.abs(pct) < 0.05) return '0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

// ── Curves ───────────────────────────────────────────────────────────────────

export interface SeriesPointIn {
  index: number;
  label: string;
  current: number | null;
  previous: number | null;
  currentDate?: string | null;
  previousDate?: string | null;
}

export interface CurvePoint {
  index: number;
  label: string;
  /** Null where the period has no such bucket (or it has not come yet): the line stops. */
  a: number | null;
  b: number | null;
  /** Running totals. */
  ca: number | null;
  cb: number | null;
  dateA: string | null;
  dateB: string | null;
}

/**
 * The server's aligned series as chart points with running totals. `trim` drops the quiet
 * hours at both ends (a day by the hour), keeping every bucket between the first and last
 * that sold in either period.
 */
export function curvePoints(series: SeriesPointIn[], trim: boolean): CurvePoint[] {
  let ca = 0;
  let cb = 0;
  const all = series.map((p) => {
    if (p.current !== null) ca += p.current;
    if (p.previous !== null) cb += p.previous;
    return {
      index: p.index,
      label: p.label,
      a: p.current,
      b: p.previous,
      ca: p.current === null ? null : Math.round(ca * 100) / 100,
      cb: p.previous === null ? null : Math.round(cb * 100) / 100,
      dateA: p.currentDate ?? null,
      dateB: p.previousDate ?? null,
    };
  });
  if (!trim) return all;
  const busy = (p: CurvePoint) => (p.a ?? 0) !== 0 || (p.b ?? 0) !== 0;
  const first = all.findIndex(busy);
  if (first < 0) return [];
  let last = all.length - 1;
  while (last > first && !busy(all[last])) last--;
  return all.slice(first, last + 1);
}

/** The biggest bucket of A (its index), or null with nothing sold. */
export function peakIndex(points: CurvePoint[]): number | null {
  let best: CurvePoint | null = null;
  for (const p of points) if ((p.a ?? 0) > 0 && (!best || (p.a ?? 0) > (best.a ?? 0))) best = p;
  return best ? best.index : null;
}

// ── Side by side ─────────────────────────────────────────────────────────────

/** Picks or drops `id`; a fifth pick replaces the oldest, so there are never more than four. */
export function toggleSideId(ids: string[], id: string, max = SIDE_MAX): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  const next = [...ids, id];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function sideReady(ids: string[]): boolean {
  return ids.length >= SIDE_MIN && ids.length <= SIDE_MAX;
}

/** Each entity's share of the columns' total — for the "who sold most" bars. */
export function shares(values: number[]): number[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  return values.map((v) => (total > 0 ? Math.round((Math.max(0, v) / total) * 1000) / 10 : 0));
}

// ── Exports ──────────────────────────────────────────────────────────────────

export interface FiguresLike {
  sales: number;
  gross: number;
  discounts: number;
  refunds: number;
  documents: number;
  salesCount: number;
  refundsCount: number;
  averageTicket: number;
  items: number;
  cash: number;
  card: number;
  other: number;
  tips: number;
}

export const FIGURE_ORDER: (keyof FiguresLike)[] = [
  'sales', 'documents', 'salesCount', 'averageTicket', 'items', 'gross', 'discounts', 'refunds',
  'refundsCount', 'cash', 'card', 'other', 'tips',
];

const MONEY_FIGURES = new Set<keyof FiguresLike>([
  'sales', 'averageTicket', 'gross', 'discounts', 'refunds', 'cash', 'card', 'other', 'tips',
]);

export function figureKind(key: keyof FiguresLike): 'money' | 'number' {
  return MONEY_FIGURES.has(key) ? 'money' : 'number';
}

export interface ComparisonExport {
  title: string;
  labelA: string;
  /** Null with no comparison. */
  labelB: string | null;
  current: FiguresLike;
  previous: FiguresLike | null;
  series: CurvePoint[];
  items: { name?: string | null; sku?: string | null; qty: number; net: number; previousQty?: number | null; previousNet?: number | null }[];
  vouchers?: { name: string; current: { vouchers: number; units: number; value: number }; previous?: { vouchers: number; units: number; value: number } | null }[];
}

/** The words the sheets need, from the page's messages. */
export interface ExportWords {
  summary: string;
  curve: string;
  items: string;
  vouchers: string;
  figure: string;
  change: string;
  changePct: string;
  bucket: string;
  item: string;
  sku: string;
  qty: string;
  net: string;
  total: string;
  voucher: string;
  voucherCount: string;
  units: string;
  value: string;
  figures: Record<keyof FiguresLike, string>;
}

const sum = <T,>(list: T[], pick: (x: T) => number | null | undefined) =>
  list.reduce((n, x) => n + (pick(x) ?? 0), 0);

/** The comparison as sheets: the figures with their change, the curve, the items, the vouchers. */
export function comparisonSheets(x: ComparisonExport, w: ExportWords): ExcelSheet[] {
  const both = x.previous !== null && x.labelB !== null;
  const heading = [x.title, both ? `${x.labelA} · ${x.labelB}` : x.labelA];
  const summary: ExcelSheet = {
    name: w.summary,
    heading,
    columns: [
      { header: w.figure, width: 22 },
      { header: x.labelA, kind: 'number' },
      ...(both
        ? [
            { header: x.labelB as string, kind: 'number' as const },
            { header: w.change, kind: 'number' as const },
            { header: w.changePct, kind: 'percent' as const },
          ]
        : []),
    ],
    rows: FIGURE_ORDER.map((key) => {
      const a = x.current[key];
      if (!both || !x.previous) return [w.figures[key], a];
      const d = delta(a, x.previous[key]);
      return [w.figures[key], a, x.previous[key], d.abs, d.pct];
    }),
    autoFilter: false,
  };
  const curve: ExcelSheet = {
    name: w.curve,
    heading,
    columns: [
      { header: w.bucket, width: 12 },
      { header: x.labelA, kind: 'money' },
      ...(both
        ? [
            { header: x.labelB as string, kind: 'money' as const },
            { header: w.change, kind: 'money' as const },
            { header: w.changePct, kind: 'percent' as const },
          ]
        : []),
    ],
    rows: x.series.map((p): ExcelValue[] => {
      const label = p.dateA ?? p.label;
      if (!both) return [label, p.a];
      const d = p.a !== null && p.b !== null ? delta(p.a, p.b) : null;
      return [label, p.a, p.b, d?.abs ?? null, d?.pct ?? null];
    }),
    totals: both
      ? [w.total, sum(x.series, (p) => p.a), sum(x.series, (p) => p.b),
        sum(x.series, (p) => p.a) - sum(x.series, (p) => p.b),
        delta(sum(x.series, (p) => p.a), sum(x.series, (p) => p.b)).pct]
      : [w.total, sum(x.series, (p) => p.a)],
  };
  const items: ExcelSheet = {
    name: w.items,
    heading,
    columns: [
      { header: w.item, width: 26 },
      { header: w.sku, width: 12 },
      { header: `${w.qty} ${x.labelA}`, kind: 'number' },
      ...(both ? [{ header: `${w.qty} ${x.labelB}`, kind: 'number' as const }] : []),
      { header: `${w.net} ${x.labelA}`, kind: 'money' },
      ...(both
        ? [
            { header: `${w.net} ${x.labelB}`, kind: 'money' as const },
            { header: w.changePct, kind: 'percent' as const },
          ]
        : []),
    ],
    rows: x.items.map((i): ExcelValue[] =>
      both
        ? [i.name ?? '—', i.sku ?? null, i.qty, i.previousQty ?? 0, i.net, i.previousNet ?? 0, delta(i.net, i.previousNet ?? 0).pct]
        : [i.name ?? '—', i.sku ?? null, i.qty, i.net],
    ),
  };
  const sheets = [summary, curve, items];
  if (x.vouchers && x.vouchers.length) {
    sheets.push({
      name: w.vouchers,
      heading,
      columns: [
        { header: w.voucher, width: 24 },
        { header: `${w.voucherCount} ${x.labelA}`, kind: 'number' },
        ...(both ? [{ header: `${w.voucherCount} ${x.labelB}`, kind: 'number' as const }] : []),
        { header: w.units, kind: 'number' },
        { header: w.value, kind: 'money' },
        ...(both ? [{ header: w.changePct, kind: 'percent' as const }] : []),
      ],
      rows: x.vouchers.map((v): ExcelValue[] =>
        both
          ? [v.name, v.current.vouchers, v.previous?.vouchers ?? 0, v.current.units, v.current.value,
            delta(v.current.vouchers, v.previous?.vouchers ?? 0).pct]
          : [v.name, v.current.vouchers, v.current.units, v.current.value],
      ),
    });
  }
  return sheets;
}

export interface SideBySideExport {
  title: string;
  period: string;
  entities: { name: string; figures: FiguresLike; series: (number | null)[] }[];
  buckets: string[];
}

/** Side by side as sheets: one column per entity, the figures and then the curve. */
export function sideBySideSheets(x: SideBySideExport, w: ExportWords): ExcelSheet[] {
  const heading = [x.title, x.period];
  const names = x.entities.map((e) => e.name);
  return [
    {
      name: w.summary,
      heading,
      columns: [{ header: w.figure, width: 22 }, ...names.map((n) => ({ header: n, kind: 'number' as const }))],
      rows: FIGURE_ORDER.map((key) => [w.figures[key], ...x.entities.map((e) => e.figures[key])]),
      autoFilter: false,
    },
    {
      name: w.curve,
      heading,
      columns: [{ header: w.bucket, width: 12 }, ...names.map((n) => ({ header: n, kind: 'money' as const }))],
      rows: x.buckets.map((label, i) => [label, ...x.entities.map((e) => e.series[i] ?? null)]),
      totals: [w.total, ...x.entities.map((e) => sum(e.series, (v) => v))],
    },
  ];
}

// ── The board's own shapes ───────────────────────────────────────────────────

/** A comparison's figures as the board's cards read them (`SalesFigures`, the overview's names). */
export function toSalesFigures(f: FiguresLike): SalesFigures {
  return {
    salesToday: f.sales,
    gross: f.gross,
    discounts: f.discounts,
    refunds: f.refunds,
    documentsToday: f.documents,
    salesCount: f.salesCount,
    refundsCount: f.refundsCount,
    cash: f.cash,
    card: f.card,
    other: f.other,
    tips: f.tips,
  };
}

/** Curve points as the board's hourly card draws them (an event's hours since it began). */
export function toHourPoints(points: CurvePoint[]): HourPoint[] {
  return points.map((p) => ({ hour: p.index, label: p.label, a: p.a, b: p.b, ca: p.ca, cb: p.cb }));
}

/** Card, cash and other as shares of a figure set (the board's stacked bar). */
export function tenderSharesOf(f: Pick<FiguresLike, 'card' | 'cash' | 'other'>): TenderShare[] {
  return tenderShares({ card: f.card, cash: f.cash, other: f.other });
}
