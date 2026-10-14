/**
 * The designed report (P:\specs\reports-designed-pdf.md §1, §2, §6, §7): what every export sends
 * besides its table — the report's type, its KPI cards with their comparison, a chart of the
 * main figure, the previous period's rows and the subtotal grouping — and what the client
 * builds from it: the Excel's first sheet "סיכום ותובנות" and the CSV.
 *
 * The insights themselves are written by the server, per report type (§7.4: the type picks a
 * family — ranking, mix, people, hourly, timeline, risk); the client never words one.
 *
 * Pure: no React, no path aliases — `npm test` compiles this file on its own.
 */
import type { ExcelSheet, ExcelValue } from './excelExport';
import { toCsv, type CsvCell } from './csv';

// ── The contract (§7.1) ──────────────────────────────────────────────────────

/**
 * How a KPI's value is written. The server's are money · number · percent · text · duration
 * (seconds); `count` is sent as number and `minutes` as duration.
 */
export type KpiKind = 'money' | 'number' | 'percent' | 'text' | 'duration' | 'count' | 'minutes';

/** The KPI card's icon (§7.5); default by key. */
export type KpiIcon =
  | 'sales'
  | 'receipt'
  | 'basket'
  | 'items'
  | 'users'
  | 'user'
  | 'refund'
  | 'void'
  | 'discount'
  | 'gift'
  | 'tip'
  | 'clock'
  | 'card'
  | 'cash'
  | 'table'
  | 'alert'
  | 'star'
  | 'box'
  | 'chart'
  | 'percent'
  | 'kiosk'
  | 'voucher'
  | 'target'
  | 'calendar';

export interface ReportKpi {
  /** Stable, `[A-Za-z0-9_.-]`: the server's insight rules read KPIs by key. */
  key: string;
  label: string;
  value: number | string | null;
  kind: KpiKind;
  /** The previous period's value, or `{value, label}`. */
  compare?: number | null | { value: number | null; label?: string };
  /** What it is compared with (default "תקופה קודמת"). */
  compareLabel?: string;
  /** The last days' values, oldest first (the card's sparkline, ≤ 31). */
  spark?: number[];
  /** Which way is good news; default by key (refund*, void*, discount*… → down). */
  better?: 'up' | 'down';
  icon?: KpiIcon;
}

export type ReportChartType = 'bar' | 'hbar' | 'donut' | 'line';

export interface ReportChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ReportChart {
  type: ReportChartType;
  title?: string;
  /** ≤ 48 (a donut / hbar: the server groups past 12 into "אחר"). */
  labels: string[];
  /** ≤ 3. */
  series: ReportChartSeries[];
  /** How the values are labelled (default money). */
  kind?: 'money' | 'number' | 'percent';
}

/** One insight sentence, as the server words it (§7.2). */
export interface ReportInsight {
  /** 🏆 leader · 📈 up · 📉 down · ⚠ alert · 💡 tip (§5). */
  type: 'leader' | 'up' | 'down' | 'alert' | 'tip' | string;
  text: string;
}

/** A KPI as `POST /reports/insights` returns it (§7.2): its comparison worked out. */
export interface ServerKpi {
  key: string;
  label: string;
  kind: string;
  value: number | string | null;
  display?: string;
  compare?: number | null;
  compareDisplay?: string;
  compareLabel?: string;
  changePct?: number | null;
  direction?: 'up' | 'down' | 'flat' | null;
  good?: boolean | null;
}

/** Hints for the insight rules: which columns are the label, the figure, the count… (§7.1). */
export interface InsightKeys {
  label?: string;
  value?: string;
  count?: string;
  hour?: string;
  employee?: string;
  id?: string;
}

export interface PreviousPeriod {
  rows?: unknown[];
  kpis?: Record<string, number | null | undefined>;
  /** The period's days (the label "מול 01.10–07.10" is made from them). */
  from?: string | null;
  to?: string | null;
  /** What the period is, when not its days ("שבוע שעבר"). */
  label?: string;
}

// ── The previous period ───────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `day` moved by `n` calendar days (noon-anchored: a DST night never skips one). */
export function shiftDay(day: string, n: number): string {
  const m = ISO_DAY.exec(day);
  if (!m) return day;
  return isoDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n, 12));
}

/** Days from `from` to `to`, both included (1 for one day; 0 when either is not a day). */
export function daysInRange(from: string, to: string): number {
  const a = ISO_DAY.exec(from);
  const b = ISO_DAY.exec(to);
  if (!a || !b) return 0;
  const ms =
    Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) - Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * The period a report is compared with: one day → the same weekday a week before (§1.2);
 * a range → as many days right before it. Null when the range is not two days.
 */
