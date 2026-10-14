/**
 * "שם פריט מלא על הכפתור, ותג i" (P:/specs/product-tile-text.md; pos-server
 * app/services/product_tile_text.py): how a till writes a product's name and price on its button, and
 * when the "i" badge that opens the item's full description shows.
 *
 * - The four settings — till parameters, and the same four as `productText.<key>` of "עיצוב קופה"
 *   (the design wins over the parameter; "params", null or an unknown value follow the parameter):
 *   `productNameFit` fit | wrap | clip (fit), `productNameMaxLines` 1–4 (3), `productNameMinTextSize`
 *   s | m | l (s), `productInfoBadge` auto | always | off (auto).
 * - `fitName` — the name on a tile of a given width (and height):
 *     fit   the largest size between the tile's own and the floor (`MIN_TEXT_SP`) at which the whole
 *           name, wrapped at words, takes at most `productNameMaxLines` lines and the box's height;
 *           "…" only when not even the floor holds it;
 *     wrap  the tile's own size, at most `productNameMaxLines` lines, the tile as tall as that needs;
 *     clip  as today: the tile's own size, at most `productNameMaxLines` lines (and what the box
 *           holds), "…".
 * - `fitPrice` — the price is never cut: its size shrinks to `PRICE_MIN_SP`, then a trailing ".00"
 *   goes; the amount is always written whole.
 * - `showInfoBadge` — auto: a description, or a name that did not fit whole; always; off; never while
 *   the screen is being arranged.
 * - `TileTextCache` — worked out once per product and tile width, never per frame (the J1900 tills).
 *
 * The reference implementation: the dashboard's preview runs it, and the web till / the Windows till
 * import it (`@dash-lib/productTileText`); the Android till mirrors it. Pure, no React: run by
 * `npm test` (tsconfig.test.json).
 */

/* ------------------------------------------------------------ the settings */

export const PRODUCT_NAME_FIT_KEY = 'productNameFit';
export const PRODUCT_NAME_MAX_LINES_KEY = 'productNameMaxLines';
export const PRODUCT_NAME_MIN_TEXT_SIZE_KEY = 'productNameMinTextSize';
export const PRODUCT_INFO_BADGE_KEY = 'productInfoBadge';
export const PRODUCT_TEXT_KEYS = [PRODUCT_NAME_FIT_KEY, PRODUCT_NAME_MAX_LINES_KEY, PRODUCT_NAME_MIN_TEXT_SIZE_KEY, PRODUCT_INFO_BADGE_KEY] as const;
export type ProductTextKey = (typeof PRODUCT_TEXT_KEYS)[number];

export const NAME_FITS = ['fit', 'wrap', 'clip'] as const;
export type NameFit = (typeof NAME_FITS)[number];
export const NAME_MAX_LINES_MIN = 1;
export const NAME_MAX_LINES_MAX = 4;
export const NAME_MAX_LINES_CHOICES = [1, 2, 3, 4] as const;
export const MIN_TEXT_SIZES = ['s', 'm', 'l'] as const;
export type MinTextSize = (typeof MIN_TEXT_SIZES)[number];
/** The floor of the shrink (sp; CSS px on the web): the server's MIN_TEXT_SP. */
export const MIN_TEXT_SP: Record<MinTextSize, number> = { s: 11, m: 13, l: 15 };
/** The price's floor (§2, no setting). */
export const PRICE_MIN_SP = 11;
export const INFO_BADGES = ['auto', 'always', 'off'] as const;
export type InfoBadge = (typeof INFO_BADGES)[number];
/** The badge's touch target (dp / px), whatever the size of its icon. */
export const INFO_BADGE_TOUCH = 32;
/** The design's "לפי פרמטרי הקופה" over a value a level above set (as "base" / "brand" elsewhere). */
export const PRODUCT_TEXT_PARAMS = 'params';

export interface ProductTextSettings {
  productNameFit: NameFit;
  productNameMaxLines: number;
  productNameMinTextSize: MinTextSize;
  productInfoBadge: InfoBadge;
}

/** The design's section as stored: each key a code, "params" or absent. */
export type ProductTextDesign = Partial<Record<ProductTextKey, string | number | null>>;

export const PRODUCT_TEXT_DEFAULTS: ProductTextSettings = {
  productNameFit: 'fit',
  productNameMaxLines: 3,
  productNameMinTextSize: 's',
  productInfoBadge: 'auto',
};

