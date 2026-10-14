/**
 * The designed report (P:\specs\reports-designed-pdf.md §1, §2, §6): what every export sends
 * besides its table — the report's type, its KPI cards with their comparison, a chart of the
 * main figure, the previous period's rows and the subtotal grouping — and what the client
 * builds from it: the Excel's first sheet "סיכום ותובנות" and the CSV.
 *
 * The insights themselves are written by the server, per report type (`reportInsights.<type>`);
 * the client never words one.
 *
 * Pure: no React, no path aliases — `npm test` compiles this file on its own.
 */
import type { ExcelSheet, ExcelValue } from './excelExport';
import { toCsv, type CsvCell } from './csv';

// ── The contract (§6) ────────────────────────────────────────────────────────

/** How a KPI's value is written. */
export type KpiKind = 'money' | 'number' | 'percent' | 'count' | 'minutes' | 'text';

/** A KPI against the previous period (or the same weekday last week). */
export interface KpiCompare {
  /** The previous period's value. */
  previous: number | null;
  /** Change in percent; null when the previous value is 0 (or unknown). */
  pct?: number | null;
  /** `true`: a rise is bad news (refunds, discounts) — the tag turns red when it goes up. */
  invert?: boolean;
  /** What it is compared with ("מול 01.10–07.10"). */
  label?: string;
}

export interface ReportKpi {
  /** Stable, `[A-Za-z0-9_.-]`: the server's insight rules read KPIs by key. */
  key: string;
  label: string;
  value: number | string | null;
  kind: KpiKind;
  compare?: KpiCompare;
  /** The last days' values, oldest first (the card's sparkline). */
  spark?: number[];
}

export type ReportChartType = 'bar' | 'hbar' | 'donut' | 'line';

export interface ReportChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ReportChart {
  type: ReportChartType;
  title?: string;
  labels: string[];
  series: ReportChartSeries[];
  /** How the values are written (default money). */
  kind?: KpiKind;
}

/** One insight sentence, as the server words it. */
export interface ReportInsight {
  /** 🏆 leader · 📈 up · 📉 down · ⚠ anomaly · 💡 tip (§5). */
  kind: 'leader' | 'up' | 'down' | 'anomaly' | 'tip' | string;
  text: string;
}

/** What a page gives its export besides the tables. */
export interface DesignedReportInput {
  /** The server's `reportInsights.<type>`; absent: a general designed report. */
  reportType?: string;
  kpis?: ReportKpi[];
  chart?: ReportChart | null;
  /** The main table's column keys the subtotals group by (shop → point of sale → till). */
  groupBy?: string[];
  /**
   * The same report for the previous period, fetched on the click (where the page can):
   * its rows in the main table's shape, and its KPI values by key.
   */
  previous?: () => Promise<PreviousPeriod | null>;
}

export interface PreviousPeriod {
  rows?: unknown[];
  kpis?: Record<string, number | null | undefined>;
  /** What the period is ("01.10–07.10"); default: the range of `from`/`to`. */
  from?: string | null;
  to?: string | null;
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
export function kpiNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Figures where a rise is bad news, by key. */
const INVERTED = /(refund|cancel|void|discount|oth|variance|declined|untransmitted|failed|abandon|error|problem|exception)/i;

/** The KPIs with their comparison to the previous period's values (by key). */
export function withCompare(
  kpis: readonly ReportKpi[],
  previous: Record<string, number | null | undefined> | null | undefined,
  label?: string,
): ReportKpi[] {
  if (!previous) return [...kpis];
  return kpis.map((k) => {
    if (k.compare || !(k.key in previous)) return k;
    const now = kpiNumber(k.value);
    const before = kpiNumber(previous[k.key] ?? null);
    if (now === null || before === null) return k;
    return {
      ...k,
      compare: {
        previous: before,
        pct: changePct(now, before),
        ...(INVERTED.test(k.key) ? { invert: true } : {}),
        ...(label ? { label } : {}),
      },
    };
  });
}

/** KPIs as the server takes them: 6 at most, keys unique, values plain. */
export function cleanKpis(kpis: readonly ReportKpi[] | undefined): ReportKpi[] {
  const seen = new Set<string>();
  const out: ReportKpi[] = [];
  for (const k of kpis ?? []) {
    if (!k || !k.key || seen.has(k.key)) continue;
    seen.add(k.key);
    const value = k.kind === 'text' ? (k.value ?? null) : kpiNumber(k.value);
    out.push({
      key: k.key.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64),
      label: k.label.slice(0, 120),
      value,
      kind: k.kind,
      ...(k.compare ? { compare: k.compare } : {}),
      ...(k.spark?.length ? { spark: k.spark.slice(-31).map((n) => (Number.isFinite(n) ? n : 0)) } : {}),
    });
    if (out.length === 6) break;
  }
  return out;
}

