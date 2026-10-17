/**
 * The tax authority's open format page (app/dashboard/tax-reports, "מבנה אחיד") in the URL: the
 * range (the report framework's `from` / `to`), and the export mode and tax year as its extras
 * (lib/reportFilters.ts) — so a link opens the same form. It never starts the export.
 *
 * `taxOpenFormatParams` is the request the page has always sent (`TaxOpenFormatParams` in
 * lib/api.ts, same keys in the same order): the shop when the scope has one, else the company.
 *
 * The production report ("דוח הפקה", 1.31 §2.6) the download carries (`decodeProductionReport`).
 *
 * Pure (tested in reportFramework.test.ts).
 */

export type TaxOpenFormatMode = 'date-range' | 'year';

/** The extras' defaults; the year's is this year (business time), given by the page. */
export function taxOpenFormatExtras(currentYear: string): { mode: TaxOpenFormatMode; year: string } {
  return { mode: 'date-range', year: currentYear };
}

/** The mode in the URL / draft; anything else is the date range. */
export function taxOpenFormatMode(raw: string | undefined): TaxOpenFormatMode {
  return raw === 'year' ? 'year' : 'date-range';
}

/** What `/reports/tax/openformat(/preview)` takes (lib/api.ts `TaxOpenFormatParams`). */
export interface TaxOpenFormatRequest {
  scope: 'shop' | 'company';
  shopId?: string;
  companyId?: string;
  mode: TaxOpenFormatMode;
  from?: string;
  to?: string;
  year?: number;
}

/**
 * The request, or null while something is missing: no shop or company in scope, no year, no
 * range — or a range that ends before it starts, or a year that is not a number (a hand-edited
 * link), which the server would only refuse.
 */
export function taxOpenFormatParams(form: {
  shopId: string;
  companyId: string;
  mode: TaxOpenFormatMode;
  from: string;
  to: string;
  year: string;
}): TaxOpenFormatRequest | null {
  const scope: 'shop' | 'company' = form.shopId ? 'shop' : 'company';
  const entityReady = scope === 'shop' ? Boolean(form.shopId) : Boolean(form.companyId);
  if (!entityReady) return null;
  const base: TaxOpenFormatRequest = {
    scope,
    mode: form.mode,
    ...(scope === 'shop' ? { shopId: form.shopId } : { companyId: form.companyId }),
  };
  if (form.mode === 'year') {
    if (!form.year) return null;
    const year = parseInt(form.year, 10);
    return Number.isFinite(year) ? { ...base, year } : null;
  }
  if (!form.from || !form.to || form.from > form.to) return null;
  return { ...base, from: form.from, to: form.to };
}

/**
 * The production report of an open-format file (1.31 §2.6, pos-server
 * app/services/open_format/production_report.py): what the software prints at the end of a
 * production, and what the Tax Authority's simulator asks to be typed in — per document type
 * the count and Σ 1223, per record type the count. Amounts are shekel strings ("179.80").
 */
export interface OpenFormatProductionReport {
  title: string;
  business: { vatNumber: string; name: string; address: string; city: string };
  software: {
    name: string;
    version: string;
    registrationNumber: string;
    manufacturerName: string;
    manufacturerVatNumber: string;
  };
  /** A000 1004 / A100 / Z900. */
  primaryId: string;
  /** A000 1012; blank when no drive is configured. */
  outputPath: string;
  fileName: string | null;
  files: string[];
  taxYear?: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  producedDate: string | null;
  producedTime: string | null;
  documents: {
    code: number;
    name: string;
    count: number;
    total: string;
    cancelledCount: number;
    cancelledTotal: string;
  }[];
  documentsCount: number;
  records: { code: string; name: string; count: number }[];
  recordsTotal: number;
  payments: { code: number; name: string; count: number; total: string }[];
  unmappedTenders: { method: string; count: number }[];
}

/** The download's `X-Open-Format-Report` header (base64 of UTF-8 JSON), or null if absent / unreadable. */
export function decodeProductionReport(header: string | null | undefined): OpenFormatProductionReport | null {
  if (!header) return null;
  try {
    const binary = atob(header);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    return parsed && Array.isArray(parsed.documents) && Array.isArray(parsed.records) ? parsed : null;
  } catch {
    return null;
  }
}

/** `2026-09-03` → `03/09/2026`, as the report prints dates; anything else as is. */
export function reportDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso ?? '';
}
