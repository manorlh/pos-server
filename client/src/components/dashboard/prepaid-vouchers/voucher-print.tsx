'use client';

/**
 * The printed prepaid voucher ("שובר הפקה") in the dashboard — the on-screen preview and the
 * browser's print. Each voucher is an SVG drawn from lib/voucherLayout.ts, the port of the
 * server's app/services/prepaid_voucher_layout.py: the server's PDF (Pillow) runs the very same
 * layout, measured in the very same fonts (Heebo, Geist Mono — public/fonts/voucher, the
 * server's app/assets/fonts), and a shared golden fixture pins the two, so the preview, the
 * print and the PDF file can never disagree.
 *
 * * **Print** goes through a print-only frame with its own `@page` (the page size picked: an
 *   80×50 ticket, a 54×86 card, A6 … one voucher per page, or an A4 sheet of eight to cut), so
 *   a ticket printer driver gets exactly its media size.
 * * **PDF / ZIP** files are drawn by the server (the page asks for them).
 *
 * The barcode — a QR, or a Code 128 line barcode when the batch asks for one (`barcodeType`) —
 * carries only `PV:<code>`. Under it: the code in monospace when the batch says so (`showCode`),
 * then the short service number ("מס׳ 0008", and the group in a run made in groups). The goods
 * (or a discount's benefit) in a framed box unless the batch hides them (`showItems: false`);
 * "נוצר על ידי Runner Systems" at the bottom unless `showCredit: false`. Pure black throughout.
 */

