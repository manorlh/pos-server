/**
 * "שם פריט מלא על הכפתור, ותג i לתיאור מלא" on the Windows till (P:/specs/product-tile-text.md — the Android till's
 * domain/ProductTileText.kt): the owner (14.10): the whole name on the tile ("להחיל את כל הכיתוב"), the price never cut,
 * and an "i" that shows the staff the item's full description.
 *
 *  - `productNameFit` fit | wrap | clip (default fit): fit — the type shrinks down to a readable minimum, then the name
 *    breaks over up to `productNameMaxLines` lines, "…" only as the last resort; wrap — the type stays, the name breaks
 *    over up to the lines; clip — as before (two lines, "…");
 *  - `productNameMaxLines` 1–4 (default 3); `productNameMinTextSize` s | m | l (default s) — the floor of the shrink;
 *  - `productInfoBadge` auto | always | off (default auto): auto — on an item with a description, or whose name did not
 *    fit whole;
 *  - the price is never cut: its type shrinks first, then ".00" goes; the amount itself never.
 *
 * Worked out once per item per tile width (the caller caches it) — a J1900 drawing in software never feels it. The
 * measure is an estimate of a bold Hebrew / Latin line (no canvas: the engine's process and the tests have none), on
 * the safe side: a name it says fits, fits.
 *
 * Pure.
 */

export type NameFit = 'fit' | 'wrap' | 'clip';
export type InfoBadge = 'auto' | 'always' | 'off';
export type MinTextSize = 's' | 'm' | 'l';

export interface TileTextSettings {
  fit: NameFit;
  maxLines: number;
  minSize: MinTextSize;
  infoBadge: InfoBadge;
}

export const TILE_TEXT_DEFAULTS: TileTextSettings = { fit: 'fit', maxLines: 3, minSize: 's', infoBadge: 'auto' };

/** The till parameters (P:/specs/product-tile-text.md §5). */
export const TILE_TEXT_PARAMS = {
  fit: 'productNameFit',
  maxLines: 'productNameMaxLines',
  minSize: 'productNameMinTextSize',
  infoBadge: 'productInfoBadge',
} as const;

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** The settings from the till's parameters; anything missing or wrong — the default. */
export function tileTextOf(params: Record<string, unknown> | null | undefined): TileTextSettings {
  const p = params ?? {};
  const raw = p[TILE_TEXT_PARAMS.maxLines];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN;
  return {
    fit: pick(p[TILE_TEXT_PARAMS.fit], ['fit', 'wrap', 'clip'] as const, TILE_TEXT_DEFAULTS.fit),
    maxLines: Number.isInteger(n) && n >= 1 && n <= 4 ? n : TILE_TEXT_DEFAULTS.maxLines,
    minSize: pick(p[TILE_TEXT_PARAMS.minSize], ['s', 'm', 'l'] as const, TILE_TEXT_DEFAULTS.minSize),
    infoBadge: pick(p[TILE_TEXT_PARAMS.infoBadge], ['auto', 'always', 'off'] as const, TILE_TEXT_DEFAULTS.infoBadge),
  };
}

/** The tile name's type: its usual size and the floors of the shrink (CSS px — the Android sp: s 10, m 12, l 14). */
export const NAME_PX = 16;
export const MIN_PX: Record<MinTextSize, number> = { s: 10, m: 12, l: 14 };
/** The tile's own lines (the Windows till's tile: two, as before the parameters). */
export const TILE_LINES = 2;
/** A bold line's height per px of type, and the average glyph's width per px (an estimate, on the wide side). */
const LINE = 1.25;
const GLYPH = 0.6;

/** How many lines `text` takes at `px` in `widthPx` — by words, as the browser breaks it (a word wider than a line breaks). */
export function linesAt(text: string, px: number, widthPx: number): number {
  const perLine = Math.max(1, Math.floor(widthPx / (px * GLYPH)));
  let lines = 1;
  let used = 0;
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const w = word.length;
    if (w > perLine) {
      // A long word on its own lines.
      if (used > 0) lines += 1;
      lines += Math.ceil(w / perLine) - 1;
      used = w % perLine || perLine;
      continue;
    }
    const need = used === 0 ? w : used + 1 + w;
    if (need <= perLine) used = need;
    else {
      lines += 1;
      used = w;
    }
  }
  return lines;
}

