/**
 * "צבע ותמונה למחלקה" (P:/specs/category-color-image.md): a category's colour and picture as the
 * dashboard edits them and the till shows them.
 *
 * - The ready palette of the category dialog, and a colour's normal form (`#RRGGBB`).
 * - `readableTextOn` — the text on a category chip filled with its colour: white or black, whichever
 *   contrasts more (WCAG). The one rule: pos-server app/services/category_display.py
 *   `readable_text_on` (and its test vector, tests/test_category_display_parameters.py `TEXT_ON`),
 *   and the till.
 * - The three till parameters (`categoryColors`, `categoryImages`, `categoryImageSize`), their codes
 *   and defaults — nothing set is today's screens.
 * - The square crop of the dialog's picture (`cropBox`, `panCrop`, `zoomCrop`, `cropLayout`): a centre
 *   and a zoom over the picture's own pixels, always inside it.
 *
 * Pure (no React, no network): run by `npm test` (tsconfig.test.json).
 */

/** The dialog's ready colours: distinct on a till bar, each readable with white or black text. */
export const CATEGORY_PALETTE = [
  '#EF4444',
  '#F97316',
  '#F59E0B',
  '#EAB308',
  '#84CC16',
  '#22C55E',
  '#14B8A6',
  '#06B6D4',
  '#2563EB',
  '#6366F1',
  '#8B5CF6',
  '#D946EF',
  '#EC4899',
  '#78716C',
  '#334155',
  '#0F172A',
] as const;

const HEX = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

