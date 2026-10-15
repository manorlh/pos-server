/**
 * "סיכום יום" v2 (P:\specs\reports-designed-pdf.md §3, §7.3): the shape `GET /reports/day-summary`
 * answers when it is given a `date` — one business day of the scope, compared with the same
 * weekday last week and the average of that weekday over 4 weeks — and the pure rules the page
 * and its export apply to it.
 *
 * Pure: no React, no path aliases — `npm test` compiles this file on its own.
 */
import type { ExcelValue } from './excelExport';
import type { KpiIcon, ReportInsight, ReportKpi } from './designedReport';

export interface DayKpi {
  key: string;
  label: string;
  kind: 'money' | 'number' | 'percent' | 'text' | 'duration';
  icon?: KpiIcon | string;
  better?: 'up' | 'down';
  value: number | null;
  lastWeek: number | null;
  avg4w: number | null;
  /** Null when the base is 0. */
  changePct: number | null;
  changePctAvg: number | null;
  /** D−6..D, oldest first. */
  spark?: number[];
  sparkDays?: string[];
  /** A count beside a sum (refunds: their number). */
  count?: number | null;
}

export interface DayHour {
  hour: number;
  label: string;
  net: number;
  documents: number;
  lastWeekNet: number;
  lastWeekDocuments: number;
}

export interface DayHierarchyRow {
  level: 'shop' | 'area' | 'till';
  id: string | null;
  parentId: string | null;
  name: string;
  net: number;
  share: number;
  documents: number;
  averageTicket: number;
  lastWeekNet: number;
  changePct: number | null;
}

export interface DayPaymentMethod {
  method: string;
  label: string;
  amount: number;
  documents: number;
  share: number;
}

export interface DayDepartment {
  id: string | null;
  name: string;
  units: number;
  net: number;
  share: number;
  lastWeekNet: number;
  changePct: number | null;
}

export interface DayItem {
  productId: string | null;
  name: string;
  units: number;
  net: number;
  share: number;
  lastWeekNet: number;
  changePct: number | null;
}

export interface DayMover {
  productId: string | null;
  name: string;
  net: number;
  lastWeekNet: number;
  change: number;
  changePct: number | null;
}

export interface DayOpenTable {
  name: string;
  openedAt: string | null;
  total: number;
  guests: number | null;
  waiter: string | null;
}

export interface DayTables {
  opened: number;
  paid: number;
  cancelled: number;
  stillOpen: number;
  guests: number;
  averageSeatedMinutes: number | null;
  averagePerTable: number | null;
  averagePerCover: number | null;
  open: DayOpenTable[];
}

export interface DayStaff {
  cashierId: string | null;
  name: string;
  net: number;
  documents: number;
  averageTicket: number;
  tips: number;
  /** From attendance; null when it is not in use. */
  hours: number | null;
}

export interface DayRiskByEmployee {
  name: string;
  refunds: number;
  refundsCount: number;
  voids: number;
  voidsCount: number;
  tableCancels: number;
  discounts: number;
  oth: number;
  drawerOpens: number;
}

export interface DayRisks {
  byEmployee: DayRiskByEmployee[];
  untransmittedCard: { count: number; amount: number; tills: { machineId: string; name: string; count: number; amount: number }[] };
  drawerOpensNoSale: number;
  cancelledDocuments: { count: number; amount: number };
  exceptions: { type: string; label: string; count: number }[];
}

export interface DayKioskRow {
  machineId: string;
  name: string;
  net: number;
  documents: number;
}

export interface DayKiosks {
  orders: number;
  net: number;
  averageTicket: number;
  sessions: number;
  abandoned: number;
  medianOrderSec: number | null;
  byKiosk: DayKioskRow[];
}

export interface DaySummaryV2 {
  version: 2;
  date: string;
  weekday: string;
  businessDay: { start: string; end: string; startHour: number; timezone: string };
  generatedAt: string;
  scope: { companyId: string | null; shopIds: string[]; areaIds: string[]; machineIds: string[]; label: string };
  compare: { lastWeek: string; weeks: string[] };
  /** No document at all on the day. */
  empty: boolean;
  kpis: DayKpi[];
  insights: ReportInsight[];
  hourly: DayHour[];
  hierarchy: DayHierarchyRow[];
  paymentMethods: DayPaymentMethod[];
  payAtTill: { orders: number; amount: number } | null;
  noMoneyMovement: { documents: number; amount: number } | null;
  departments: DayDepartment[];
  topItems: DayItem[];
  risers: DayMover[];
  fallers: DayMover[];
  tables: DayTables | null;
  staff: DayStaff[];
  risks: DayRisks | null;
  kiosks: DayKiosks | null;
}

