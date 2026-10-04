'use client';

/**
 * A server print document (`GET /transactions/{id}/print-document`) on 80 mm, RTL.
 *
 * The layout is the Z till view's (`z-till-receipt.tsx`): the same receipt stylesheet,
 * the same HTML builder and the same print-only frame with its own
 * `@page { size: 80mm auto; margin: 0 }` — so a reprinted invoice, a card voucher and a
 * Z come off the roll looking alike, and the dashboard's A4 print stylesheet is never
 * involved. What this adds is the copy mark: every document here is a reprint, and it
 * says so under its title in a box that cannot be missed.
 *
 * "PDF" is the same frame — the browser's "Save as PDF" destination — titled so the
 * file gets a sensible name.
 */

import {
  TILL_RECEIPT_CSS,
  printInFrame,
  tillReceiptHtml,
} from '@/components/dashboard/z-report/z-till-receipt';

export interface PrintDocumentRow {
  label: string;
  value: string;
  emphasis: boolean;
}

export interface PrintDocumentSection {
  title: string;
  rows: PrintDocumentRow[];
}

/** One slip as the server describes it. `copyMark` is set on every reprint ("העתק"). */
export interface PrintDocument {
  title: string;
  copyMark: string | null;
  businessName: string;
  subtitle: string[];
  sections: PrintDocumentSection[];
  footer: string[];
}

/** Several slips (every card voucher of a document). */
export interface PrintDocumentList {
  documents: PrintDocument[];
}

const escape = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const COPY_CSS = `
.rpd-copy { margin: 4px auto 2px; padding: 1px 0; width: 60%; border: 2px solid #000; text-align: center;
  font-weight: 700; font-size: 16px; letter-spacing: 2px; }
.rpd-copy-top { width: 80mm; max-width: 100%; }
`;

/** The receipt stylesheet plus the copy mark's. */
export const RECEIPT_PRINT_CSS = `${TILL_RECEIPT_CSS}${COPY_CSS}`;

/** One document on 80 mm, as HTML (every string escaped). */
export function receiptPrintHtml(doc: PrintDocument): string {
  const html = tillReceiptHtml({ ...doc, number: null });
  if (!doc.copyMark) return html;
  const mark = `<div class="rpd-copy">${escape(doc.copyMark)}</div>`;
  const titled = /(<div class="ztr-title">[\s\S]*?<\/div>)/;
  // Under the title when the layout has one; above the slip otherwise — never dropped.
  return titled.test(html)
    ? html.replace(titled, `$1${mark}`)
    : `<div class="rpd-copy-top">${mark}</div>${html}`;
}

/** The screen preview of one document on 80 mm paper. */
export function ReceiptPrintDocument({ doc }: { doc: PrintDocument }) {
  return (
    <div className="inline-block rounded border bg-white shadow-sm">
      <style>{RECEIPT_PRINT_CSS}</style>
      <div dangerouslySetInnerHTML={{ __html: receiptPrintHtml(doc) }} />
    </div>
  );
}

/** The response of the endpoint, single or several, as a list. */
export function printDocumentsOf(body: PrintDocument | PrintDocumentList): PrintDocument[] {
  return 'documents' in body ? body.documents : [body];
}

/** Documents on a roll: one after another, a cut line and a page break between them. */
export function printReceiptDocuments(docs: PrintDocument[], title: string): Promise<void> {
  const bodyHtml = docs
    .map(
      (d, i) =>
        (i === 0 ? '' : '<hr class="ztr-cut" style="break-before: page; page-break-before: always">') +
        receiptPrintHtml(d),
    )
    .join('');
  const css = `@page { size: 80mm auto; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
${RECEIPT_PRINT_CSS}
@media print { .ztr { width: 80mm; } }`;
  return printInFrame({ title, bodyHtml, css });
}
