/**
 * The print pages drawn on a canvas, y-advance for y-advance as the Android till draws its
 * bitmaps (pos-android hardware/printer/ReceiptRenderer.kt, TillZRenderer.kt,
 * hardware/kitchen/KitchenTicketRenderer.kt, data/repo/KioskBonService.kt slip):
 *
 *  - the receipt, the pickup slip and the Z in the till's 384-dot design space, then scaled
 *    (bilinear, as Bitmap.createScaledBitmap) to the 540-dot content width of an 80 mm printer;
 *  - the kiosk bon natively at 576 dots (every size ×1.5);
 *  - Roboto for Latin and digits, Noto Sans Hebrew for Hebrew — the till's pair; text baselines
 *    as the till's; RTL: the label at the right edge, the value at the left.
 *
 * The 1-bit threshold and the ESC/POS bytes are the main process's (core/escpos.ts).
 */

import type { BonDoc, PrintDoc, ReceiptDoc, SlipDoc, ZDoc } from '../../core/printDocs';

const FONT = '"Roboto", "Noto Sans Hebrew", Arial, sans-serif';
const W = 384;
const PAD = 10;

type Ctx = CanvasRenderingContext2D;

function font(ctx: Ctx, size: number, weight: number | 'bold' | 'normal' = 'normal') {
  const w = weight === 'bold' ? 700 : weight === 'normal' ? 400 : weight;
  ctx.font = `${w} ${size}px ${FONT}`;
}

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: Ctx } {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.direction = 'rtl';
  ctx.textBaseline = 'alphabetic';
  return { c, ctx };
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The logo box (receiptLogoBox): never scaled up, ≤ 3/4 of the width, ≤ 120 tall. */
function logoBox(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, (W * 0.75) / w, 120 / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** The "R2M POS" wordmark when there is no logo (DocumentLogo.wordmark), as the till prints it. */
function drawWordmark(ctx: Ctx | null, y: number): number {
  const target = W * 0.6 * 0.75;
  const probe = canvas(10, 10).ctx;
  font(probe, 100, 900);
  const r2m = probe.measureText('R2M').width;
  font(probe, 100, 700);
  const pos = probe.measureText('POS').width;
  const size = (100 * target) / (r2m + pos + 0.28 * 100);
  const h = size * 1.2 + 9;
  if (ctx) {
    const total = ((r2m + pos) * size) / 100 + 0.28 * size;
    const x0 = (W - total) / 2;
    ctx.save();
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    font(ctx, size, 900);
    ctx.fillText('R2M', x0, y + size + 3);
    font(ctx, size, 700);
    ctx.fillText('POS', x0 + (r2m * size) / 100 + 0.28 * size, y + size + 3);
    ctx.restore();
  }
  return h;
}

/* ----------------------------------------------------------- the receipt */

const STYLES: Record<string, { size: number; bold: boolean }> = {
  title: { size: 30, bold: true },
  heading: { size: 24, bold: true },
  body: { size: 21, bold: false },
  bodyBold: { size: 21, bold: true },
  small: { size: 18, bold: false },
  grand: { size: 28, bold: true },
};

async function drawReceiptAt384(doc: ReceiptDoc): Promise<HTMLCanvasElement> {
  const logo = doc.logoUrl ? await loadImage(doc.logoUrl) : null;
  const run = (ctx: Ctx | null): number => {
    let y = 0;
    const line = (yy: number) => {
      if (!ctx) return;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PAD, yy);
      ctx.lineTo(W - PAD, yy);
      ctx.stroke();
    };
    for (const op of doc.ops) {
      switch (op.t) {
        case 'logo': {
          y += 8;
          if (logo) {
            const b = logoBox(logo.naturalWidth, logo.naturalHeight);
            if (ctx) {
              ctx.save();
              ctx.filter = 'grayscale(1)';
              ctx.drawImage(logo, (W - b.w) / 2, y, b.w, b.h);
              ctx.restore();
            }
            y += b.h + 10;
          } else {
            y += drawWordmark(ctx, y) + 10;
          }
          break;
        }
        case 'gap':
          y += op.h;
          break;
        case 'text': {
          const s = STYLES[op.style];
          y += s.size + 4;
          if (ctx) {
            font(ctx, s.size, s.bold ? 'bold' : 'normal');
            ctx.textAlign = op.align === 'center' ? 'center' : 'right';
            ctx.fillText(op.text, op.align === 'center' ? W / 2 : W - PAD, y);
          }
          break;
        }
        case 'row': {
          const s = STYLES[op.style];
          y += s.size + 4;
          if (ctx) {
            font(ctx, s.size, s.bold ? 'bold' : 'normal');
            ctx.textAlign = 'right';
            ctx.fillText(op.label, W - PAD, y);
            ctx.textAlign = 'left';
            ctx.fillText(op.value, PAD, y);
          }
          break;
        }
        case 'sub':
          y += 18 + 2;
          if (ctx) {
            font(ctx, 18);
            ctx.textAlign = 'right';
            ctx.fillText(op.label, W - PAD - 18, y);
            ctx.textAlign = 'left';
            ctx.fillText(op.value, PAD, y);
          }
          break;
        case 'divider':
          y += op.gap;
          line(y);
          y += 2;
          break;
        case 'footerRule':
          y += 14;
          line(y);
          y += 4;
          break;
        case 'end':
          y += 24;
          break;
      }
    }
    return Math.max(80, y);
  };
  const h = run(null);
  const { c, ctx } = canvas(W, h);
  run(ctx);
  return c;
}

/* ----------------------------------------------------------------- the Z */

async function drawZAt384(doc: ZDoc): Promise<HTMLCanvasElement> {
  const logo = doc.logoUrl ? await loadImage(doc.logoUrl) : null;
  const run = (ctx: Ctx | null): number => {
    let y = 8;
    if (logo) {
      const b = logoBox(logo.naturalWidth, logo.naturalHeight);
      if (ctx) ctx.drawImage(logo, (W - b.w) / 2, y, b.w, b.h);
      y += b.h + 10;
    } else y += drawWordmark(ctx, y) + 10;
    y += 10;
    for (const op of doc.ops) {
      if (op.t === 'centred') {
        y += op.size + 5;
        if (ctx) {
          font(ctx, op.size, op.bold ? 'bold' : 'normal');
          ctx.textAlign = 'center';
          ctx.fillText(op.text, W / 2, y);
        }
      } else if (op.t === 'row') {
        const size = op.bold ? 21 : 19;
        y += size + 5;
        if (ctx) {
          font(ctx, size, op.bold ? 'bold' : 'normal');
          ctx.textAlign = 'right';
          ctx.fillText(op.label, W - PAD, y);
          ctx.textAlign = 'left';
          ctx.fillText(op.value, PAD, y);
        }
      } else {
        y += 8;
        if (ctx) {
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(PAD, y);
          ctx.lineTo(W - PAD, y);
          ctx.stroke();
        }
        y += 3;
      }
    }
    return Math.max(120, y + 26);
  };
  const h = run(null);
  const { c, ctx } = canvas(W, h);
  run(ctx);
  return c;
}

/* --------------------------------------------------------- the pickup slip */

function drawSlipAt384(doc: SlipDoc): HTMLCanvasElement {
  const { c, ctx } = canvas(W, 330);
  ctx.textAlign = 'center';
  let y = 34;
  if (doc.businessName) {
    font(ctx, 24, 'bold');
    ctx.fillText(doc.businessName, W / 2, y);
    y += 34;
  }
  font(ctx, 26);
  ctx.fillText(doc.heading, W / 2, y);
  y += 112;
  const plain = doc.label.replace(/[⁦-⁩]/g, '');
  font(ctx, plain.length <= 4 ? 120 : 84, 'bold');
  ctx.fillText(doc.label, W / 2, y);
  y += 46;
  font(ctx, 30, 'bold');
  ctx.fillText(doc.service, W / 2, y);
  y += 38;
  font(ctx, 22);
  ctx.fillText(doc.summary, W / 2, y);
  y += 34;
  ctx.fillText(doc.footer, W / 2, y);
  return c;
}

/* --------------------------------------------------------------- the bon */

function wrap(ctx: Ctx, text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= max) cur = next;
    else {
      if (cur) lines.push(cur);
      if (ctx.measureText(w).width <= max) cur = w;
      else {
        // A word wider than the line: broken by characters.
        let part = '';
        for (const ch of w) {
          if (ctx.measureText(part + ch).width > max && part) {
            lines.push(part);
            part = ch;
          } else part += ch;
        }
        cur = part;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [''];
}

function drawBon(doc: BonDoc, w: number): HTMLCanvasElement {
  const s = w / 384;
  const pad = 15 * s;
  const box = w - 2 * pad;
  const run = (ctx: Ctx): number => {
    const draw = !!ctx.canvas.dataset.draw;
    let y = 6 * s;
    const fitSize = (text: string, max: number, min: number) => {
      let size = max;
      const longest = text.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), '');
      for (; size > min; size -= 2) {
        font(ctx, size * s, 'bold');
        if (ctx.measureText(longest).width <= box) break;
      }
      return size;
    };
    const centred = (text: string, size: number, bold: boolean) => {
      font(ctx, size * s, bold ? 'bold' : 'normal');
      for (const row of wrap(ctx, text, box)) {
        y += size * s + 6 * s;
        if (draw) {
          ctx.textAlign = 'center';
          ctx.fillText(row, w / 2, y);
        }
      }
    };
    const band = (text: string, size: number, filled: boolean) => {
      const top = y + 10 * s;
      const bottom = top + size * s + 20 * s;
      if (draw) {
        if (filled) {
          ctx.fillStyle = '#000';
          ctx.fillRect(pad, top, w - 2 * pad, bottom - top);
          ctx.fillStyle = '#FFF';
        } else {
          ctx.lineWidth = 5 * s;
          ctx.strokeRect(pad, top, w - 2 * pad, bottom - top);
        }
        font(ctx, size * s, 'bold');
        ctx.textAlign = 'center';
        ctx.fillText(text, w / 2, bottom - 13 * s);
        ctx.fillStyle = '#000';
      }
      y = bottom;
    };
    const divider = () => {
      y += 10 * s;
      if (draw) {
        ctx.lineWidth = 3 * s;
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(w - pad, y);
        ctx.stroke();
      }
      y += 6 * s;
    };
    centred(doc.title, fitSize(doc.title, 56, 30), true);
    centred(doc.sub, 24, true);
    if (doc.notice) band(doc.notice, fitSize(doc.notice, 38, 24), true);
    band(doc.dining === 'take_away' ? 'לקחת' : 'לשבת', 40, doc.dining === 'take_away');
    divider();
    for (const l of doc.lines) {
      y += 8 * s;
      font(ctx, 36 * s, 'bold');
      for (const row of wrap(ctx, `⁦${l.qty}⁩ × ${l.name}`, box)) {
        y += 36 * s + 6 * s;
        if (draw) {
          ctx.textAlign = 'right';
          ctx.fillText(row, w - pad, y);
        }
      }
      const subX = w - pad - 24 * s;
      const sub = (text: string, size: number, bold: boolean) => {
        font(ctx, size * s, bold ? 'bold' : 'normal');
        for (const row of wrap(ctx, text, box - 24 * s)) {
          y += size * s + 4 * s;
          if (draw) {
            ctx.textAlign = 'right';
            ctx.fillText(row, subX, y);
          }
        }
      };
      if (l.detail) sub(l.detail, 22, true);
      for (const mod of l.mods) sub(mod, 26, false);
      for (const r of l.removals) sub(r, 28, true);
      if (l.notes) {
        const top = y + 8 * s;
        sub(l.notes, 26, true);
        y += 8 * s;
        if (draw) {
          ctx.lineWidth = 2;
          ctx.strokeRect(pad, top, subX + 8 * s - pad, y - top);
        }
      }
      y += 4 * s;
    }
    divider();
    for (const f of doc.foot) centred(f, 20, false);
    if (doc.printerName) centred(doc.printerName, 24, true);
    return Math.max(120, y + 14 * s);
  };
  const probe = canvas(w, 10);
  const h = run(probe.ctx);
  const { c, ctx } = canvas(w, h);
  c.dataset.draw = '1';
  run(ctx);
  return c;
}