import { useEffect, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { formatDate, isoDate } from '@/lib/format';
import type { PrepaidVoucher, PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { cardContents, isDiscountKind } from '@/lib/prepaidVoucherBenefit';
import { quantityText } from '@/lib/prepaidVoucherProducts';
import { code128Bars } from '@/lib/barcode128';
import { VOUCHER_TEXT, layoutCard, type CardContent, type Measure, type VoucherOp } from '@/lib/voucherLayout';

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
  return { pageW: p.w, pageH: p.h, cols, rows, cardW: p.w / cols, cardH: p.h / rows, cutLines: cols * rows > 1 };
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function mm(n: number): string {
  return `${Math.round(n * 100) / 100}mm`;
}

// ── Fonts: the server's, served from public/fonts/voucher ─────────────────────

const SANS = 'R2M Voucher Sans';
const MONO = 'R2M Voucher Mono';
const SANS_STACK = `"${SANS}", Heebo, Arial, sans-serif`;
const MONO_STACK = `"${MONO}", Consolas, "Courier New", monospace`;
const FONT_FILES = [
  { family: SANS, file: 'Heebo-Regular.ttf', weight: '400', format: 'truetype' },
  { family: SANS, file: 'Heebo-Bold.ttf', weight: '700', format: 'truetype' },
  { family: MONO, file: 'GeistMono-latin.woff2', weight: '100 900', format: 'woff2' },
];

function fontUrl(file: string): string {
  return `${window.location.origin}/fonts/voucher/${file}`;
}

/** The @font-face rules a print frame needs (it does not share the page's fonts). */
function fontFaceCss(): string {
  return FONT_FILES.map(
    (f) => `@font-face { font-family: "${f.family}"; src: url("${fontUrl(f.file)}") format("${f.format}"); font-weight: ${f.weight}; }`,
  ).join('\n');
}

let fontsLoading: Promise<void> | null = null;

/** Loads the voucher's fonts into this document once: the layout measures text in them. */
export function ensureVoucherFonts(): Promise<void> {
  if (!fontsLoading) {
    fontsLoading = Promise.all(
      FONT_FILES.map(async (f) => {
        const face = new FontFace(f.family, `url("${fontUrl(f.file)}") format("${f.format}")`, { weight: f.weight });
        await face.load();
        document.fonts.add(face);
      }),
    ).then(() => undefined);
    fontsLoading.catch(() => {
      fontsLoading = null;
    });
  }
  return fontsLoading;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();

/** Text width in mm, measured by the browser in the voucher's fonts (as the server measures in its). */
export const browserMeasure: Measure = (text, size, bold, mono) => {
  const key = `${mono ? 'm' : bold ? 'b' : 'r'}|${text}`;
  let ref = widths.get(key);
  if (ref === undefined) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    if (!measureCtx) return text.length * size * 0.5;
    measureCtx.font = `${bold || mono ? 700 : 400} 100px "${mono ? MONO : SANS}"`;
    ref = measureCtx.measureText(text).width;
    widths.set(key, ref);
  }
  return (ref / 100) * size;
};

/** True once the fonts are in: before that the preview shows a placeholder, not a mis-measured card. */
export function useVoucherFonts(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    ensureVoucherFonts().then(
      () => live && setReady(true),
      () => live && setReady(true), // offline / blocked: the fallback faces, still a voucher
    );
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

// ── What a voucher says (the server's `card_content`) ─────────────────────────

/** The small print: goods one-time / in parts, a discount voucher its uses (as the server's PDF). */
export function termsLine(batch: PrepaidVoucherBatch): string {
  if (isDiscountKind(batch.kind)) {
    const n = batch.usesPerVoucher ?? 1;
    return n === 1 ? VOUCHER_TEXT.usesOne : VOUCHER_TEXT.usesMany.replace('{n}', String(n));
  }
  const terms = batch.splitAllowed ? VOUCHER_TEXT.splitAllowed : VOUCHER_TEXT.oneTime;
  return batch.includeExtras ? `${terms} · ${VOUCHER_TEXT.includeExtras}` : terms;
}

function day(iso: string | null | undefined): string | null {
  return isoDate(iso) ? formatDate(iso) : null;
}

/** The validity line printed on the voucher, or null without dates. */
export function validityLine(batch: Pick<PrepaidVoucherBatch, 'validFrom' | 'validUntil'>): string | null {
  const since = day(batch.validFrom);
  const until = day(batch.validUntil);
  if (since && until) return VOUCHER_TEXT.validBetween.replace('{since}', since).replace('{until}', until);
  if (until) return VOUCHER_TEXT.validUntil.replace('{until}', until);
  if (since) return VOUCHER_TEXT.validFrom.replace('{since}', since);
  return null;
}

type CardVoucher = Pick<PrepaidVoucher, 'serial' | 'displayCode' | 'qrPayload'> & { groupNo?: number | null };

/** The short service number under the barcode: "מס׳ 0008", "מס׳ 0021 · קבוצה 3". */
export function serialLine(voucher: CardVoucher): string {
  let serial = VOUCHER_TEXT.serial.replace('{n}', String(voucher.serial).padStart(4, '0'));
  if (voucher.groupNo) serial += ` · ${VOUCHER_TEXT.group.replace('{g}', String(voucher.groupNo))}`;
  return serial;
}

export function cardContentOf(batch: PrepaidVoucherBatch, voucher: CardVoucher, logo: boolean): CardContent {
  const { benefit, items } = cardContents(batch);
  return {
    title: batch.eventName || batch.name,
    terms: termsLine(batch),
    serial: serialLine(voucher),
    barcode: batch.barcodeType ?? 'qr',
    logo,
    benefit,
    items: items.map((i) => [quantityText(i.quantity, i.weighed, i.unitLabel), i.name, !!i.weighed]),
    freeText: batch.freeText,
    validity: validityLine(batch),
    code: batch.showCode ? voucher.displayCode : null,
    credit: batch.showCredit === false ? null : VOUCHER_TEXT.credit,
    moreItems: VOUCHER_TEXT.moreItems,
  };
}

// ── Drawing the operations ────────────────────────────────────────────────────

function anchorOf(op: Extract<VoucherOp, { op: 'text' }>): 'start' | 'middle' | 'end' {
  if (op.align === 'center') return 'middle';
  // With direction rtl, "start" is the right edge.
  if (op.align === 'right') return op.rtl ? 'start' : 'end';
  return op.rtl ? 'end' : 'start';
}

function Code128Svg({ value, x, y, w, h }: { value: string; x: number; y: number; w: number; h: number }) {
  const { bars, width: modules } = code128Bars(value);
  return (
    <svg x={x} y={y} width={w} height={h} viewBox={`0 0 ${modules} 10`} preserveAspectRatio="none" shapeRendering="crispEdges">
      <rect x={0} y={0} width={modules} height={10} fill="#fff" />
      {bars.map(([bx, bw]) => (
        <rect key={bx} x={bx} y={0} width={bw} height={10} fill="#000" />
      ))}
    </svg>
  );
}

/** One voucher as an SVG of its size in mm. Attributes only: it is printed outside the app's CSS. */
function VoucherSvg({
  w, h, ops, payload, logoSrc, cutLines,
}: { w: number; h: number; ops: VoucherOp[]; payload: string; logoSrc: string | null; cutLines: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="pv-card"
      width={mm(w)}
      height={mm(h)}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: 'block', background: '#fff' }}
    >
      <rect x={0} y={0} width={w} height={h} fill="#fff" />
      {ops.map((op, i) => {
        switch (op.op) {
          case 'text':
            return (
              <text
                key={i}
                x={op.x}
                y={op.y}
                fontSize={op.size}
                fontFamily={op.mono ? MONO_STACK : SANS_STACK}
                fontWeight={op.bold || op.mono ? 700 : 400}
                fill="#000"
                direction={op.rtl ? 'rtl' : 'ltr'}
                unicodeBidi="embed"
                textAnchor={anchorOf(op)}
              >
                {op.text}
              </text>
            );
          case 'box':
            // Pillow strokes inside the rectangle; an SVG stroke is centred on it.
            return (
              <rect
                key={i}
                x={op.x + op.stroke / 2}
                y={op.y + op.stroke / 2}
                width={op.w - op.stroke}
                height={op.h - op.stroke}
                rx={Math.max(0, op.radius - op.stroke / 2)}
                fill="none"
                stroke="#000"
                strokeWidth={op.stroke}
              />
            );
          case 'qr':
            return <QRCodeSVG key={i} value={payload} size={op.side} x={op.x} y={op.y} level="M" marginSize={2} />;
          case 'code128':
            return <Code128Svg key={i} value={payload} x={op.x} y={op.y} w={op.w} h={op.h} />;
          case 'logo':
            return logoSrc ? (
              <image
                key={i}
                href={logoSrc}
                x={op.x}
                y={op.y}
                width={op.w}
                height={op.h}
                preserveAspectRatio={op.align === 'right' ? 'xMaxYMid meet' : 'xMidYMid meet'}
              />
            ) : null;
          default:
            return null;
        }
      })}
      {cutLines ? (
        <rect x={0.1} y={0.1} width={w - 0.2} height={h - 0.2} fill="none" stroke="#000" strokeWidth={0.2} strokeDasharray="1.2 1.2" />
      ) : null}
    </svg>
  );
}

type CardGeometry = Pick<Geometry, 'cardW' | 'cardH' | 'cutLines'>;

function VoucherCard({
  batch, voucher, g, logoSrc, measure = browserMeasure,
}: { batch: PrepaidVoucherBatch; voucher: CardVoucher; g: CardGeometry; logoSrc: string | null; measure?: Measure }) {
  const ops = layoutCard(g.cardW, g.cardH, cardContentOf(batch, voucher, !!logoSrc), measure);
  return <VoucherSvg w={g.cardW} h={g.cardH} ops={ops} payload={voucher.qrPayload} logoSrc={logoSrc} cutLines={g.cutLines} />;
}

/** One voucher as SVG markup, laid out with [measure] (the browser's by default; the fonts loaded). */
export function voucherCardMarkup(
  batch: PrepaidVoucherBatch, voucher: CardVoucher, g: CardGeometry, logoSrc: string | null, measure: Measure = browserMeasure,
): string {
  return renderToStaticMarkup(<VoucherCard batch={batch} voucher={voucher} g={g} logoSrc={logoSrc} measure={measure} />);
}

export function voucherCss(g: Geometry): string {
  return `${fontFaceCss()}
@page { size: ${mm(g.pageW)} ${mm(g.pageH)}; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pv-page { width: ${mm(g.pageW)}; height: ${mm(g.pageH)}; display: grid; overflow: hidden; background: #fff;
  grid-template-columns: repeat(${g.cols}, ${mm(g.cardW)}); grid-template-rows: repeat(${g.rows}, ${mm(g.cardH)});
  direction: rtl; break-after: page; page-break-after: always; }
.pv-page:last-child { break-after: auto; page-break-after: auto; }`;
}

type PrintableVoucher = Pick<PrepaidVoucher, 'id' | 'serial' | 'displayCode' | 'qrPayload'> & { groupNo?: number | null };

/** The vouchers in pages of `cols × rows`. */
function pagesOf<T>(items: T[], perPage: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) out.push(items.slice(i, i + perPage));
  return out;
}

