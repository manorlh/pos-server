/**
 * The printed prepaid voucher ("שובר הפקה"), laid out — a line-by-line port of the server's
 * app/services/prepaid_voucher_layout.py. The server draws the result with Pillow into its
 * PDF; the dashboard draws it as an SVG (components/dashboard/prepaid-vouchers/voucher-print.tsx).
 * Only the text measure differs (each engine measures Heebo / Geist Mono itself); the shared
 * golden fixture server/tests/fixtures/prepaid_voucher_layout.json pins that both produce the
 * same operations for the same voucher, so the two can never disagree.
 *
 * The design: logo (optional), the title large, what the voucher gives in a framed box (unless
 * hidden), free text, validity in a strong line, terms; the QR / Code 128 large with a quiet
 * zone, the code in monospace, the short service number prominent ("מס׳ 0008"); "נוצר על ידי
 * Runner Systems" at the very bottom (`showCredit`). RTL, pure black (thermal heads).
 *
 * All measures in mm from the card's top left; a text op's `y` is its baseline.
 */

/** measure(text, sizeMm, bold, mono) → width in mm. */
export type Measure = (text: string, size: number, bold: boolean, mono: boolean) => number;

// Every size is × s (1 at a 50 mm short side); text and its spaces at most × TEXT_SCALE_MAX.
export const TEXT_SCALE_MAX = 1.6;
const MARGIN = 2.8;
const GAP = 1.5;
const QUIET = 1.0;
const TITLE_PORTRAIT = 4.4;
const TITLE_LANDSCAPE = 4.0;
const TITLE_LH = 1.15;
const TITLE_LINES = 2;
const LOGO_PORTRAIT = 10.0;
const LOGO_LANDSCAPE = 8.0;
const LOGO_GAP = 1.2;
const BOX_PAD = 1.4;
const BOX_STROKE = 0.35;
const BOX_STROKE_MIN = 0.3;
const BOX_RADIUS = 1.2;
const ITEM = 3.1;
const ITEM_LH = 1.3;
const ITEM_MIN = 0.62;
const QTY_GAP = 1.2;
const BENEFIT = 3.3;
const BENEFIT_LH = 1.2;
const BENEFIT_LINES = 3;
const FREE = 2.5;
const FREE_LH = 1.25;
const FREE_MAX_LINES = 12;
const FREE_RESERVE = 2;
const VALID = 2.6;
const TERMS = 2.1;
const SMALL_LH = 1.25;
const QR_PORTRAIT_MIN = 0.26;
const QR_PORTRAIT_MAX = 0.5;
const QR_LANDSCAPE = 0.4;
const CODE = 2.5;
const SERIAL = 3.2;
const UNDER_GAP = 0.8;
const UNDER_LH = 1.25;
const CREDIT = 1.7;
const CREDIT_LH = 1.25;
const CREDIT_GAP = 0.8;
const BASE = 0.8;

/** The paper's words — the server's `Labels` (prepaid_voucher_pdf.py), pinned by the fixture. */
export const VOUCHER_TEXT = {
  serial: 'מס׳ {n}',
  group: 'קבוצה {g}',
  splitAllowed: 'ניתן לממש בחלקים',
  oneTime: 'מימוש חד-פעמי',
  validUntil: 'בתוקף עד {until}',
  validFrom: 'בתוקף מ-{since}',
  validBetween: 'בתוקף {since}-{until}',
  usesOne: 'שימוש אחד',
  usesMany: '{n} שימושים',
  includeExtras: 'כולל תוספות',
  moreItems: 'ועוד {n} פריטים',
  credit: 'נוצר על ידי Runner Systems',
} as const;

export interface CardContent {
  title: string;
  terms: string;
  serial: string;
  /** 'code128': a line barcode across the bottom; anything else a QR. */
  barcode?: string;
  logo?: boolean;
  /** A discount voucher's benefit; null for goods. */
  benefit?: string | null;
  /** Goods as [quantity label, name, quantity is RTL text] — "2×", or "0.5 ק״ג" (RTL). */
  items?: [string, string, boolean][];
  freeText?: string | null;
  validity?: string | null;
  code?: string | null;
  credit?: string | null;
  moreItems?: string;
}

