/**
 * The menu as a spreadsheet ("ייבוא פריטים מאקסל") — pos-server app/routers/catalog_import.py.
 *
 * Download the blank template or the current catalog, preview an upload row by row, commit
 * it, and make a 7-day link that lets a customer download the blank template without a
 * login. The server's messages (`msg`, row texts) are already Hebrew and shown as they are.
 */
import { api } from './api';

export type ImportRowStatus = 'create' | 'update' | 'unchanged' | 'error';
export type ImportLevel = 'error' | 'warning' | 'info';

export interface ImportMessage {
  level: ImportLevel;
  /** With its row: "שורה 7: מחיר חסר". */
  text: string;
  /** Without it, for a row that shows its number itself. */
  message: string;
  sheet: 'products' | 'categories' | null;
  row: number | null;
}

export interface ImportChange {
  field: string;
  label: string;
  before: string | number;
  after: string | number;
}

export interface ImportProductRow {
  row: number;
  status: ImportRowStatus;
  name: string;
  category: string;
  price: string | null;
  matchedBy: 'barcode' | 'sku' | 'name' | null;
  productId: string | null;
  changes: ImportChange[];
  messages: ImportMessage[];
}

export interface ImportCategoryRow {
  /** Null for a category made because another row names it. */
  row: number | null;
  status: ImportRowStatus;
  name: string;
  parent: string;
  implicitFrom: number | null;
  categoryId: string | null;
  changes: ImportChange[];
  messages: ImportMessage[];
}

export interface ImportSummary {
  productsNew: number;
  productsUpdated: number;
  productsUnchanged: number;
  categoriesNew: number;
  categoriesUpdated: number;
  categoriesUnchanged: number;
  routingChanges: number;
  routingShops: number;
  errors: number;
  warnings: number;
  examplesSkipped: number;
}

export interface ImportPreview {
  companyId: string;
  companyName: string;
  fileKind: 'xlsx' | 'csv';
  fileName: string;
  /** Binds the commit to this file and this plan (2 hours). */
  token: string;
  summary: ImportSummary;
  /** File-level messages (a missing column, an unknown header, printers not set up). */
  issues: ImportMessage[];
  products: ImportProductRow[];
  categories: ImportCategoryRow[];
  canCommit: boolean;
}

export interface ImportResult {
  productsCreated: number;
  productsUpdated: number;
  categoriesCreated: number;
  categoriesUpdated: number;
  costsUpdated: number;
  routingChanges: number;
  skippedErrorRows: number;
  machinesNotified: number;
}

export interface CatalogImportSummary {
  companyId: string;
  companyName: string;
  products: number;
  categories: number;
  shops: number;
  printers: { name: string; shopName: string; isActive: boolean }[];
}

export interface ShareLink {
  token: string;
  /** Relative to the API root (`/public/catalog-template/…`). */
  path: string;
  /** As the server sees itself; `link` is the one to send. */
  url: string;
  expiresAt: string;
  companyName: string;
  /** The link to send the customer. */
  link: string;
}

/** `{ code, msg }` from the server, or null. */
export function importErrorDetail(err: unknown): { code?: string; msg?: string; preview?: ImportPreview } | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    return detail as { code?: string; msg?: string; preview?: ImportPreview };
  }
  return null;
}

/** A blob response's error, which axios leaves as a Blob. */
async function blobError(err: unknown): Promise<Error> {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { detail?: { msg?: string } | string };
      const msg = typeof parsed.detail === 'string' ? parsed.detail : parsed.detail?.msg;
      if (msg) return new Error(msg);
    } catch {
      // not JSON: fall through
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function companyParams(companyId?: string | null): Record<string, string> {
  return companyId ? { companyId } : {};
}

export async function fetchCatalogImportSummary(companyId?: string | null): Promise<CatalogImportSummary> {
  const { data } = await api.get<CatalogImportSummary>('/catalog-import/summary', {
    params: companyParams(companyId),
  });
  return data;
}

/** The blank template (pre-filled with categories and printers) or, with data, the catalog. */
export async function downloadCatalogTemplate(
  options: { companyId?: string | null; withData: boolean; format?: 'xlsx' | 'csv' },
  fileName: string,
): Promise<void> {
  try {
    const { data } = await api.get<Blob>('/catalog-import/template', {
      params: { ...companyParams(options.companyId), withData: options.withData, format: options.format ?? 'xlsx' },
      responseType: 'blob',
    });
    saveBlob(data, fileName);
  } catch (err) {
    throw await blobError(err);
  }
}

export async function previewCatalogImport(file: File, companyId?: string | null): Promise<ImportPreview> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<ImportPreview>('/catalog-import/preview', form, {
    params: companyParams(companyId),
    // Let the browser set multipart/form-data with its own boundary.
    headers: { 'Content-Type': undefined },
    timeout: 120_000,
  });
  return data;
}

export async function commitCatalogImport(
  file: File,
  options: { companyId?: string | null; token?: string; skipErrors?: boolean },
): Promise<ImportResult> {
  const form = new FormData();
  form.append('file', file);
  if (options.token) form.append('token', options.token);
  form.append('skipErrors', options.skipErrors ? 'true' : 'false');
  const { data } = await api.post<ImportResult>('/catalog-import/commit', form, {
    params: companyParams(options.companyId),
    headers: { 'Content-Type': undefined },
    timeout: 300_000,
  });
  return data;
}

export async function createCatalogShareLink(companyId?: string | null): Promise<ShareLink> {
  const { data } = await api.post<Omit<ShareLink, 'link'>>('/catalog-import/share-link', null, {
    params: companyParams(companyId),
  });
  // The dashboard's own API address is the one the customer can reach; the server's
  // idea of itself may be an internal one behind a proxy.
  const base = (api.defaults.baseURL ?? '').replace(/\/+$/, '');
  const link = /^https?:\/\//.test(base) ? `${base}${data.path}` : data.url;
  return { ...data, link };
}
