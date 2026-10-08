/**
 * The home page's comparisons, events, vouchers card and opening page — server
 * `app/routers/reports.py` (`/reports/compare`, `/reports/side-by-side`,
 * `/reports/event-options`, `/reports/prepaid-vouchers`) and `app/routers/users.py`
 * (`/users/me/preferences`). Kept out of `api.ts` so the types sit next to the calls.
 */
import { api } from './api';
import type { FiguresLike, SideKind } from './periodCompare';
import type { ReportWindowOut } from './types';

export type CompareFigures = FiguresLike;

export interface CompareDelta {
  abs: number;
  /** Null from zero ("new"). */
  pct: number | null;
}

export interface CompareSeriesPoint {
  index: number;
  label: string;
  currentDate?: string | null;
  previousDate?: string | null;
  current: number | null;
  previous: number | null;
  currentDocuments: number;
  previousDocuments: number;
}

export interface EventBrief {
  id: string;
  name: string;
  shopId: string;
  shopName?: string | null;
  companyId?: string | null;
  startsAt: string;
  endsAt: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  timezone: string;
  status: 'draft' | 'confirmed' | string;
  machineIds: string[];
}

export interface CompareItem {
  key: string;
  productId?: string | null;
  name?: string | null;
  sku?: string | null;
  qty: number;
  net: number;
  previousQty?: number | null;
  previousNet?: number | null;
}

export interface PeriodCompareReport {
  window: ReportWindowOut;
  compareWindow?: ReportWindowOut | null;
  granularity: 'hour' | 'day';
  alignment: 'clock' | 'elapsed';
  generatedAt: string;
  event?: EventBrief | null;
  compareEvent?: EventBrief | null;
  current: CompareFigures;
  previous?: CompareFigures | null;
  deltas?: Record<keyof CompareFigures, CompareDelta> | null;
  series: CompareSeriesPoint[];
  topItems: CompareItem[];
}

/** Where a comparison looks: the scope narrowed by the board's filters. */
export interface CompareScope {
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
}

export interface PeriodCompareParams extends CompareScope {
  from?: string;
  to?: string;
  cmpFrom?: string;
  cmpTo?: string;
  eventId?: string;
  cmpEventId?: string;
  granularity?: 'hour' | 'day';
  items?: number;
}

export async function fetchPeriodCompare(params: PeriodCompareParams): Promise<PeriodCompareReport> {
  const { data } = await api.get<PeriodCompareReport>('/reports/compare', { params });
  return data;
}

export interface SideBySideEntity {
  id: string;
  name?: string | null;
  number?: string | null;
  found: boolean;
  figures: CompareFigures;
  series: (number | null)[];
}

export interface SideBySideReport {
  window: ReportWindowOut;
  kind: SideKind;
  granularity: 'hour' | 'day';
  alignment: 'clock' | 'elapsed';
  generatedAt: string;
  event?: EventBrief | null;
  buckets: string[];
  entities: SideBySideEntity[];
}

export async function fetchSideBySide(params: {
  kind: SideKind;
  ids: string[];
  from?: string;
  to?: string;
  eventId?: string;
  companyId?: string;
}): Promise<SideBySideReport> {
  const { data } = await api.get<SideBySideReport>('/reports/side-by-side', {
    params,
    // FastAPI reads a repeated list as `ids=a&ids=b`, never axios' default `ids[]=`.
    paramsSerializer: { indexes: null },
  });
  return data;
}

export async function fetchEventOptions(params: { q?: string; shopId?: string } = {}): Promise<EventBrief[]> {
  const { data } = await api.get<{ events: EventBrief[] }>('/reports/event-options', { params });
  return data.events ?? [];
}

export interface VoucherUsage {
  vouchers: number;
  redemptions: number;
  units: number;
  value: number;
}

export interface VoucherUsageRow {
  batchId: string;
  name: string;
  kind: 'items' | 'order_discount' | 'item_discount' | string;
  current: VoucherUsage;
  previous?: VoucherUsage | null;
  deltas?: Record<keyof VoucherUsage, CompareDelta> | null;
}

export interface VoucherBoardReport {
  window: ReportWindowOut;
  compareWindow?: ReportWindowOut | null;
  totals: VoucherUsage;
  previous?: VoucherUsage | null;
  deltas?: Record<keyof VoucherUsage, CompareDelta> | null;
  rows: VoucherUsageRow[];
}

export async function fetchVoucherBoard(
  params: CompareScope & { from?: string; to?: string; cmpFrom?: string; cmpTo?: string; eventId?: string; cmpEventId?: string },
): Promise<VoucherBoardReport> {
  const { data } = await api.get<VoucherBoardReport>('/reports/prepaid-vouchers', { params });
  return data;
}

export interface MyPreferences {
  homePage: string;
  homePages: string[];
  simpleMode: boolean;
  simpleModeDefault: boolean;
}

export async function updateMyPreferences(body: { homePage?: string | null; simpleMode?: boolean | null }): Promise<MyPreferences> {
  const { data } = await api.put<MyPreferences>('/users/me/preferences', body);
  return data;
}