/** Whether `value` is one the till knows for `key` (a design field set to it wins over the parameter). */
export function isProductTextCode(key: ProductTextKey, value: unknown): boolean {
  switch (key) {
    case PRODUCT_NAME_FIT_KEY:
      return typeof value === 'string' && (NAME_FITS as readonly string[]).includes(value);
    case PRODUCT_NAME_MAX_LINES_KEY:
      return typeof value === 'number' && Number.isInteger(value) && value >= NAME_MAX_LINES_MIN && value <= NAME_MAX_LINES_MAX;
    case PRODUCT_NAME_MIN_TEXT_SIZE_KEY:
      return typeof value === 'string' && (MIN_TEXT_SIZES as readonly string[]).includes(value);
    case PRODUCT_INFO_BADGE_KEY:
      return typeof value === 'string' && (INFO_BADGES as readonly string[]).includes(value);
    default:
      return false;
  }
}

/** The four as the till parameters set them; one the till does not know is its default. */
export function productTextFromParameters(parameters: object | null | undefined): ProductTextSettings {
  const p = (parameters ?? {}) as Record<string, unknown>;
  const pick = <K extends ProductTextKey>(key: K): ProductTextSettings[K] =>
    (isProductTextCode(key, p[key]) ? p[key] : PRODUCT_TEXT_DEFAULTS[key]) as ProductTextSettings[K];
  return {
    productNameFit: pick(PRODUCT_NAME_FIT_KEY),
    productNameMaxLines: pick(PRODUCT_NAME_MAX_LINES_KEY),
    productNameMinTextSize: pick(PRODUCT_NAME_MIN_TEXT_SIZE_KEY),
    productInfoBadge: pick(PRODUCT_INFO_BADGE_KEY),
  };
}

/** What a till uses: the design's value when it is a code, else the parameter's, else the default (§5). */
export function resolveProductText(design: ProductTextDesign | null | undefined, parameters: object | null | undefined): ProductTextSettings {
  const own = design ?? {};
  const params = productTextFromParameters(parameters);
  const pick = <K extends ProductTextKey>(key: K): ProductTextSettings[K] =>
    (isProductTextCode(key, own[key]) ? own[key] : params[key]) as ProductTextSettings[K];
  return {
    productNameFit: pick(PRODUCT_NAME_FIT_KEY),
    productNameMaxLines: pick(PRODUCT_NAME_MAX_LINES_KEY),
    productNameMinTextSize: pick(PRODUCT_NAME_MIN_TEXT_SIZE_KEY),
    productInfoBadge: pick(PRODUCT_INFO_BADGE_KEY),
  };
}

/* ------------------------------------------------------------ measuring */

/** A text's width (px / dp) at a type size. */
export type MeasureText = (text: string, size: number) => number;

const NARROW = new Set([' ', '.', ',', ':', ';', '\'', '"', '׳', '״', '|', '!', 'i', 'l', 'I', '(', ')', '-']);

/**
 * A rough measure where no font can be asked (tests, the server side of a render): 0.55 em a
 * letter, 0.56 a digit, 0.3 a space or narrow mark, 0.62 "₪". Close enough to Heebo / Noto Sans
 * Hebrew for the tests' cases; a screen measures with its own font (`canvasMeasure`).
 */
export function estimateTextWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) em += 0.3;
    else if (ch === '₪') em += 0.62;
    else if (ch >= '0' && ch <= '9') em += 0.56;
    else if (ch === 'W' || ch === 'M' || ch === 'ש' || ch === 'ם' || ch === 'מ') em += 0.66;
    else em += 0.55;
  }
  return em * size;
}

/**
 * A measure with the screen's own font through a canvas: one width per text at 100 px, scaled
 * (widths are linear in the size), kept. Null where there is no canvas (Node, a server render).
 */
export function canvasMeasure(fontFamily: string, weight: number | string = 700): MeasureText | null {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const REF = 100;
  ctx.font = `${weight} ${REF}px ${fontFamily}`;
  const widths = new Map<string, number>();
  return (text, size) => {
    let w = widths.get(text);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      if (widths.size > 5000) widths.clear();
      widths.set(text, w);
    }
    return (w * size) / REF;
  };
}

/* ------------------------------------------------------------ the name */

/** A hair under the box: a line measured at exactly its width must not be cut by rounding. */
const EPS = 0.5;
const ELLIPSIS = '…';
const STEP = 0.5;

/** A word wider than the line, cut into pieces that each fit (the last piece may be short). */
function splitLongWord(word: string, width: number, size: number, measure: MeasureText): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const ch of Array.from(word)) {
    if (current && measure(current + ch, size) > width) {
      pieces.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** The name wrapped at its spaces into lines of at most `width` (a word wider than a line is cut). */
export function wrapWords(text: string, width: number, size: number, measure: MeasureText): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, size) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (measure(word, size) <= width) {
      current = word;
    } else {
      const pieces = splitLongWord(word, width, size, measure);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? '';
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** `text` as it fits `width` with "…" at its end (the whole text when it fits). */
export function ellipsize(text: string, width: number, size: number, measure: MeasureText): string {
  if (measure(text, size) <= width) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join('').trimEnd() + ELLIPSIS, size) <= width) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('').trimEnd() + ELLIPSIS;
}