/* ------------------------------------------------------------- the entry */

function scaled(src: HTMLCanvasElement, width: number): HTMLCanvasElement {
  if (src.width === width) return src;
  const h = Math.round((src.height * width) / src.width);
  const { c, ctx } = canvas(width, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(src, 0, 0, width, h);
  return c;
}

let fontsReady: Promise<unknown> | null = null;

export function loadFonts(): Promise<unknown> {
  fontsReady ??= Promise.all([
    document.fonts.load(`400 20px "Noto Sans Hebrew"`, 'אב'),
    document.fonts.load(`700 20px "Noto Sans Hebrew"`, 'אב'),
    document.fonts.load(`900 20px "Noto Sans Hebrew"`, 'אב'),
    document.fonts.load(`400 20px "Roboto"`, 'R2'),
    document.fonts.load(`700 20px "Roboto"`, 'R2'),
    document.fonts.load(`900 20px "Roboto"`, 'R2'),
  ]).catch(() => undefined);
  return fontsReady;
}

/** A document → RGBA pixels at `widthDots` (540 for the receipt/slip/Z, 576 for the bon). */
export async function renderDoc(doc: PrintDoc, widthDots: number): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  await loadFonts();
  let page: HTMLCanvasElement;
  if (doc.kind === 'bon') page = drawBon(doc, widthDots);
  else if (doc.kind === 'receipt') page = scaled(await drawReceiptAt384(doc), widthDots);
  else if (doc.kind === 'slip') page = scaled(drawSlipAt384(doc), widthDots);
  else page = scaled(await drawZAt384(doc), widthDots);
  const data = page.getContext('2d')!.getImageData(0, 0, page.width, page.height).data;
  return { width: page.width, height: page.height, rgba: new Uint8Array(data.buffer.slice(0)) };
}