export type Align = 'right' | 'center' | 'left';
export interface TextOp { op: 'text'; text: string; x: number; y: number; size: number; bold: boolean; mono: boolean; align: Align; rtl: boolean }
export interface BoxOp { op: 'box'; x: number; y: number; w: number; h: number; stroke: number; radius: number }
export interface QrOp { op: 'qr'; x: number; y: number; side: number }
export interface Code128Op { op: 'code128'; x: number; y: number; w: number; h: number }
export interface LogoOp { op: 'logo'; x: number; y: number; w: number; h: number; align: 'right' | 'center' }
export type VoucherOp = TextOp | BoxOp | QrOp | Code128Op | LogoOp;

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function text(
  t: string, x: number, y: number, size: number,
  o: { bold?: boolean; mono?: boolean; align?: Align; rtl?: boolean } = {},
): TextOp {
  return { op: 'text', text: t, x, y, size, bold: !!o.bold, mono: !!o.mono, align: o.align ?? 'right', rtl: o.rtl ?? true };
}

/** [t], cut with "…" (in logical order) to fit [maxW]. */
export function fit(measure: Measure, t: string, size: number, bold: boolean, maxW: number, mono = false): string {
  if (measure(t, size, bold, mono) <= maxW) return t;
  let cut = Array.from(t);
  while (cut.length && measure(cut.join('') + '…', size, bold, mono) > maxW) cut = cut.slice(0, -1);
  return cut.join('') + '…';
}

/** Python's str.splitlines(). */
function splitLines(t: string): string[] {
  return t.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
}

/** Word-wrapped lines (its own line breaks kept), at most [maxLines], the last cut with "…". */
export function wrap(measure: Measure, t: string, size: number, bold: boolean, maxW: number, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const lines: string[] = [];
  for (const para of splitLines(t || '')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || measure(candidate, size, bold, false) <= maxW) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  const out = lines.slice(0, maxLines).map((l) => fit(measure, l, size, bold, maxW));
  if (lines.length > maxLines && out.length) out[out.length - 1] = fit(measure, lines[maxLines - 1] + '…', size, bold, maxW);
  return out;
}

interface Row { kind: 'benefit' | 'item' | 'more'; text: string; size: number; lh: number; qty?: string; qtyRtl?: boolean }