/** A chart as the server takes it: labels and every series cut to the same 40 points. */
export function cleanChart(chart: ReportChart | null | undefined): ReportChart | undefined {
  if (!chart || !chart.labels.length || !chart.series.length) return undefined;
  const n = Math.min(chart.labels.length, chart.type === 'donut' ? 12 : 40);
  const series = chart.series
    .slice(0, 4)
    .map((s) => ({ name: s.name.slice(0, 80), values: s.values.slice(0, n).map((v) => (v === null || Number.isFinite(v) ? v : null)) }));
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
  options: { type?: ReportChartType; top?: number; title?: string; kind?: KpiKind } = {},
): ReportChart | undefined {
  const li = table.columns.findIndex((c) => c.key === labelKey);
  const vi = table.columns.findIndex((c) => c.key === valueKey);
  if (li < 0 || vi < 0) return undefined;
  const points = table.rows
    .map((r) => ({ label: String(r[li] ?? ''), value: kpiNumber(r[vi] as number | string | null) }))
    .filter((p): p is { label: string; value: number } => p.label !== '' && p.value !== null);
  const type = options.type ?? 'hbar';
  if (type !== 'line') points.sort((a, b) => b.value - a.value);
  const top = points.slice(0, options.top ?? (type === 'donut' ? 6 : 10));
  if (!top.length) return undefined;
  return {
    type,
    title: options.title ?? table.columns[vi].header,
    labels: top.map((p) => p.label),
    series: [{ name: table.columns[vi].header, values: top.map((p) => p.value) }],
    kind: options.kind ?? 'money',
  };
}

// ── The Excel's first sheet (§1, §6) ─────────────────────────────────────────

export interface SummarySheetWords {
  /** The sheet's name: "סיכום ותובנות". */
  sheetName: string;
  kpiHeader: string;
  valueHeader: string;
  previousHeader: string;
  changeHeader: string;
  insightsHeading: string;
  /** "▲ / ▼" with the change as the sheet shows it. */
}

/** A KPI value as the sheet holds it (a number stays a number; Excel formats it by kind). */
function kpiCell(k: ReportKpi): ExcelValue {
  if (k.kind === 'text') return k.value === null ? null : String(k.value);
  return kpiNumber(k.value);
}

/**
 * "סיכום ותובנות": the KPIs (value, previous, change %) and under them the server's insight
 * sentences, one per row. Null when there is nothing to say (no KPI and no insight).
 */
export function summarySheet(
  kpis: readonly ReportKpi[],
  insights: readonly ReportInsight[],
  words: SummarySheetWords,
): ExcelSheet | null {
  if (!kpis.length && !insights.length) return null;
  const hasCompare = kpis.some((k) => k.compare);
  const rows: ExcelValue[][] = kpis.map((k) => [
    k.label,
    kpiCell(k),
    ...(hasCompare ? [k.compare?.previous ?? null, k.compare?.pct ?? null] : []),
  ]);
  const width = hasCompare ? 4 : 2;
  const pad = (cells: ExcelValue[]) => [...cells, ...Array.from({ length: width - cells.length }, () => null)];
  if (insights.length) {
    if (rows.length) rows.push(pad([]));
    rows.push(pad([words.insightsHeading]));
    for (const i of insights) rows.push(pad([`${insightMark(i.kind)} ${i.text}`.trim()]));
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
export function insightMark(kind: string): string {
  switch (kind) {
    case 'leader':
      return '🏆';
    case 'up':
      return '📈';
    case 'down':
      return '📉';
    case 'anomaly':
    case 'risk':
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
