/**
 * "דוח X סניפי" (P:/specs/shop-x-report.md): the report's shapes and the pure helpers the dashboard
 * renders its print document with — no network, so `npm test` runs them.
 */

/** One row of the print document. */
export type ShopXPrintRow = { label: string; value: string; emphasis: boolean };
export type ShopXPrintSection = { title: string; rows: ShopXPrintRow[] };
/** The print document, in the shape the till prints its X / Z with (`z_print`). */
export type ShopXPrintDocument = {
  title: string;
  number: null;
  businessName: string;
  subtitle: string[];
  sections: ShopXPrintSection[];
  footer: string[];
};
export type ShopXWarning = {
  machineId: string;
  label: string;
  text: string;
  pendingDocuments: number;
  staleSince: string | null;
};
export type ShopXReport = {
  kind: 'shop_x';
  title: string;
  headline: string;
  shopId: string;
  shopName: string;
  generatedAt: string;
  periodStart: string | null;
  warnings: ShopXWarning[];
  refresh: { requested: boolean; asked: number; answered: number; failed: number; waitedSec: number; timeoutSec: number };
  summary: Record<string, unknown>;
  tills: Record<string, unknown>[];
  employees: Record<string, unknown>[];
};
export type ShopXResponse = { available: boolean; report: ShopXReport; printDocument: ShopXPrintDocument };

/** A till's own section starts with "קופה " or "קיוסק " — folded on screen (§4). The drawer block is "קופה". */
export function isTillSection(title: string): boolean {
  return /^(קופה|קיוסק)\s/.test(title);
}

/** The document's sections for the screen: the summary and the tills; the warnings are shown apart. */
export function splitSections(doc: ShopXPrintDocument): { summary: ShopXPrintSection[]; tills: ShopXPrintSection[] } {
  const body = doc.sections.filter((s) => !s.title.startsWith('אזהרות'));
  return { summary: body.filter((s) => !isTillSection(s.title)), tills: body.filter((s) => isTillSection(s.title)) };
}

/** The strip as a printable page (80 mm, RTL): what "הדפס" opens. */
export function printableHtml(doc: ShopXPrintDocument): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const sections = doc.sections
    .map(
      (s) =>
        `<h3>${esc(s.title)}</h3><table>${s.rows
          .map((r) => `<tr${r.emphasis ? ' class="b"' : ''}><td>${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`)
          .join('')}</table>`,
    )
    .join('');
  return (
    `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>${esc(doc.title)}</title>` +
    '<style>body{font-family:sans-serif;width:72mm;margin:0 auto;font-size:12px}h1{font-size:16px;text-align:center}' +
    'h3{font-size:13px;border-bottom:1px solid #000;margin:8px 0 2px}table{width:100%}td:last-child{text-align:left}' +
    '.b td{font-weight:bold}p{margin:2px 0;text-align:center}</style></head><body>' +
    `<h1>${esc(doc.title)}</h1><p>${esc(doc.businessName)}</p>${doc.subtitle.map((l) => `<p>${esc(l)}</p>`).join('')}` +
    `${sections}<hr>${doc.footer.map((l) => `<p>${esc(l)}</p>`).join('')}</body></html>`
  );
}
