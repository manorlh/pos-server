'use client';

/**
 * The printed prepaid voucher ("שובר הפקה") — one markup for the on-screen preview, the
 * ticket/card printer and the PDF file, so the three can never disagree.
 *
 * * **Print** goes through a print-only frame with its own `@page` (the page size picked:
 *   an 80×50 ticket, a 54×86 card, A6 … one voucher per page, or an A4 sheet of eight to
 *   cut), so a ticket printer driver gets exactly its media size.
 * * **PDF** is a real .pdf file made in the browser: each page is rendered by the browser
 *   (so Hebrew is shaped and laid out right-to-left exactly as on screen and on paper),
 *   rasterised at ~300 dpi and placed on a page of the same size with jsPDF. Text in
 *   the file is therefore an image — fine for printing, not for copy-paste.
 *
 * The QR carries only `PV:<code>`; the code is printed under it for typing by hand.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import type { PrepaidVoucher, PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';

export type PagePresetId = 'ticket80x50' | 'card86x54' | 'card54x86' | 'ticket80x120' | 'a6' | 'a4grid' | 'custom';

export interface PrintLayout {
  preset: PagePresetId;
  /** Only for `custom`, in mm. */
  width?: number;
  height?: number;
}

interface Geometry {
  /** Page, mm. */
  pageW: number;
  pageH: number;
  cols: number;
  rows: number;
  /** One voucher, mm. */
  cardW: number;
  cardH: number;
  /** Dashed cut lines around each voucher (sheets of several). */
  cutLines: boolean;
}

export const PAGE_PRESETS: { id: PagePresetId; w: number; h: number; cols?: number; rows?: number }[] = [
  { id: 'ticket80x50', w: 80, h: 50 },
  { id: 'card86x54', w: 86, h: 54 },
  { id: 'card54x86', w: 54, h: 86 },
  { id: 'ticket80x120', w: 80, h: 120 },
  { id: 'a6', w: 105, h: 148 },
  { id: 'a4grid', w: 210, h: 297, cols: 2, rows: 4 },
];

