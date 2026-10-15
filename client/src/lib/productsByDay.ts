/**
 * "מכירות מוצרים לפי ימים" (P:\specs\reports-designed-pdf.md §8, §7.6): the shape of
 * `GET /reports/products-by-day`, and its Excel (a sheet per day, "סיכום", "מוצר × יום") and CSV.
 *
 * Pure: no React, no path aliases — `npm test` compiles this file on its own.
 */
import type { ExcelSheet, ExcelValue } from './excelExport';
import type { ReportInsight, ServerKpi } from './designedReport';
import { toCsv } from './csv';

export interface ByDayProduct {
  productId: string | null;
  name: string;
  department: string | null;
  units: number;
  net: number;
  /** % of the day (by net; by units when `amounts` is off). */
  share: number;
}

export interface ByDayDay {
  date: string;
  weekday: string;
  label: string;
  items: number;
  net: number;
  documents: number;
  /** Against the day before in the range; null for the first, or from 0. */
  changePct: number | null;
  products: ByDayProduct[];
}

export interface ByDaySummaryProduct extends ByDayProduct {
  averagePerDay: number;
  daysSold: number;
}

export interface ByDayMatrix {
  grouping: 'day' | 'week';
  columns: { key: string; label: string }[];
  rows: { productId: string | null; name: string; values: number[]; total: number }[];
}

export interface ProductsByDayReport {
  window: { from: string; to: string; [k: string]: unknown };
  generatedAt: string;
  scope: { label: string; [k: string]: unknown };
  options: { amounts: boolean; hideEmptyDays: boolean; sort: 'qty' | 'amount'; meals: 'components' | 'meals' };
  kpis: ServerKpi[];
  days: ByDayDay[];
  summary: { products: ByDaySummaryProduct[]; totals: { units: number; net: number; documents: number; days: number } };
  matrix: ByDayMatrix;
  insights: ReportInsight[];
}

export interface ProductsByDayParams {
  from: string;
  to: string;
  companyId?: string | null;
  shopIds?: string[];
  areaIds?: string[];
  machineIds?: string[];
  categoryIds?: string[];
  amounts?: boolean;
  hideEmptyDays?: boolean;
  sort?: 'qty' | 'amount';
  meals?: 'components' | 'meals';
  tz?: string | null;
}

/** The query of `GET /reports/products-by-day` and its `/pdf` (defaults left out). */
export function productsByDayQuery(p: ProductsByDayParams): string {
  const q = new URLSearchParams();
  q.set('from', p.from);
  q.set('to', p.to);
  if (p.tz) q.set('tz', p.tz);
  if (p.companyId) q.set('companyId', p.companyId);
  for (const id of p.shopIds ?? []) q.append('shopIds', id);
  for (const id of p.areaIds ?? []) q.append('areaIds', id);
  for (const id of p.machineIds ?? []) q.append('machineIds', id);
  for (const id of p.categoryIds ?? []) q.append('categoryIds', id);
  if (p.amounts === false) q.set('amounts', 'false');
  if (p.hideEmptyDays) q.set('hideEmptyDays', 'true');
  if (p.sort === 'amount') q.set('sort', 'amount');
  if (p.meals === 'meals') q.set('meals', 'meals');
  return q.toString();
}

/** A day's products in the chosen order: by quantity (default) or by ₪, the name breaking ties. */
export function sortProducts<T extends { units: number; net: number; name: string }>(rows: readonly T[], sort: 'qty' | 'amount'): T[] {
  return [...rows].sort((a, b) => {
    const d = sort === 'amount' ? b.net - a.net || b.units - a.units : b.units - a.units || b.net - a.net;
    return d || a.name.localeCompare(b.name, 'he');
  });
}

export interface ByDayWords {
  /** Sheet names. */
  summarySheet: string;
  matrixSheet: string;
  daysSheet: string;
  /** Column headers. */
  date: string;
  weekday: string;
  items: string;
  net: string;
  documents: string;
  change: string;
  product: string;
  department: string;
  units: string;
  share: string;
  averagePerDay: string;
  daysSold: string;
  total: string;
  /** A day's sheet name ("14.10"). */
  daySheetName: (day: ByDayDay) => string;
}

