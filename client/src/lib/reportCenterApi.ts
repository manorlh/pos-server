/**
 * The report center's endpoints (docs/SPEC_REPORTS.md): the transactions export, the
 * consolidated Z table, "דוח שמכיל הכל", the reconciliation and the transmissions across
 * tills. Lists go as repeated params (`machineIds=a&machineIds=b`) — FastAPI ignores the
 * axios default `machineIds[]=a`, which would silently drop the filter.
 */
import { api } from '@/lib/api';

import type {
  AllInOneReport,
  Reconciliation,
  TransactionExportRow,
  TransmissionsReport,
  ZTable,
} from './reportCenterTypes';

export * from './reportCenterTypes';

const repeated = { paramsSerializer: { indexes: null } } as const;

export type Params = Record<string, string | number | string[] | number[] | undefined | null>;

function clean(params: Params): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export async function fetchTransactionsExport(params: Params): Promise<{ total: number; items: TransactionExportRow[] }> {
  const { data } = await api.get('/transactions/export', { params: clean(params), ...repeated });
  return data;
}

export async function fetchZTable(params: Params): Promise<ZTable> {
  const { data } = await api.get('/report-center/z-table', { params: clean(params), ...repeated });
  return data;
}

export async function fetchAllInOne(params: Params): Promise<AllInOneReport> {
  const { data } = await api.get('/report-center/all-in-one', { params: clean(params), ...repeated });
  return data;
}

export async function fetchReconciliation(params: Params): Promise<Reconciliation> {
  const { data } = await api.get('/report-center/reconciliation', { params: clean(params), ...repeated });
  return data;
}

export async function fetchTransmissionsReport(params: Params): Promise<TransmissionsReport> {
  const { data } = await api.get('/report-center/transmissions', { params: clean(params), ...repeated });
  return data;
}