/** `#abc` / `abc` / `#AABBCC` → `#AABBCC`; anything else (empty included) → null. */
export function normalizeHex(value: string | null | undefined): string | null {
  const m = HEX.exec((value ?? '').trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${digits.toUpperCase()}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a colour, or null when it is not one. */
export function relativeLuminance(value: string | null | undefined): number | null {
  const hex = normalizeHex(value);
  if (!hex) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export const WHITE = '#FFFFFF';
export const BLACK = '#000000';

/** The text on a chip of this colour: white or black, whichever contrasts more; null for no colour. */
export function readableTextOn(value: string | null | undefined): typeof WHITE | typeof BLACK | null {
  const lum = relativeLuminance(value);
  if (lum === null) return null;
  const onWhite = 1.05 / (lum + 0.05);
  const onBlack = (lum + 0.05) / 0.05;
  return onWhite >= onBlack ? WHITE : BLACK;
}

/** A category's first letter, for a picture it does not have ("landing" with no picture). */
export function categoryInitial(name: string | null | undefined): string {
  const first = Array.from((name ?? '').trim())[0];
  return first ? first.toLocaleUpperCase() : '?';
}

/* ------------------------------------------------------------ the till parameters */

export const CATEGORY_COLORS = ['off', 'chip', 'accent'] as const;
export type CategoryColorsMode = (typeof CATEGORY_COLORS)[number];
export const CATEGORY_IMAGES = ['off', 'bar', 'landing'] as const;
export type CategoryImagesMode = (typeof CATEGORY_IMAGES)[number];
export const CATEGORY_IMAGE_SIZES = ['s', 'm', 'l'] as const;
export type CategoryImageSize = (typeof CATEGORY_IMAGE_SIZES)[number];

export const CATEGORY_DISPLAY_KEYS = ['categoryColors', 'categoryImages', 'categoryImageSize'] as const;
export type CategoryDisplayKey = (typeof CATEGORY_DISPLAY_KEYS)[number];

export interface CategoryDisplay {
  categoryColors: CategoryColorsMode;
  categoryImages: CategoryImagesMode;
  categoryImageSize: CategoryImageSize;
}

/** Nothing set: today's screens. */
export const CATEGORY_DISPLAY_DEFAULTS: CategoryDisplay = { categoryColors: 'off', categoryImages: 'off', categoryImageSize: 'm' };

const CODES: Record<CategoryDisplayKey, readonly string[]> = {
  categoryColors: CATEGORY_COLORS,
  categoryImages: CATEGORY_IMAGES,
  categoryImageSize: CATEGORY_IMAGE_SIZES,
};

/** The codes the till knows for a key. */
export function categoryDisplayCodes(key: CategoryDisplayKey): readonly string[] {
  return CODES[key];
}

/** What a till gets: each key's value from `values` when it is a code the till knows, else the default. */
export function resolveCategoryDisplay(values: Partial<Record<string, unknown>> | null | undefined): CategoryDisplay {
  const out = { ...CATEGORY_DISPLAY_DEFAULTS } as Record<CategoryDisplayKey, string>;
  for (const key of CATEGORY_DISPLAY_KEYS) {
    const v = values?.[key];
    if (typeof v === 'string' && CODES[key].includes(v)) out[key] = v;
  }
  return out as unknown as CategoryDisplay;
}

/**
 * The values to send for a level (`PUT /till-design/category-display`): only the keys whose choice
 * differs from what the level sets now — a code, or null for "inherit" ('' in the editor).
 */
export function changedCategoryDisplay(
  own: Partial<Record<string, unknown>>,
  edits: Partial<Record<CategoryDisplayKey, string>>,
): Partial<Record<CategoryDisplayKey, string | null>> {
  const out: Partial<Record<CategoryDisplayKey, string | null>> = {};
  for (const key of CATEGORY_DISPLAY_KEYS) {
    if (!(key in edits)) continue;
    const next = edits[key] ? edits[key]! : null;
    const now = typeof own[key] === 'string' ? (own[key] as string) : null;
    if (next !== now) out[key] = next;
  }
  return out;
}

/** The preview's sizes (px): the picture in a bar button, and a landing card's picture. */
export const CATEGORY_IMAGE_PX: Record<CategoryImageSize, { bar: number; landing: number }> = {
  s: { bar: 20, landing: 64 },
  m: { bar: 28, landing: 88 },
  l: { bar: 36, landing: 112 },
};

/* ------------------------------------------------------------ the square crop */

export interface Size {
  width: number;
  height: number;
}

/** A square crop: its centre in the picture's pixels, and a zoom (1 = the largest square that fits). */
export interface Crop {
  cx: number;
  cy: number;
  zoom: number;
}

export const CROP_ZOOM_MAX = 4;
/** The longest side the dashboard uploads (the server's product cap, PRODUCT_IMAGE_MAX_SIDE). */
export const CROP_OUTPUT_MAX = 1024;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The square's side at this zoom. */
export function cropSide(natural: Size, zoom: number): number {
  return Math.min(natural.width, natural.height) / clamp(zoom, 1, CROP_ZOOM_MAX);
}

/** The crop moved and zoomed back inside the picture. */
export function clampCrop(natural: Size, crop: Crop): Crop {
  const zoom = clamp(Number.isFinite(crop.zoom) ? crop.zoom : 1, 1, CROP_ZOOM_MAX);
  const half = cropSide(natural, zoom) / 2;
  return {
    zoom,
    cx: clamp(Number.isFinite(crop.cx) ? crop.cx : natural.width / 2, half, natural.width - half),
    cy: clamp(Number.isFinite(crop.cy) ? crop.cy : natural.height / 2, half, natural.height - half),
  };
}

/** The whole picture's largest centred square. */
export function initialCrop(natural: Size): Crop {
  return { cx: natural.width / 2, cy: natural.height / 2, zoom: 1 };
}

/** The source square to draw (`ctx.drawImage(img, sx, sy, side, side, …)`), in whole pixels. */
export function cropBox(natural: Size, crop: Crop): { sx: number; sy: number; side: number } {
  const c = clampCrop(natural, crop);
  const side = Math.max(1, Math.round(cropSide(natural, c.zoom)));
  const sx = clamp(Math.round(c.cx - side / 2), 0, Math.max(0, natural.width - side));
  const sy = clamp(Math.round(c.cy - side / 2), 0, Math.max(0, natural.height - side));
  return { sx, sy, side };
}

/** The uploaded square's side: the crop's own pixels, at most CROP_OUTPUT_MAX. */
export function cropOutputSide(natural: Size, crop: Crop, max = CROP_OUTPUT_MAX): number {
  return Math.min(max, cropBox(natural, crop).side);
}

/** Where the picture sits in a square viewport of `viewport` px so the crop fills it. */
export function cropLayout(natural: Size, crop: Crop, viewport: number): { left: number; top: number; width: number; height: number } {
  const c = clampCrop(natural, crop);
  const scale = viewport / cropSide(natural, c.zoom);
  return {
    left: viewport / 2 - c.cx * scale,
    top: viewport / 2 - c.cy * scale,
    width: natural.width * scale,
    height: natural.height * scale,
  };
}

/** The crop after the picture is dragged by (dx, dy) screen px in the viewport. */
export function panCrop(natural: Size, crop: Crop, dx: number, dy: number, viewport: number): Crop {
  const c = clampCrop(natural, crop);
  const scale = viewport / cropSide(natural, c.zoom);
  return clampCrop(natural, { ...c, cx: c.cx - dx / scale, cy: c.cy - dy / scale });
}

/** The crop at another zoom, its centre kept (then held inside the picture). */
export function zoomCrop(natural: Size, crop: Crop, zoom: number): Crop {
  return clampCrop(natural, { ...crop, zoom });
}