export interface NameFitRequest {
  name: string;
  /** The name's box (px / dp). */
  width: number;
  /** The box's height; 0 / absent: no limit (wrap grows the tile). */
  height?: number;
  /** The tile's own type size. */
  size: number;
  settings: Pick<ProductTextSettings, 'productNameFit' | 'productNameMaxLines' | 'productNameMinTextSize'>;
  /** Line height as a multiple of the size (the tile's own). */
  lineHeight?: number;
}

export interface NameFitResult {
  /** The type size the name is written at. */
  size: number;
  /** The lines, as drawn (the last one with "…" when cut). */
  lines: string[];
  /** Not the whole name ("…"): the "i" badge's `auto` shows. A word broken inside a line is not cut. */
  cut: boolean;
}

function clampLines(all: string[], allowed: number, width: number, size: number, measure: MeasureText): { lines: string[]; cut: boolean } {
  if (all.length <= allowed) return { lines: all, cut: false };
  const keep = all.slice(0, Math.max(0, allowed - 1));
  const rest = all.slice(Math.max(0, allowed - 1)).join(' ');
  return { lines: [...keep, ellipsize(rest, width, size, measure)].filter(Boolean), cut: true };
}

/** The lines a name may take in a box: the setting, and (with a height) what the box holds — at least one. */
function allowedLines(maxLines: number, height: number | undefined, size: number, lineHeight: number): number {
  if (!height || height <= 0) return maxLines;
  return Math.max(1, Math.min(maxLines, Math.floor((height + EPS) / (size * lineHeight))));
}

/** The name on a tile (see the module's head). Pure; cache it per product and tile width (`TileTextCache`). */
export function fitName(req: NameFitRequest, measure: MeasureText): NameFitResult {
  const name = req.name.replace(/\s+/g, ' ').trim();
  const width = Math.max(1, req.width - EPS);
  const lineHeight = req.lineHeight ?? 1.2;
  const maxLines = Math.max(NAME_MAX_LINES_MIN, Math.min(NAME_MAX_LINES_MAX, Math.round(req.settings.productNameMaxLines) || PRODUCT_TEXT_DEFAULTS.productNameMaxLines));
  const size = req.size;
  if (!name) return { size, lines: [], cut: false };
  const mode = req.settings.productNameFit;
  if (mode === 'wrap' || mode === 'clip') {
    const allowed = mode === 'wrap' ? maxLines : allowedLines(maxLines, req.height, size, lineHeight);
    const { lines, cut } = clampLines(wrapWords(name, width, size, measure), allowed, width, size, measure);
    return { size, lines, cut };
  }
  const floor = Math.min(size, MIN_TEXT_SP[req.settings.productNameMinTextSize] ?? MIN_TEXT_SP.s);
  for (let s = size; s >= floor - 1e-9; s = Math.round((s - STEP) * 10) / 10) {
    const lines = wrapWords(name, width, s, measure);
    const allowed = allowedLines(maxLines, req.height, s, lineHeight);
    // A word cut inside (wider than the line) is not "fits": smaller, while there is room to go.
    const whole = lines.length <= allowed && lines.join(' ').length === name.length;
    if (whole) return { size: s, lines, cut: false };
  }
  // At the floor a word wider than the line is broken inside (every letter still shown); past the
  // lines it may take, "…".
  const allowed = allowedLines(maxLines, req.height, floor, lineHeight);
  const { lines, cut } = clampLines(wrapWords(name, width, floor, measure), allowed, width, floor, measure);
  return { size: floor, lines, cut };
}

/** The height (px / dp) the name's lines take: `wrap` grows its tile by it. */
export function nameHeight(fit: Pick<NameFitResult, 'size' | 'lines'>, lineHeight = 1.2): number {
  return Math.ceil(Math.max(1, fit.lines.length) * fit.size * lineHeight);
}

/* ------------------------------------------------------------ the price */

/** "₪168.00" → "₪168", "168.00 ₪" → "168 ₪"; any other amount as it is (agorot are never dropped). */
export function dropZeroAgorot(text: string): string {
  return text.replace(/([0-9])[.,]00(?=[^0-9]*$)/, '$1');
}

export interface PriceFitResult {
  text: string;
  size: number;
  /** ".00" went. */
  dropped: boolean;
  /** Not even the floor and no ".00" made it fit: written whole all the same, over the edge. */
  overflow: boolean;
}