export interface NameLayout {
  /** The type size, CSS px. */
  px: number;
  /** The lines to clamp to ("…" past them). */
  lines: number;
  /** The whole name is on the tile ("…" not needed). */
  whole: boolean;
}

/** The sizes from `base` down to `min`, one px apart, `min` always the last (Android fitSizes). */
function sizesDown(base: number, min: number): number[] {
  if (base <= min) return [base];
  const out: number[] = [];
  for (let px = base; px > min + 0.001; px -= 1) out.push(px);
  out.push(min);
  return out;
}

/**
 * The name's layout on a tile whose text box is `widthPx` wide with `heightPx` for the name — the Android till's
 * `fitProductName`, rule for rule:
 *  - clip: the tile's own size and lines (TILE_LINES), "…" past them;
 *  - wrap: the tile's own size, up to `productNameMaxLines` lines (as many as the box holds);
 *  - fit: first the size steps down from NAME_PX to the minimum on the tile's own lines (no more than the most); if it
 *    still does not fit, the minimum takes up to `productNameMaxLines` lines (as many as the box holds); "…" only past
 *    those.
 */
export function nameLayout(name: string, widthPx: number, heightPx: number, s: TileTextSettings): NameLayout {
  const room = (px: number) => Math.max(1, Math.floor(heightPx / (px * LINE)));
  const most = Math.min(4, Math.max(1, s.maxLines));
  if (s.fit === 'clip') {
    const shown = Math.min(TILE_LINES, room(NAME_PX));
    return { px: NAME_PX, lines: shown, whole: linesAt(name, NAME_PX, widthPx) <= shown };
  }
  if (s.fit === 'wrap') {
    const allowed = Math.min(most, room(NAME_PX));
    return { px: NAME_PX, lines: allowed, whole: linesAt(name, NAME_PX, widthPx) <= allowed };
  }
  const first = Math.min(TILE_LINES, most);
  const sizes = sizesDown(NAME_PX, Math.min(MIN_PX[s.minSize], NAME_PX));
  for (const px of sizes) {
    const own = Math.min(first, room(px));
    if (linesAt(name, px, widthPx) <= own) return { px, lines: own, whole: true };
  }
  // Still too long at the minimum: the minimum on more lines — as many as asked and the box holds.
  const min = sizes[sizes.length - 1];
  const allowed = Math.max(1, Math.min(most, room(min)));
  return { px: min, lines: allowed, whole: linesAt(name, min, widthPx) <= allowed };
}

/** Whether the tile carries the "i" (auto: a description, or a name that did not fit whole). */
export function showsInfo(mode: InfoBadge, hasDescription: boolean, nameWhole: boolean): boolean {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return hasDescription || !nameWhole;
}

/** The price's readable minimum before it drops its ".00", and the floor past that (CSS px — the Android PRICE_MIN_SP / PRICE_FLOOR_SP). */
export const PRICE_MIN_PX = 10;
export const PRICE_FLOOR_PX = 6;

/**
 * The price on a tile `widthPx` wide — the Android till's `fitPrice`: the whole price at the largest size from `basePx`
 * down to 10 px that fits; else without its ".00" (₪168.00 → ₪168; ₪168.50 keeps its agorot); else, the number still
 * whole, smaller still down to 6 px. Never cut.
 */
export function priceLayout(full: string, widthPx: number, basePx = 15): { text: string; px: number } {
  const fits = (text: string, px: number) => text.length * px * GLYPH <= widthPx;
  for (const px of sizesDown(basePx, PRICE_MIN_PX)) if (fits(full, px)) return { text: full, px };
  const short = full.replace(/(\d)\.00(?!\d)/, '$1');
  if (short !== full) for (const px of sizesDown(basePx, PRICE_MIN_PX)) if (fits(short, px)) return { text: short, px };
  const text = short;
  for (const px of sizesDown(PRICE_MIN_PX, PRICE_FLOOR_PX).slice(1)) if (fits(text, px)) return { text, px };
  return { text, px: PRICE_FLOOR_PX };
}