export interface DaySummaryV2Params {
  /** The business day; absent — the server's business day of now. */
  date?: string | null;
  companyId?: string | null;
  shopIds?: string[];
  areaIds?: string[];
  machineIds?: string[];
  tz?: string | null;
}

/**
 * The query of `GET /reports/day-summary` (v2) and its `/pdf`: `date` always sent when known
 * (it is what makes the answer v2), the lists repeated (`shopIds=a&shopIds=b`).
 */
export function daySummaryV2Query(p: DaySummaryV2Params): string {
  const q = new URLSearchParams();
  if (p.date) q.set('date', p.date);
  if (p.tz) q.set('tz', p.tz);
  if (p.companyId) q.set('companyId', p.companyId);
  for (const id of p.shopIds ?? []) q.append('shopIds', id);
  for (const id of p.areaIds ?? []) q.append('areaIds', id);
  for (const id of p.machineIds ?? []) q.append('machineIds', id);
  return q.toString();
}

/** A v2 answer, never the old roll-up (`version` 2 with its `kpis`). */
export function isDaySummaryV2(data: unknown): data is DaySummaryV2 {
  return !!data && typeof data === 'object' && (data as { version?: unknown }).version === 2 && Array.isArray((data as { kpis?: unknown }).kpis);
}

/** The direction of a change and whether it is good news (a KPI's `better`; default up). */
export function changeTone(pct: number | null | undefined, better: 'up' | 'down' = 'up'): { arrow: '▲' | '▼' | '—'; good: boolean | null } {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return { arrow: '—', good: null };
  if (Math.abs(pct) < 0.05) return { arrow: '—', good: null };
  const up = pct > 0;
  return { arrow: up ? '▲' : '▼', good: better === 'up' ? up : !up };
}

/** How deep a row of the shop → point of sale → till tree sits (0, 1, 2), from its parent chain. */
export function hierarchyDepths(rows: readonly DayHierarchyRow[]): number[] {
  const byId = new Map<string, DayHierarchyRow>();
  for (const r of rows) if (r.id) byId.set(`${r.level}:${r.id}`, r);
  const levelOf = (r: DayHierarchyRow) => (r.level === 'shop' ? 0 : r.level === 'area' ? 1 : 2);
  return rows.map((r) => {
    if (r.level === 'shop') return 0;
    // A till with no point of sale sits right under its shop (§7.3: parentId = the shop).
    if (r.level === 'till' && r.parentId && byId.has(`shop:${r.parentId}`) && !byId.has(`area:${r.parentId}`)) return 1;
    return levelOf(r);
  });
}

/** The day's KPIs as the designed export sends them (compared with the same weekday last week). */
export function dayExportKpis(kpis: readonly DayKpi[], lastWeekLabel: string): ReportKpi[] {
  return kpis.map((k) => ({
    key: k.key,
    label: k.label,
    value: k.value,
    kind: k.kind,
    ...(k.lastWeek !== null ? { compare: k.lastWeek, compareLabel: lastWeekLabel } : {}),
    ...(k.spark?.length ? { spark: k.spark } : {}),
    ...(k.better ? { better: k.better } : {}),
    ...(k.icon ? { icon: k.icon as KpiIcon } : {}),
  }));
}

/** The hierarchy as export rows: the name indented by its depth ("  · קופה 2"). */
export function hierarchyExportRows(rows: readonly DayHierarchyRow[]): { row: DayHierarchyRow; label: string }[] {
  const depths = hierarchyDepths(rows);
  return rows.map((row, i) => ({ row, label: `${'  '.repeat(depths[i])}${depths[i] ? '· ' : ''}${row.name}` }));
}

/** The hourly chart's points: the hours that had anything on the day or a week before. */
export function activeHours(hours: readonly DayHour[]): DayHour[] {
  const first = hours.findIndex((h) => h.net !== 0 || h.lastWeekNet !== 0 || h.documents > 0 || h.lastWeekDocuments > 0);
  if (first < 0) return [];
  let last = hours.length - 1;
  while (last > first && hours[last].net === 0 && hours[last].lastWeekNet === 0 && hours[last].documents === 0 && hours[last].lastWeekDocuments === 0) last -= 1;
  return hours.slice(first, last + 1);
}

/** A share as the tables write it (one decimal, "12.3"). */
export function shareValue(share: number | null | undefined): ExcelValue {
  return share === null || share === undefined || !Number.isFinite(share) ? null : Math.round(share * 10) / 10;
}