export function geometryOf(layout: PrintLayout): Geometry {
  if (layout.preset === 'custom') {
    const w = clamp(layout.width ?? 80, 30, 300);
    const h = clamp(layout.height ?? 50, 30, 300);
    return { pageW: w, pageH: h, cols: 1, rows: 1, cardW: w, cardH: h, cutLines: false };
  }
  const p = PAGE_PRESETS.find((x) => x.id === layout.preset) ?? PAGE_PRESETS[0];
  const cols = p.cols ?? 1;
  const rows = p.rows ?? 1;
  return {
    pageW: p.w,
    pageH: p.h,
    cols,
    rows,
    cardW: p.w / cols,
    cardH: p.h / rows,
    cutLines: cols * rows > 1,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function mm(n: number): string {
  return `${Math.round(n * 100) / 100}mm`;
}

export interface VoucherLabels {
  serial: (n: string) => string;
  splitAllowed: string;
  oneTime: string;
}

/** One voucher, sized `cardW`×`cardH` mm. Inline styles only: it is printed outside the app's CSS. */
function VoucherCard({
  batch,
  voucher,
  g,
  logoSrc,
  labels,
}: {
  batch: PrepaidVoucherBatch;
  voucher: Pick<PrepaidVoucher, 'serial' | 'displayCode' | 'qrPayload'>;
  g: Geometry;
  logoSrc: string | null;
  labels: VoucherLabels;
}) {
  const w = g.cardW;
  const h = g.cardH;
  const landscape = w >= h * 1.15;
  const s = Math.min(w, h) / 50; // 1 at a 50 mm short side
  const pad = 2.6 * s;
  const n = batch.items.length;
  const itemFont = 3.1 * s * (n > 4 ? Math.max(0.55, Math.sqrt(4 / n)) : 1);
  const serialText = labels.serial(String(voucher.serial).padStart(4, '0'));
  const qrSide = landscape
    ? Math.min(h - 2 * pad - 5.5 * s, w * 0.42)
    : Math.min(w - 2 * pad, h * 0.38);

  const title = batch.eventName || batch.name;
  const text = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: mm(1.1 * s), minWidth: 0, flex: 1, overflow: 'hidden', alignSelf: 'stretch' }}>
      {logoSrc ? (
        // A plain <img>: this markup is printed and rasterised outside Next's image pipeline.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoSrc}
          alt=""
          style={{
            maxHeight: mm((landscape ? 9 : 12) * s),
            maxWidth: '100%',
            objectFit: 'contain',
            alignSelf: landscape ? 'flex-start' : 'center',
            display: 'block',
          }}
        />
      ) : null}
      <div style={{ fontWeight: 700, fontSize: mm(4 * s), lineHeight: 1.15, textAlign: landscape ? 'start' : 'center' }}>
        {title}
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: mm(itemFont), lineHeight: 1.25 }}>
        {batch.items.map((i) => (
          <li key={i.productId} style={{ display: 'flex', gap: mm(1.2 * s) }}>
            <span style={{ fontWeight: 700, minWidth: mm(4 * s), direction: 'ltr', textAlign: 'end' }}>
              {i.quantity}×
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
          </li>
        ))}
      </ul>
      {batch.freeText ? (
        <div style={{ fontSize: mm(2.5 * s), lineHeight: 1.2, whiteSpace: 'pre-wrap' }}>{batch.freeText}</div>
      ) : null}
      <div style={{ fontSize: mm(2.1 * s), color: '#444' }}>
        {batch.splitAllowed ? labels.splitAllowed : labels.oneTime}
      </div>
    </div>
  );
  const qr = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: mm(0.6 * s), flexShrink: 0 }}>
      <div style={{ width: mm(qrSide), height: mm(qrSide), background: '#fff' }}>
        <QRCodeSVG value={voucher.qrPayload} size={256} level="M" marginSize={2} style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
      {/* The serial only: the code is never printed — the till redeems by camera, so a
          code to type would only be a way to copy the voucher. */}
      <div style={{ fontSize: mm(2.2 * s), fontWeight: 700 }}>{serialText}</div>
    </div>
  );

  return (
    <div
      className="pv-card"
      dir="rtl"
      style={{
        width: mm(w),
        height: mm(h),
        boxSizing: 'border-box',
        padding: mm(pad),
        display: 'flex',
        flexDirection: landscape ? 'row' : 'column',
        alignItems: landscape ? 'stretch' : 'center',
        gap: mm(2 * s),
        overflow: 'hidden',
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, "Segoe UI", "Noto Sans Hebrew", sans-serif',
        outline: g.cutLines ? '0.2mm dashed #999' : undefined,
        outlineOffset: g.cutLines ? '-0.1mm' : undefined,
      }}
    >
      {text}
      {qr}
    </div>
  );
}

export function voucherCss(g: Geometry): string {
  return `@page { size: ${mm(g.pageW)} ${mm(g.pageH)}; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pv-page { width: ${mm(g.pageW)}; height: ${mm(g.pageH)}; display: grid; overflow: hidden; background: #fff;
  grid-template-columns: repeat(${g.cols}, ${mm(g.cardW)}); grid-template-rows: repeat(${g.rows}, ${mm(g.cardH)});
  break-after: page; page-break-after: always; }
.pv-page:last-child { break-after: auto; page-break-after: auto; }
.pv-card * { box-sizing: border-box; }`;
}

type PrintableVoucher = Pick<PrepaidVoucher, 'id' | 'serial' | 'displayCode' | 'qrPayload'>;

/** The vouchers in pages of `cols × rows`. */
function pagesOf<T>(items: T[], perPage: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) out.push(items.slice(i, i + perPage));
  return out;
}

export function voucherPageHtml(
  batch: PrepaidVoucherBatch,
  vouchers: PrintableVoucher[],
  g: Geometry,
  logoSrc: string | null,
  labels: VoucherLabels,
): string {
  return renderToStaticMarkup(
    <div className="pv-page">
      {vouchers.map((v) => (
        <VoucherCard key={v.id} batch={batch} voucher={v} g={g} logoSrc={logoSrc} labels={labels} />
      ))}
    </div>,
  );
}

/** On-screen preview of one voucher, at its printed size. */
export function VoucherPreview({
  batch,
  voucher,
  layout,
  labels,
}: {
  batch: PrepaidVoucherBatch;
  voucher: PrintableVoucher;
  layout: PrintLayout;
  labels: VoucherLabels;
}) {
  const g = geometryOf(layout);
  return (
    <div className="inline-block bg-white shadow-sm ring-1 ring-foreground/10">
      <VoucherCard batch={batch} voucher={voucher} g={{ ...g, cutLines: false }} logoSrc={batch.logoUrl} labels={labels} />
    </div>
  );
}

