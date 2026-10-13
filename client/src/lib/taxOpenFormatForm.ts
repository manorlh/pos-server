/**
 * The tax authority's open format page (app/dashboard/tax-reports, "מבנה אחיד") in the URL: the
 * range (the report framework's `from` / `to`), and the export mode and tax year as its extras
 * (lib/reportFilters.ts) — so a link opens the same form. It never starts the export.
 *
 * `taxOpenFormatParams` is the request the page has always sent (`TaxOpenFormatParams` in
 * lib/api.ts, same keys in the same order): the shop when the scope has one, else the company.
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
