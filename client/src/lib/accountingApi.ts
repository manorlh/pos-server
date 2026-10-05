/**
 * Accounting export (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2): server `app/routers/accounting.py`.
 */
import { api } from './api';

export const ACCOUNT_KEYS = [
  'cash',
  'card',
  'cardDeclined',
  'vouchers',
  'otherTenders',
  'incomeTaxable',
  'incomeExempt',
  'vatOutput',
  'tips',
  'voucherSales',
  'cashOverShort',
  'rounding',
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

/** Needed by every export; the rest only when a Z has that line. */
export const CORE_ACCOUNT_KEYS: AccountKey[] = ['cash', 'card', 'incomeTaxable', 'vatOutput'];

export type AccountingEncoding = 'cp1255' | 'cp862';
export type AccountingMethod = 'flexible' | 'detailed';
export type AccountingFormat = 'hashavshevet' | 'priority' | 'excel';
export type AccountingGrouping = 'z' | 'day' | 'month';

export interface AccountingSettingsValues {
  movementType?: string;
  branchCode?: string;
  encoding?: AccountingEncoding;
  method?: AccountingMethod;
  accounts?: Partial<Record<AccountKey, string>>;
  cardBrands?: Record<string, string>;
  /** Card receipts per acquirer (חברת סליקה); wins over `cardBrands` for a leg. */
  cardAcquirers?: Record<string, string>;
  voucherSalesAsLiability?: boolean;
  /** company — one file; shop — a file per shop. The company's choice. */
  exportLevel?: AccountingExportLevel;
  /** Company level: one entry for all shops, each line with its shop's cost centre. */
  consolidate?: boolean;
  /** The shop's cost centre (מרכז רווח); falls back to its branch code. */
  costCenter?: string;
}

export type AccountingExportLevel = 'company' | 'shop';

export interface AccountingSettings {
  companyId: string;
  shopId?: string | null;
  company: AccountingSettingsValues;
  shop?: AccountingSettingsValues | null;
  effective: Required<Omit<AccountingSettingsValues, 'accounts' | 'cardBrands' | 'cardAcquirers'>> & {
    accounts: Partial<Record<AccountKey, string>>;
    cardBrands: Record<string, string>;
    cardAcquirers: Record<string, string>;
  };
  missing: string[];
  accountKeys: AccountKey[];
  updatedAt?: string | null;
}

export interface ExportedRef {
  batchId: string;
  batchNumber: number;
  createdAt: string;
  level?: AccountingExportLevel;
}

export interface AccountingZRow {
  id: string;
  shopId?: string | null;
  shopName?: string | null;
  shopSequenceNumber?: number | null;
  businessDate: string;
  closedAt: string;
  netSales?: number | null;
  vatTotal?: number | null;
  exported: ExportedRef[];
}

export interface JournalLine {
  side: 'D' | 'C';
  key: string;
  account?: string | null;
  amount: string | number;
  label: string;
  /** A consolidated company entry: the line's shop cost centre and shop. */
  branch?: string | null;
  shopName?: string | null;
}

export interface JournalEntry {
  shopId?: string | null;
  shopName: string;
  reference1: number;
  reference2: string;
  entryDate: string;
  details: string;
  branch: string;
  movementType: string;
  zIds: string[];
  totalDebit: string | number;
  totalCredit: string | number;
  lines: JournalLine[];
}

export interface ExportProblem {
  code: 'missing_mapping' | 'unbalanced' | 'vat_unknown' | 'account_too_long' | string;
  zId?: string | null;
  zNumber?: number | null;
  shopName: string;
  detail: string;
}

export interface ExportRequest {
  companyId: string;
  zReportIds: string[];
  format: AccountingFormat;
  method?: AccountingMethod;
  encoding?: AccountingEncoding;
  grouping: AccountingGrouping;
  /** Default: the company's `exportLevel`. */
  level?: AccountingExportLevel;
  consolidate?: boolean;
  confirmReexport?: boolean;
}

export interface ExportPreview {
  entries: JournalEntry[];
  problems: ExportProblem[];
  alreadyExported: string[];
}

export interface ExportBatch {
  id: string;
  batchNumber: number;
  companyId: string;
  companyName?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  format: AccountingFormat;
  method: AccountingMethod;
  encoding: AccountingEncoding;
  grouping: AccountingGrouping;
  level?: AccountingExportLevel;
  dateFrom?: string | null;
  dateTo?: string | null;
  zCount: number;
  entryCount: number;
  lineCount: number;
  totalDebit: string | number;
  isReexport: boolean;
  fileName: string;
  createdBy?: string | null;
  createdAt: string;
  zReportIds: string[];
  /** Every batch the same request wrote (one per shop for a per-shop export). */
  groupBatches?: ExportBatchRef[];
}

export interface ExportBatchRef {
  id: string;
  batchNumber: number;
  shopId?: string | null;
  shopName?: string | null;
  fileName: string;
}

/** 409 `already_exported`: per batch that already holds a chosen Z, its level. */
export interface AlreadyExportedBatch {
  batchNumber: number;
  level: AccountingExportLevel;
  shopId?: string | null;
}

export async function fetchAccountingSettings(companyId: string, shopId?: string | null) {
  const { data } = await api.get<AccountingSettings>('/accounting/settings', {
    params: { companyId, ...(shopId ? { shopId } : {}) },
  });
  return data;
}

export async function saveAccountingSettings(body: {
  companyId: string;
  shopId?: string | null;
  settings: AccountingSettingsValues;
}) {
  const { data } = await api.put<AccountingSettings>('/accounting/settings', body);
  return data;
}

export async function fetchAccountingZs(params: {
  companyId: string;
  shopId?: string;
  from?: string;
  to?: string;
  onlyUnexported?: boolean;
}) {
  const { data } = await api.get<{ items: AccountingZRow[]; truncated: boolean }>(
    '/accounting/z-reports',
    { params },
  );
  return data;
}

export async function previewAccountingExport(body: ExportRequest) {
  const { data } = await api.post<ExportPreview>('/accounting/preview', body);
  return data;
}

export async function createAccountingExport(body: ExportRequest) {
  const { data } = await api.post<ExportBatch>('/accounting/exports', body);
  return data;
}

export async function fetchAccountingExports(companyId: string, shopId?: string) {
  const { data } = await api.get<{ items: ExportBatch[] }>('/accounting/exports', {
    params: { companyId, ...(shopId ? { shopId } : {}) },
  });
  return data.items;
}

export async function downloadAccountingExport(batch: Pick<ExportBatch, 'id' | 'fileName'>) {
  const { data } = await api.get<Blob>(`/accounting/exports/${batch.id}/download`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = batch.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Several batches (a per-shop export) in one zip. */
export async function downloadAccountingExportBundle(ids: string[]) {
  const { data, headers } = await api.get<Blob>('/accounting/exports/bundle', {
    params: { ids: ids.join(',') },
    responseType: 'blob',
  });
  const disposition = String(headers['content-disposition'] ?? '');
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'accounting_batches.zip';
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