const r1 = (n: number | null | undefined): ExcelValue => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

/**
 * The workbook (§8 "ייצוא"): "ימים" (a row per day), a sheet per day with its products, then
 * "סיכום" (every product over the range) and "מוצר × יום" (quantities). Quantities only when
 * `amounts` is off.
 */
export function productsByDaySheets(report: ProductsByDayReport, w: ByDayWords, sort: 'qty' | 'amount' = report.options.sort): ExcelSheet[] {
  const money = report.options.amounts;
  const days: ExcelSheet = {
    name: w.daysSheet,
    columns: [
      { key: 'date', header: w.date, kind: 'date' },
      { key: 'weekday', header: w.weekday, width: 10 },
      { key: 'items', header: w.items, kind: 'number' },
      ...(money ? [{ key: 'net', header: w.net, kind: 'money' as const }] : []),
      { key: 'documents', header: w.documents, kind: 'number' },
      { key: 'change', header: w.change, kind: 'percent' },
    ],
    rows: report.days.map((d) => [d.date, d.weekday, d.items, ...(money ? [d.net] : []), d.documents, r1(d.changePct)]),
    totals: [
      w.total,
      null,
      report.summary.totals.units,
      ...(money ? [report.summary.totals.net] : []),
      report.summary.totals.documents,
      null,
    ],
  };
  const productColumns = (extra: ExcelSheet['columns']): ExcelSheet['columns'] => [
    { key: 'product', header: w.product, width: 30 },
    { key: 'department', header: w.department, width: 18 },
    { key: 'units', header: w.units, kind: 'number' },
    ...(money ? [{ key: 'net', header: w.net, kind: 'money' as const }] : []),
    { key: 'share', header: w.share, kind: 'percent' },
    ...extra,
  ];
  const perDay: ExcelSheet[] = report.days.map((d) => ({
    name: w.daySheetName(d),
    heading: [d.label],
    columns: productColumns([]),
    rows: sortProducts(d.products, sort).map((p) => [p.name, p.department ?? '', p.units, ...(money ? [p.net] : []), r1(p.share)]),
    totals: [w.total, null, d.items, ...(money ? [d.net] : []), null],
  }));
  const summary: ExcelSheet = {
    name: w.summarySheet,
    columns: productColumns([
      { key: 'averagePerDay', header: w.averagePerDay, kind: 'number' },
      { key: 'daysSold', header: w.daysSold, kind: 'number' },
    ]),
    rows: sortProducts(report.summary.products, sort).map((p) => [
      p.name,
      p.department ?? '',
      p.units,
      ...(money ? [p.net] : []),
      r1(p.share),
      r1(p.averagePerDay),
      p.daysSold,
    ]),
    totals: [
      w.total,
      null,
      report.summary.totals.units,
      ...(money ? [report.summary.totals.net] : []),
      null,
      null,
      null,
    ],
  };
  const matrix: ExcelSheet = {
    name: w.matrixSheet,
    columns: [
      { key: 'product', header: w.product, width: 30 },
      ...report.matrix.columns.map((c) => ({ key: `d${c.key}`, header: c.label, kind: 'number' as const, width: 9 })),
      { key: 'total', header: w.total, kind: 'number' },
    ],
    rows: report.matrix.rows.map((r) => [r.name, ...report.matrix.columns.map((_, i) => r.values[i] ?? 0), r.total]),
  };
  return [days, ...perDay, summary, matrix];
}

/** The CSV: one row per day × product (date, weekday, product, department, quantity[, ₪], %). */
export function productsByDayCsv(report: ProductsByDayReport, w: ByDayWords, sort: 'qty' | 'amount' = report.options.sort): string {
  const money = report.options.amounts;
  const header = [w.date, w.weekday, w.product, w.department, w.units, ...(money ? [w.net] : []), w.share];
  const rows = report.days.flatMap((d) =>
    sortProducts(d.products, sort).map((p) => [d.date, d.weekday, p.name, p.department ?? '', p.units, ...(money ? [p.net] : []), r1(p.share) as number | null]),
  );
  return toCsv(header, rows);
}