export function previousWindow(from?: string | null, to?: string | null): { from: string; to: string } | null {
  if (!from || !to) return null;
  const n = daysInRange(from, to);
  if (n <= 0) return null;
  if (n === 1) return { from: shiftDay(from, -7), to: shiftDay(to, -7) };
  return { from: shiftDay(from, -n), to: shiftDay(from, -1) };
}

/** Change in percent, one decimal; null from zero (never a division by zero). */
export function changePct(value: number, previous: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(previous)) return null;
  if (previous === 0) return value === 0 ? 0 : null;
  return Math.round(((value - previous) / Math.abs(previous)) * 1000) / 10;
}

/** A number out of a KPI value (the API's decimal strings too); null when it is not one. */
export function kpiNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The KPI's previous value, whichever form `compare` took. */
export function compareValue(k: Pick<ReportKpi, 'compare'>): number | null {
  if (k.compare === undefined || k.compare === null) return null;
  return typeof k.compare === 'number' ? k.compare : kpiNumber(k.compare.value);
}

/** The KPIs with the previous period's values (by key) as their comparison. */
export function withCompare(
  kpis: readonly ReportKpi[],
  previous: Record<string, number | null | undefined> | null | undefined,
  label?: string,
): ReportKpi[] {
  if (!previous) return [...kpis];
  return kpis.map((k) => {
    if (k.compare !== undefined || !(k.key in previous)) return k;
    const before = kpiNumber(previous[k.key]);
    if (before === null || kpiNumber(k.value) === null) return k;
    return { ...k, compare: before, ...(label && !k.compareLabel ? { compareLabel: label } : {}) };
  });
}

/** Up to 8 KPIs as the server takes them (§7.1): keys unique and safe, kinds the server's. */
export function cleanKpis(kpis: readonly ReportKpi[] | undefined): ReportKpi[] {
  const seen = new Set<string>();
  const out: ReportKpi[] = [];
  for (const k of kpis ?? []) {
    if (!k || !k.key) continue;
    const key = k.key.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    // Minutes go as seconds (`duration`); a count is a number.
    const factor = k.kind === 'minutes' ? 60 : 1;
    const kind = k.kind === 'minutes' ? 'duration' : k.kind === 'count' ? 'number' : k.kind;
    const scale = (n: number | null) => (n === null ? null : Math.round(n * factor * 100) / 100);
    const value = kind === 'text' ? (k.value === null ? null : String(k.value)) : scale(kpiNumber(k.value));
    const before = compareValue(k);
    const compare =
      k.compare === undefined || before === null
        ? undefined
        : typeof k.compare === 'object' && k.compare?.label
          ? { value: scale(before), label: k.compare.label }
          : scale(before);
    out.push({
      key,
      label: k.label.slice(0, 120),
      value,
      kind,
      ...(compare !== undefined && compare !== null ? { compare } : {}),
      ...(k.compareLabel ? { compareLabel: k.compareLabel.slice(0, 80) } : {}),
      ...(k.spark?.length ? { spark: k.spark.slice(-31).map((n) => scale(Number.isFinite(n) ? n : 0) ?? 0) } : {}),
      ...(k.better ? { better: k.better } : {}),
      ...(k.icon ? { icon: k.icon } : {}),
    });
    if (out.length === 8) break;
  }
  return out;
}

/** A chart as the server takes it: ≤ 48 labels, ≤ 3 series of the same length; null-free numbers. */
export function cleanChart(chart: ReportChart | null | undefined): ReportChart | undefined {
  if (!chart || !chart.labels.length || !chart.series.length) return undefined;
  const n = Math.min(chart.labels.length, 48);
  const series = chart.series.slice(0, 3).map((s) => ({
    name: s.name.slice(0, 80),
    values: s.values.slice(0, n).map((v) => (v === null || !Number.isFinite(v) ? null : v)),
  }));
  if (!series.some((s) => s.values.some((v) => v !== null && v !== 0))) return undefined;
  return {
    type: chart.type,
    ...(chart.title ? { title: chart.title.slice(0, 120) } : {}),
    labels: chart.labels.slice(0, n).map((l) => String(l).slice(0, 60)),
    series,
    ...(chart.kind ? { kind: chart.kind } : {}),
  };
}

/**
 * The main figure of a table as a chart: the `top` largest rows by `valueKey`, labelled by
 * `labelKey` (an `hbar` of products, departments, cashiers…). Rows are the export's plain
 * values in the table's column order.
 */