/** The price on a tile: never cut (§2) — smaller to `minSize`, then without ".00", else whole over the edge. */
export function fitPrice(text: string, width: number, size: number, measure: MeasureText, minSize = PRICE_MIN_SP): PriceFitResult {
  const room = Math.max(1, width - EPS);
  const floor = Math.min(size, minSize);
  for (let s = size; s >= floor - 1e-9; s = Math.round((s - STEP) * 10) / 10) {
    if (measure(text, s) <= room) return { text, size: s, dropped: false, overflow: false };
  }
  const short = dropZeroAgorot(text);
  if (short !== text && measure(short, floor) <= room) return { text: short, size: floor, dropped: true, overflow: false };
  return { text: short, size: floor, dropped: short !== text, overflow: true };
}

/* ------------------------------------------------------------ the badge */

export interface BadgeFacts {
  /** The product's description (blank = none). */
  description?: string | null;
  /** The name did not fit whole (`NameFitResult.cut`). */
  nameCut: boolean;
  /** "עריכת מסך": the screen is being arranged — never a badge. */
  arranging?: boolean;
}

export function hasDescription(description: string | null | undefined): boolean {
  return typeof description === 'string' && description.trim().length > 0;
}

/** Whether a tile shows the "i" badge (§4). */
export function showInfoBadge(mode: InfoBadge, facts: BadgeFacts): boolean {
  if (facts.arranging) return false;
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return hasDescription(facts.description) || facts.nameCut;
}

/* ------------------------------------------------------------ name and badge together */

export interface TileTextLayout {
  name: NameFitResult;
  badge: boolean;
}

/**
 * The name and the badge of one tile, the badge's room taken from the name's box when it shows
 * (`badgeRoom` px off its width — or off its height, `roomAxis: 'height'`, for a badge above a name
 * centred on a tall face; 0 when the badge stands clear of the box): a badge wanted anyway (a
 * description, `always`) shrinks the box first; a name cut in the full box (`auto`) gets the badge,
 * then is laid out again beside it. One pass, stable — a smaller box never holds a name whole where
 * the larger one did not.
 */
export function layoutTileText(
  fit: (req: NameFitRequest) => NameFitResult,
  req: NameFitRequest,
  badge: { mode: InfoBadge; description?: string | null; arranging?: boolean },
  badgeRoom = 0,
  roomAxis: 'width' | 'height' = 'width',
): TileTextLayout {
  const narrowed = (): NameFitRequest =>
    roomAxis === 'height'
      ? { ...req, height: req.height && req.height > 0 ? Math.max(1, req.height - badgeRoom) : req.height }
      : { ...req, width: Math.max(1, req.width - badgeRoom) };
  if (showInfoBadge(badge.mode, { description: badge.description, nameCut: false, arranging: badge.arranging })) {
    return { name: fit(narrowed()), badge: true };
  }
  const full = fit(req);
  if (!showInfoBadge(badge.mode, { description: badge.description, nameCut: full.cut, arranging: badge.arranging })) {
    return { name: full, badge: false };
  }
  return { name: badgeRoom > 0 ? fit(narrowed()) : full, badge: true };
}

/* ------------------------------------------------------------ the cache */

/**
 * Names and prices worked out once per product, tile width and setting (§3 "מתי מחושב"): a tile drawn
 * again (a scroll, a count badge, a selection) reads its answer here. Bounded: cleared past `max`.
 */
export class TileTextCache {
  private readonly names = new Map<string, NameFitResult>();
  private readonly prices = new Map<string, PriceFitResult>();
  /** How many answers were worked out (not read back) — the tests' "once". */
  computed = 0;

  constructor(
    private readonly measure: MeasureText,
    private readonly max = 4000,
  ) {}

  name(req: NameFitRequest): NameFitResult {
    const s = req.settings;
    const key = [s.productNameFit, s.productNameMaxLines, s.productNameMinTextSize, req.size, req.lineHeight ?? 1.2, Math.round(req.width), Math.round(req.height ?? 0), req.name].join('|');
    let hit = this.names.get(key);
    if (!hit) {
      if (this.names.size >= this.max) this.names.clear();
      hit = fitName(req, this.measure);
      this.names.set(key, hit);
      this.computed += 1;
    }
    return hit;
  }

  price(text: string, width: number, size: number, minSize = PRICE_MIN_SP): PriceFitResult {
    const key = [Math.round(width), size, minSize, text].join('|');
    let hit = this.prices.get(key);
    if (!hit) {
      if (this.prices.size >= this.max) this.prices.clear();
      hit = fitPrice(text, width, size, this.measure, minSize);
      this.prices.set(key, hit);
      this.computed += 1;
    }
    return hit;
  }
}

/* ------------------------------------------------------------ the sheet */

/** "₪28–₪34" for sizes / variants at different prices, else the one price (agorot in, `format` writes one). */
export function priceRangeText(prices: readonly number[], format: (agorot: number) => string): string {
  const list = prices.filter((p) => Number.isFinite(p));
  if (list.length === 0) return '';
  const lo = Math.min(...list);
  const hi = Math.max(...list);
  return lo === hi ? format(lo) : `${format(lo)}–${format(hi)}`;
}