export function voucherPageHtml(batch: PrepaidVoucherBatch, vouchers: PrintableVoucher[], g: Geometry, logoSrc: string | null): string {
  return renderToStaticMarkup(
    <div className="pv-page">
      {vouchers.map((v) => (
        <VoucherCard key={v.id} batch={batch} voucher={v} g={g} logoSrc={logoSrc} />
      ))}
    </div>,
  );
}

/** On-screen preview of one voucher, at its printed size — the same SVG the print sends. */
export function VoucherPreview({
  batch, voucher, layout,
}: { batch: PrepaidVoucherBatch; voucher: PrintableVoucher; layout: PrintLayout }) {
  const ready = useVoucherFonts();
  const g = { ...geometryOf(layout), cutLines: false };
  return (
    <div className="inline-block bg-white shadow-sm ring-1 ring-foreground/10" dir="rtl">
      {ready ? (
        <VoucherCard batch={batch} voucher={voucher} g={g} logoSrc={batch.logoUrl} />
      ) : (
        <div style={{ width: mm(g.cardW), height: mm(g.cardH) }} aria-busy="true" />
      )}
    </div>
  );
}

/** The logo as a data URL, so print never waits for (or loses) a network image. */
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

/** Print through a frame of its own, waiting for its fonts and images before opening the dialog. */
export async function printVouchers(
  batch: PrepaidVoucherBatch,
  vouchers: PrintableVoucher[],
  layout: PrintLayout,
  title: string,
): Promise<void> {
  const g = geometryOf(layout);
  await ensureVoucherFonts().catch(() => undefined);
  const logo = await logoDataUrl(batch.logoUrl);
  const body = pagesOf(vouchers, g.cols * g.rows)
    .map((page) => voucherPageHtml(batch, page, g, logo))
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
    Promise.all([
      ...FONT_FILES.map((f) => doc.fonts.load(`${f.weight === '700' ? 700 : 400} 10px "${f.family}"`).catch(() => [])),
      ...Array.from(doc.images).map((img) =>
        img.complete ? Promise.resolve() : new Promise<void>((r) => { img.onload = img.onerror = () => r(); }),
      ),
    ]).then(() => doc.fonts.ready),
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