export function chartFromTable(
  table: { columns: { key: string; header: string }[]; rows: ExcelValue[][] },
  labelKey: string,
  valueKey: string,
  options: { type?: ReportChartType; top?: number; title?: string; kind?: ReportChart['kind'] } = {},
): ReportChart | undefined {
  const li = table.columns.findIndex((c) => c.key === labelKey);
  const vi = table.columns.findIndex((c) => c.key === valueKey);
  if (li < 0 || vi < 0) return undefined;
  const points = table.rows
    .map((r) => ({ label: String(r[li] ?? ''), value: kpiNumber(r[vi]) }))
    .filter((p): p is { label: string; value: number } => p.label !== '' && p.value !== null);
  const type = options.type ?? 'hbar';
  if (type !== 'line') points.sort((a, b) => b.value - a.value);
  const top = points.slice(0, options.top ?? (type === 'line' || type === 'bar' ? 48 : 12));
  if (!top.length) return undefined;
  return {
    type,
    title: options.title ?? table.columns[vi].header,
    labels: top.map((p) => p.label),
    series: [{ name: table.columns[vi].header, values: top.map((p) => p.value) }],
    kind: options.kind ?? 'money',
  };
}

// ── The Excel's first sheet (§1, §7.2) ──────────────────────────────────────

export interface SummarySheetWords {
  /** The sheet's name: "סיכום ותובנות". */
  sheetName: string;
  kpiHeader: string;
  valueHeader: string;
  previousHeader: string;
  changeHeader: string;
  insightsHeading: string;
}

/** A KPI row of the summary sheet: as the server worked it out, or as the page gave it. */
interface SummaryKpi {
  label: string;
  value: ExcelValue;
  previous: number | null;
  pct: number | null;
}

function summaryKpis(kpis: readonly (ReportKpi | ServerKpi)[]): SummaryKpi[] {
  return kpis.map((k) => {
    const isText = k.kind === 'text';
    // The server's display ("₪ 12,345.50", "12:30") for what a number cell cannot say.
    const display = 'display' in k ? k.display : undefined;
    const value: ExcelValue = isText ? (k.value === null ? null : String(k.value)) : (kpiNumber(k.value) ?? display ?? null);
    const previous = typeof k.compare === 'number' ? k.compare : k.compare ? kpiNumber(k.compare.value) : null;
    const pct =
      'changePct' in k && k.changePct !== undefined
        ? (k.changePct ?? null)
        : previous !== null && typeof value === 'number'
          ? changePct(value, previous)
          : null;
    return { label: k.label, value, previous, pct };
  });
}

/**
 * "סיכום ותובנות": the KPIs (value, previous, change %) and under them the server's insight
 * sentences, one per row. Null when there is nothing to say (no KPI and no insight).
 */
export function summarySheet(
  kpis: readonly (ReportKpi | ServerKpi)[],
  insights: readonly ReportInsight[],
  words: SummarySheetWords,
): ExcelSheet | null {
  if (!kpis.length && !insights.length) return null;
  const list = summaryKpis(kpis);
  const hasCompare = list.some((k) => k.previous !== null);
  const rows: ExcelValue[][] = list.map((k) => [k.label, k.value, ...(hasCompare ? [k.previous, k.pct] : [])]);
  const width = hasCompare ? 4 : 2;
  const pad = (cells: ExcelValue[]) => [...cells, ...Array.from({ length: width - cells.length }, () => null)];
  if (insights.length) {
    if (rows.length) rows.push(pad([]));
    rows.push(pad([words.insightsHeading]));
    for (const i of insights) rows.push(pad([`${insightMark(i.type)} ${i.text}`.trim()]));
  }
  // One kind per column: a money KPI and a count share the value column, so it is "number".
  return {
    name: words.sheetName,
    columns: [
      { header: words.kpiHeader, kind: 'text', width: 60 },
      { header: words.valueHeader, kind: 'number', width: 16 },
      ...(hasCompare
        ? [
            { header: words.previousHeader, kind: 'number' as const, width: 16 },
            { header: words.changeHeader, kind: 'percent' as const, width: 12 },
          ]
        : []),
    ],
    rows,
    autoFilter: false,
  };
}

/** The insight's sign, as the PDF's card shows it (§5); readable without colour. */
export function insightMark(type: string): string {
  switch (type) {
    case 'leader':
      return '🏆';
    case 'up':
      return '📈';
    case 'down':
      return '📉';
    case 'alert':
    case 'anomaly':
      return '⚠';
    case 'tip':
      return '💡';
    default:
      return '•';
  }
}

// ── CSV ───────────────────────────────────────────────────────────────────────

/**
 * A table as CSV: the chosen columns' headers, then the rows with the export's plain values
 * (money as numbers, never "₪1,234.50"), then the totals row when there is one.
 */
export function tableCsv(table: {
  columns: { header: string }[];
  rows: ExcelValue[][];
  totals?: ExcelValue[];
}): string {
  const plain = (v: ExcelValue): CsvCell => (v === undefined ? null : v);
  const rows = table.rows.map((r) => r.map(plain));
  if (table.totals) rows.push(table.totals.map(plain));
  return toCsv(
    table.columns.map((c) => c.header),
    rows,
  );
}