function textBlock(
  c: CardContent, measure: Measure,
  { left, right, area, landscape, t }: { left: number; right: number; area: number; landscape: boolean; t: number },
): [VoucherOp[], number] {
  const col = right - left;
  const gap = GAP * t;
  const align: Align = landscape ? 'right' : 'center';
  const ax = landscape ? right : (left + right) / 2;
  const ops: VoucherOp[] = [];

  const logoH = c.logo ? (landscape ? LOGO_LANDSCAPE : LOGO_PORTRAIT) * t : 0;
  const logoPart = c.logo ? logoH + LOGO_GAP * t : 0;
  const titleSize = (landscape ? TITLE_LANDSCAPE : TITLE_PORTRAIT) * t;
  const title = wrap(measure, c.title, titleSize, true, col, TITLE_LINES);
  const titleH = title.length * titleSize * TITLE_LH;
  const validSize = VALID * t;
  const termsSize = TERMS * t;
  const footerH = (c.validity ? validSize * SMALL_LH : 0) + termsSize * SMALL_LH;
  const freeSize = FREE * t;
  const freeLh = freeSize * FREE_LH;
  const freeAll = c.freeText ? wrap(measure, c.freeText, freeSize, false, col, FREE_MAX_LINES) : [];
  const avail = area - logoPart - titleH - gap - footerH;
  const pad = BOX_PAD * t;
  const inner = col - 2 * pad;

  let rows: Row[] = [];
  let boxH = 0;
  let qtyW = 0;
  const items = c.items ?? [];
  if (c.benefit) {
    const bSize = BENEFIT * t;
    rows = wrap(measure, c.benefit, bSize, true, inner, BENEFIT_LINES).map((x) => ({ kind: 'benefit', text: x, size: bSize, lh: bSize * BENEFIT_LH }));
    boxH = rows.reduce((sum, row) => sum + row.lh, 0) + 2 * pad;
  } else if (items.length) {
    const reserve = freeAll.length ? Math.min(freeAll.length, FREE_RESERVE) * freeLh + gap : 0;
    const room = avail - gap - reserve - 2 * pad;
    const n = items.length;
    const full = n * ITEM * t * ITEM_LH;
    const factor = full <= room ? 1 : room > 0 ? Math.max(ITEM_MIN, room / full) : ITEM_MIN;
    const rowSize = ITEM * t * factor;
    const rowLh = rowSize * ITEM_LH;
    const fits = room > 0 ? Math.max(1, Math.floor(room / rowLh)) : 1;
    const shown = fits >= n ? n : Math.max(1, fits - 1);
    qtyW = Math.max(...items.slice(0, shown).map(([q]) => measure(q, rowSize, true, false)));
    for (const [q, name, qRtl] of items.slice(0, shown)) rows.push({ kind: 'item', qty: q, qtyRtl: qRtl, text: name, size: rowSize, lh: rowLh });
    if (shown < n) rows.push({ kind: 'more', text: (c.moreItems ?? VOUCHER_TEXT.moreItems).replace('{n}', String(n - shown)), size: rowSize, lh: rowLh });
    boxH = rows.reduce((sum, row) => sum + row.lh, 0) + 2 * pad;
  }

  const rem = avail - (boxH ? gap + boxH : 0);
  const freeN = freeAll.length ? Math.min(freeAll.length, Math.max(0, Math.floor((rem - gap) / freeLh))) : 0;
  const free = freeN >= freeAll.length ? freeAll : wrap(measure, c.freeText ?? '', freeSize, false, col, freeN);

  let y = 0;
  if (c.logo) {
    ops.push({ op: 'logo', x: left, y, w: col, h: logoH, align: landscape ? 'right' : 'center' });
    y += logoPart;
  }
  for (const line of title) {
    ops.push(text(line, ax, y + titleSize * BASE, titleSize, { bold: true, align }));
    y += titleSize * TITLE_LH;
  }
  if (boxH) {
    y += gap;
    ops.push({ op: 'box', x: left, y, w: col, h: boxH, stroke: Math.max(BOX_STROKE_MIN, BOX_STROKE * t), radius: BOX_RADIUS * t });
    let ry = y + pad;
    const boxRight = right - pad;
    const boxAx = landscape ? boxRight : (left + right) / 2;
    for (const row of rows) {
      const base = ry + row.size * BASE;
      if (row.kind === 'benefit') {
        ops.push(text(row.text, boxAx, base, row.size, { bold: true, align }));
      } else if (row.kind === 'more') {
        ops.push(text(row.text, boxRight, base, row.size));
      } else {
        ops.push(text(row.qty!, boxRight, base, row.size, { bold: true, rtl: row.qtyRtl }));
        const nameRight = boxRight - qtyW - QTY_GAP * t;
        ops.push(text(fit(measure, row.text, row.size, false, nameRight - (left + pad)), nameRight, base, row.size));
      }
      ry += row.lh;
    }
    y += boxH;
  }
  if (free.length) {
    y += gap;
    for (const line of free) {
      ops.push(text(line, ax, y + freeSize * BASE, freeSize, { align }));
      y += freeLh;
    }
  }
  y += gap;
  if (c.validity) {
    ops.push(text(c.validity, ax, y + validSize * BASE, validSize, { bold: true, align }));
    y += validSize * SMALL_LH;
  }
  ops.push(text(c.terms, ax, y + termsSize * BASE, termsSize, { align }));
  y += termsSize * SMALL_LH;
  return [ops, y];
}

function rounded(op: VoucherOp): VoucherOp {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op)) out[k] = typeof v === 'number' ? r3(v) : v;
  return out as unknown as VoucherOp;
}

