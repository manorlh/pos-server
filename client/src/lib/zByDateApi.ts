/**
 * `GET /z-reports/by-date/summary` and `/month` (pos-server app/routers/z_by_date.py): the Zs of a
 * day, a range or a month, by the date they were produced (default) or their business date.
 * Lists go as repeated params (`zTypes=a&zTypes=b`): FastAPI ignores axios' `zTypes[]=a`.
 */
import { api } from '@/lib/api';

import type { ZByDateMonth, ZByDateSummary, ZDateBasis } from './zByDate';

export type ZByDateFilters = {
  dateBasis?: ZDateBasis;
  shopId?: string;
  machineIds?: string[];
  areaId?: string;
  zTypes?: string[];
  origin?: 'cloud' | 'till';
};

const repeated = { paramsSerializer: { indexes: null } } as const;

function clean(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** The Zs of `from`..`to` (one day when equal): lines, grand totals, by shop / area / kind / day. */
export async function fetchZSummaryByDate(
  params: ZByDateFilters & { from: string; to: string; closedFrom?: string; closedTo?: string },
): Promise<ZByDateSummary> {
  const { data } = await api.get<ZByDateSummary>('/z-reports/by-date/summary', { params: clean(params), ...repeated });
  return data;
}

/** The Zs of a month ("2026-10"), each with its documents by document month. */
export async function fetchZMonthByDate(params: ZByDateFilters & { month: string }): Promise<ZByDateMonth> {
  const { data } = await api.get<ZByDateMonth>('/z-reports/by-date/month', { params: clean(params), ...repeated });
  return data;
}