/** The logo as a data URL, so print and PDF never wait for (or lose) a network image. */
async function logoDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return url;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return url;
  }
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'vouchers';
}

/** Print through a frame of its own, waiting for its images before opening the dialog. */
export async function printVouchers(
  batch: PrepaidVoucherBatch,
  vouchers: PrintableVoucher[],
  layout: PrintLayout,
  labels: VoucherLabels,
  title: string,
): Promise<void> {
  const g = geometryOf(layout);
  const logo = await logoDataUrl(batch.logoUrl);
  const body = pagesOf(vouchers, g.cols * g.rows)
    .map((page) => voucherPageHtml(batch, page, g, logo, labels))
    .join('');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', bottom: '0' });
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const doc = win?.document;
  if (!win || !doc) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(
    `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>${voucherCss(g)}</style></head><body>${body}</body></html>`,
  );
  doc.close();
  await Promise.race([
    Promise.all(
      Array.from(doc.images).map((img) =>
        img.complete ? Promise.resolve() : new Promise<void>((r) => { img.onload = img.onerror = () => r(); }),
      ),
    ),
    new Promise((r) => window.setTimeout(r, 5000)),
  ]);
  const parentTitle = document.title;
  document.title = title;
  await new Promise<void>((resolve) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.title = parentTitle;
      window.setTimeout(() => frame.remove(), 1000);
      resolve();
    };
    win.addEventListener('afterprint', cleanup);
    window.setTimeout(() => {
      win.focus();
      win.print();
      window.setTimeout(cleanup, 500);
    }, 50);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * A real .pdf of the vouchers, one page per page of the layout, downloaded as
 * `<fileName>.pdf`. `onProgress(done, total)` after each page.
 */
export async function exportVouchersPdf(
  batch: PrepaidVoucherBatch,
  vouchers: PrintableVoucher[],
  layout: PrintLayout,
  labels: VoucherLabels,
  fileName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const [{ jsPDF }, { toJpeg }] = await Promise.all([import('jspdf'), import('html-to-image')]);
  const g = geometryOf(layout);
  const logo = await logoDataUrl(batch.logoUrl);
  const pages = pagesOf(vouchers, g.cols * g.rows);

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, { position: 'fixed', top: '0', left: '-10000px', zIndex: '-1', background: '#fff' });
  host.dir = 'rtl';
  const style = document.createElement('style');
  style.textContent = voucherCss(g).replace(/@page[^}]*}/, '');
  host.appendChild(style);
  const slot = document.createElement('div');
  host.appendChild(slot);
  document.body.appendChild(host);

  const orientation = g.pageW > g.pageH ? 'landscape' : 'portrait';
  const pdf = new jsPDF({ unit: 'mm', format: [g.pageW, g.pageH], orientation, compress: true });
  // ~300 dpi: 96 css px per inch × 3.125.
  const pixelRatio = 3.125;
  try {
    for (let i = 0; i < pages.length; i++) {
      slot.innerHTML = voucherPageHtml(batch, pages[i], g, logo, labels);
      const node = slot.firstElementChild as HTMLElement;
      await Promise.all(
        Array.from(node.querySelectorAll('img')).map((img) =>
          img.complete ? Promise.resolve() : new Promise<void>((r) => { img.onload = img.onerror = () => r(); }),
        ),
      );
      const data = await toJpeg(node, { pixelRatio, quality: 0.92, backgroundColor: '#ffffff', skipFonts: true, cacheBust: false });
      if (i > 0) pdf.addPage([g.pageW, g.pageH], orientation);
      pdf.addImage(data, 'JPEG', 0, 0, g.pageW, g.pageH, undefined, 'FAST');
      onProgress?.(i + 1, pages.length);
      // Let the page breathe now and then during a long batch (not every page: a
      // background tab clamps timers to a second).
      if (i % 10 === 9) await new Promise((r) => window.setTimeout(r, 0));
    }
    pdf.save(`${safeFileName(fileName)}.pdf`);
  } finally {
    host.remove();
  }
}