/** The card's drawing operations, in mm (the server's `layout`). */
export function layoutCard(w: number, h: number, c: CardContent, measure: Measure): VoucherOp[] {
  const s = Math.min(w, h) / 50;
  const t = Math.min(s, TEXT_SCALE_MAX);
  const linear = c.barcode === 'code128';
  const landscape = w >= h * 1.15 && !linear;
  const m = MARGIN * s;
  const gap = GAP * t;
  const ops: VoucherOp[] = [];

  // Footer: the credit line.
  let bottom = h - m;
  if (c.credit) {
    const size = CREDIT * t;
    const top = h - m - size * CREDIT_LH;
    const width = measure(c.credit, size, false, false);
    const lineSize = width > 0 ? size * Math.min(1, (w - 2 * m) / width) : size;
    ops.push(text(c.credit, w / 2, top + size * BASE, lineSize, { align: 'center' }));
    bottom = top - CREDIT_GAP * t;
  }

  // The barcode block.
  const under: [string, number, boolean, boolean][] = [];
  if (c.code) under.push([c.code, CODE * t, true, false]);
  under.push([c.serial, SERIAL * t, false, true]);
  const underH = UNDER_GAP * t + under.reduce((sum, [, size]) => sum + size * UNDER_LH, 0);
  let bx: number, by: number, colW: number, cx: number, codeH: number;
  let left: number, right: number, top: number, textBottom: number;
  if (linear) {
    const barW = w - 2 * m;
    const barH = Math.min(Math.max(8, h * 0.2), 16);
    bx = m;
    by = bottom - barH - underH;
    ops.push({ op: 'code128', x: bx, y: by, w: barW, h: barH });
    [colW, cx, codeH] = [barW, w / 2, barH];
    [left, right, top, textBottom] = [m, w - m, m, by - gap];
  } else if (landscape) {
    const side = Math.min(bottom - m - underH, w * QR_LANDSCAPE);
    bx = m;
    by = m + Math.max(0, (bottom - m - side - underH) / 2);
    ops.push({ op: 'qr', x: bx, y: by, side });
    [colW, cx, codeH] = [side, bx + side / 2, side];
    [left, right, top, textBottom] = [m + side + gap + QUIET * t, w - m, m, bottom];
  } else {
    // The QR takes what the text leaves, between a floor and a ceiling.
    [left, right, top] = [m, w - m, m];
    const [, natural] = textBlock(c, measure, { left, right, area: 1e6, landscape: false, t });
    const most = Math.min(w - 2 * m, h * QR_PORTRAIT_MAX);
    const least = Math.min(most, h * QR_PORTRAIT_MIN);
    const side = Math.max(least, Math.min(most, bottom - top - underH - gap - natural));
    bx = (w - side) / 2;
    by = bottom - side - underH;
    ops.push({ op: 'qr', x: bx, y: by, side });
    [colW, cx, codeH] = [w - 2 * m, w / 2, side];
    textBottom = by - gap;
  }
  let y = by + codeH + UNDER_GAP * t;
  for (const [t0, size, mono, rtl] of under) {
    const width = measure(t0, size, true, mono);
    const lineSize = width > 0 ? size * Math.min(1, colW / width) : size;
    ops.push(text(t0, cx, y + size * BASE, lineSize, { bold: true, mono, align: 'center', rtl }));
    y += size * UNDER_LH;
  }

  // The text column, centred in the height it has.
  const area = textBottom - top;
  const [block, height] = textBlock(c, measure, { left, right, area, landscape, t });
  const dy = top + Math.max(0, (area - height) / 2);
  for (const op of block) ops.push({ ...op, y: op.y + dy });
  return ops.map(rounded);
}

/** A fixed width per character — what the golden fixture is computed with, in both languages. */
export function fakeMeasure(t: string, size: number, bold: boolean, mono: boolean): number {
  return size * Array.from(t).length * (mono ? 0.6 : bold ? 0.55 : 0.5);
}
