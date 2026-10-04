'use client';

/**
 * A Z as the till prints it: the server's print document (`ZPrintDoc`, built by
 * `app/services/z_print.py` — the same one the Android till prints) laid out on 80 mm.
 *
 * One HTML builder serves the screen preview and the paper, so what is previewed is
 * what prints. Printing goes through a hidden iframe with its own `@page 80mm auto`:
 * the dashboard's own print stylesheet is A4 (globals.css), and a roll printer needs
 * neither its margins nor its page height. "PDF" is the same window — the browser's
 * "Save as PDF" destination — titled so the file gets a sensible name.
 */

import type { ZPrintDoc } from '@/lib/types';

const escape = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The receipt's own stylesheet — scoped by class, so it can sit on a dashboard page. */
export const TILL_RECEIPT_CSS = `
.ztr { box-sizing: border-box; width: 80mm; max-width: 100%; padding: 4mm 4mm 6mm; background: #fff; color: #000;
  font-family: "Courier New", "Noto Sans Mono", "Arial Hebrew", Arial, monospace; font-size: 12px; line-height: 1.35;
  direction: rtl; text-align: right; }
.ztr * { box-sizing: border-box; }
.ztr-c { text-align: center; }
.ztr-biz { font-weight: 700; font-size: 15px; }
.ztr-title { font-weight: 700; font-size: 17px; margin-top: 4px; }
.ztr-sub { font-size: 11px; }
.ztr-sec { border-top: 1px dashed #000; margin-top: 5px; padding-top: 3px; }
.ztr-sec-t { font-weight: 700; text-align: center; margin-bottom: 1px; }
.ztr-row { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.ztr-row .ztr-l { overflow: hidden; }
.ztr-row .ztr-v { white-space: nowrap; unicode-bidi: plaintext; font-variant-numeric: tabular-nums; }
.ztr-em { font-weight: 700; }
.ztr-foot { border-top: 1px dashed #000; margin-top: 6px; padding-top: 3px; text-align: center; font-size: 11px; }
.ztr-cut { border: 0; border-top: 1px dashed #000; margin: 6mm 0; }
`;

/** One Z on 80 mm, as HTML (every string escaped). */
export function tillReceiptHtml(doc: ZPrintDoc): string {
  const sub = doc.subtitle.map((line) => `<div class="ztr-sub">${escape(line)}</div>`).join('');
  const title = doc.number != null ? `${doc.title} #${doc.number}` : doc.title;
  const sections = doc.sections
    .map((s) => {
      const rows = s.rows
        .map(
          (r) =>
            `<div class="ztr-row${r.emphasis ? ' ztr-em' : ''}"><span class="ztr-l">${escape(r.label)}</span>` +
            `<span class="ztr-v">${escape(r.value)}</span></div>`,
        )
        .join('');
      return `<div class="ztr-sec">${s.title ? `<div class="ztr-sec-t">${escape(s.title)}</div>` : ''}${rows}</div>`;
    })
    .join('');
  const footer = doc.footer.map((line) => `<div>${escape(line)}</div>`).join('');
  return (
    `<div class="ztr" dir="rtl"><div class="ztr-c"><div class="ztr-biz">${escape(doc.businessName)}</div>` +
    `<div class="ztr-title">${escape(title)}</div>${sub}</div>${sections}` +
    `<div class="ztr-foot">${footer}</div></div>`
  );
}

/** The screen preview of one Z on 80 mm paper. */
export function ZTillReceipt({ doc }: { doc: ZPrintDoc }) {
  return (
    <div className="inline-block rounded border bg-white shadow-sm">
      <style>{TILL_RECEIPT_CSS}</style>
      <div dangerouslySetInnerHTML={{ __html: tillReceiptHtml(doc) }} />
    </div>
  );
}

/**
 * Print HTML in a print-only frame, not the dashboard page: its own `@page` and nothing
 * else on it. Resolves once the dialog has been handed the document.
 */
export function printInFrame({ title, bodyHtml, css }: { title: string; bodyHtml: string; css: string }): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'fixed';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.style.insetInlineEnd = '0';
    frame.style.bottom = '0';
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    const doc = win?.document;
    if (!win || !doc) {
      frame.remove();
      resolve();
      return;
    }
    doc.open();
    doc.write(
      `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${escape(title)}</title>` +
        `<style>${css}</style></head><body>${bodyHtml}</body></html>`,
    );
    doc.close();
    // The parent's title names the PDF in most browsers; the frame's in the rest.
    const parentTitle = document.title;
    document.title = title;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.title = parentTitle;
      // Removing the frame during the dialog cancels it in some browsers.
      window.setTimeout(() => frame.remove(), 1000);
      resolve();
    };
    win.addEventListener('afterprint', cleanup);
    window.setTimeout(() => {
      win.focus();
      win.print();
      // `print()` blocks until the dialog closes where `afterprint` is not fired.
      window.setTimeout(cleanup, 500);
    }, 100);
  });
}

/** Zs on a roll: one after another, a cut line and a page break between them. */
export function printTillReceipts(docs: ZPrintDoc[], title: string): Promise<void> {
  const bodyHtml = docs
    .map((d, i) => (i === 0 ? '' : '<hr class="ztr-cut" style="break-before: page; page-break-before: always">') + tillReceiptHtml(d))
    .join('');
  const css = `@page { size: 80mm auto; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
${TILL_RECEIPT_CSS}
@media print { .ztr { width: 80mm; } }`;
  return printInFrame({ title, bodyHtml, css });
}

/** The file / tab name for a set of Zs: "Z-12", or "Z-3-9". */
export function zPrintTitle(numbers: (number | null | undefined)[]): string {
  const known = numbers.filter((n): n is number => n != null).sort((a, b) => a - b);
  if (known.length === 0) return 'Z';
  if (known.length === 1) return `Z-${known[0]}`;
  return `Z-${known[0]}-${known[known.length - 1]}`;
}
