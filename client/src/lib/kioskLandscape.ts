/**
 * "עיצוב לרוחב" (P:/specs/kiosk-landscape-design.md): the kiosk's own design for a screen on its side, and the
 * landscape sizes that keep the categories and the dishes from growing huge ("לא ענקיים") — every one editable
 * per level ("הכל דינמי"). The same rules as the server's reference (server/app/services/kiosk_landscape.py) and
 * pos-android's KioskLandscape.kt, against the shared golden kiosk_landscape_golden.json.
 *
 * Every renderer (the web kiosk /k and the Android web bundle — web-kiosk-app; the Windows kiosk — kiosk-desktop
 * KioskApp; the dashboard's preview) draws `applyLandscape(cfg, display).config` and passes `landscapeLook` to the
 * screens (`PreviewModel.landscape`); in portrait both are today's exactly.
 */

/* ---------------------------------------------------------------- the block */

export const LANDSCAPE_SIZE_KEYS = [
  'categoryColumnDp',
  'categoryItemMaxDp',
  'categoryImageMaxDp',
  'productTileMaxDp',
  'productMinColumns',
  'productImageMaxDp',
  'textScalePct',
] as const;
export type LandscapeSizeKey = (typeof LANDSCAPE_SIZE_KEYS)[number];
export type LandscapeSizes = Record<LandscapeSizeKey, number>;

export interface LandscapeSizeSpec {
  default: number;
  min: number;
  max: number;
  step: number;
}

/** Every size: its default (the kiosk's own when unset), its range and its step — the server's SIZE_SPECS. */
export const LANDSCAPE_SIZE_SPECS: Record<LandscapeSizeKey, LandscapeSizeSpec> = {
  categoryColumnDp: { default: 232, min: 160, max: 360, step: 4 },
  categoryItemMaxDp: { default: 96, min: 56, max: 200, step: 4 },
  categoryImageMaxDp: { default: 64, min: 32, max: 160, step: 4 },
  productTileMaxDp: { default: 240, min: 160, max: 480, step: 4 },
  productMinColumns: { default: 3, min: 2, max: 8, step: 1 },
  productImageMaxDp: { default: 160, min: 80, max: 400, step: 4 },
  textScalePct: { default: 100, min: 80, max: 130, step: 5 },
};

export const LANDSCAPE_SIZE_DEFAULTS: LandscapeSizes = Object.fromEntries(
  LANDSCAPE_SIZE_KEYS.map((k) => [k, LANDSCAPE_SIZE_SPECS[k].default]),
) as LandscapeSizes;

/** The space between two dish tiles (dp) the column rule counts. */
export const LANDSCAPE_GAP_DP = 12;
/** The columns never make a dish's tile narrower than this (dp). */
export const LANDSCAPE_MIN_TILE_DP = 140;
/** The category column never takes more than this share of the screen's width. */
export const CATEGORY_COLUMN_MAX_SHARE = 0.3;
/** Every touch target (dp): a category's tile is never lower. */
export const LANDSCAPE_MIN_TOUCH_DP = 48;

/** section → the design keys a landscape block may set (their vocabulary is the normal design's). */
export const LANDSCAPE_OVERRIDE_KEYS = {
  theme: ['categoryLayout', 'cartStyle', 'gridDensity', 'categoryStyle', 'imageRatio', 'typeScale', 'backgroundImage'],
  layout: ['catalog', 'basket', 'railSize', 'productSize', 'categoryIcons', 'card'],
  attract: ['playlist'],
} as const;
export type LandscapeSection = keyof typeof LANDSCAPE_OVERRIDE_KEYS;

/** The `landscape` block as stored (every key optional; null = inherit). */
export interface KioskLandscape {
  theme?: Partial<Record<(typeof LANDSCAPE_OVERRIDE_KEYS.theme)[number], unknown>> | null;
  layout?: Partial<Record<(typeof LANDSCAPE_OVERRIDE_KEYS.layout)[number], unknown>> | null;
  attract?: { playlist?: unknown[] | null } | null;
  sizes?: Partial<Record<LandscapeSizeKey, number | null>> | null;
}

/** layout.catalog / layout.basket → theme.categoryLayout / cartStyle (the server's LAYOUT_BACK_COMPAT). */
const BACK_COMPAT_CATEGORY: Record<string, string> = { rail: 'side', top: 'top', landing: 'side', list: 'side', shelves: 'top', magazine: 'side', wall: 'side' };
const BACK_COMPAT_CART: Record<string, string> = { bar: 'bar', panel: 'panel', summary: 'bar', fab: 'bar', drawer: 'bar', receipt: 'bar' };

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/* ---------------------------------------------------------------- the sizes */

/** Python's round-half-up on a step (never banker's rounding). */
function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** One size as a kiosk reads it: a number rounded to its step and clamped to its range; anything else its default. */
export function landscapeSizeValue(key: LandscapeSizeKey, raw: unknown): number {
  const spec = LANDSCAPE_SIZE_SPECS[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return spec.default;
  const stepped = roundHalfUp(raw / spec.step) * spec.step;
  return Math.max(spec.min, Math.min(spec.max, stepped));
}

/** The landscape sizes in force: the block's own (`sizes`), each missing or broken one its default. */
export function resolveLandscapeSizes(block: unknown): LandscapeSizes {
  const sizes = isDict(block) && isDict(block.sizes) ? block.sizes : {};
  return Object.fromEntries(LANDSCAPE_SIZE_KEYS.map((k) => [k, landscapeSizeValue(k, sizes[k])])) as LandscapeSizes;
}

/** The category column's width on a screen `widthDp` wide. */
export function categoryColumnDp(widthDp: number, sizes: LandscapeSizes): number {
  return Math.min(sizes.categoryColumnDp, Math.floor(widthDp * CATEGORY_COLUMN_MAX_SHARE));
}

/** One category's tile height: what the layout gives, capped; never under a touch target. */
export function categoryItemDp(computedDp: number, sizes: LandscapeSizes): number {
  return Math.max(LANDSCAPE_MIN_TOUCH_DP, Math.min(pyRound(computedDp), sizes.categoryItemMaxDp));
}

/** A category's picture: what the layout gives, capped. */
export function categoryImageDp(computedDp: number, sizes: LandscapeSizes): number {
  return Math.min(pyRound(computedDp), sizes.categoryImageMaxDp);
}

/**
 * The dishes' columns in a grid `gridDp` wide: never fewer than the layout's own, enough that no tile is wider
 * than productTileMaxDp, at least productMinColumns — but never so many that a tile is under 140 dp.
 */
export function landscapeProductColumns(columns: number, gridDp: number, sizes: LandscapeSizes): number {
  const need = Math.ceil((gridDp + LANDSCAPE_GAP_DP) / (sizes.productTileMaxDp + LANDSCAPE_GAP_DP));
  const upper = Math.max(1, Math.floor((gridDp + LANDSCAPE_GAP_DP) / (LANDSCAPE_MIN_TILE_DP + LANDSCAPE_GAP_DP)));
  return Math.max(columns, Math.min(Math.max(need, sizes.productMinColumns), upper));
}

/** A tile's width with `columns` across `gridDp`. */
export function landscapeTileDp(columns: number, gridDp: number): number {
  return (gridDp - LANDSCAPE_GAP_DP * (columns - 1)) / columns;
}

/** A dish's picture height: what its ratio gives on the tile, capped. */
export function productImageDp(computedDp: number, sizes: LandscapeSizes): number {
  return Math.min(pyRound(computedDp), sizes.productImageMaxDp);
}

/** The landscape text scale: the screen's own times the block's percent (4 places). */
export function landscapeTextScale(displayScale: number, sizes: LandscapeSizes): number {
  return Math.round(((displayScale * sizes.textScalePct) / 100) * 10_000) / 10_000;
}

/** Python's round() on the values these rules see (whole numbers and halves: half to even). */
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/* ---------------------------------------------------------------- the design */

export interface LandscapeDisplay {
  landscape: boolean;
  sideCart: boolean;
  rail: boolean | null;
}

export interface LandscapeApplied<T> {
  config: T;
  /** The block decided these (a renderer adjusts nothing there). */
  explicit: { categories: boolean; cart: boolean };
}

function setIn(block: unknown, section: string, key: string): unknown {
  const part = isDict(block) ? block[section] : null;
  const v = isDict(part) ? part[key] : null;
  return v === undefined ? null : v;
}

/**
 * The config as a kiosk draws it on this display (P:/specs/kiosk-landscape-design.md §4): portrait — exactly as
 * it is. Landscape — the block's keys win; layout.catalog / basket bring their categoryLayout / cartStyle unless
 * the block names those too; a wall adds on a tap; then the automatic landscape rules (the side cart where there
 * is room, the top tabs where the rail does not fit) only for what the block left unset.
 */
export function applyLandscape<T extends object>(cfg: T, display: LandscapeDisplay): LandscapeApplied<T> {
  if (!display.landscape) return { config: cfg, explicit: { categories: false, cart: false } };
  const src = cfg as unknown as Dict;
  const block = isDict(src.landscape) ? src.landscape : {};
  const out: Dict = { ...src };
  let touched = false;
  const put = (section: string, key: string, value: unknown) => {
    const part = isDict(out[section]) ? (out[section] as Dict) : {};
    if (part[key] === value) return;
    out[section] = { ...part, [key]: value };
    touched = true;
  };
  for (const section of Object.keys(LANDSCAPE_OVERRIDE_KEYS) as LandscapeSection[]) {
    for (const key of LANDSCAPE_OVERRIDE_KEYS[section] as readonly string[]) {
      const value = setIn(block, section, key);
      if (value !== null) put(section, key, value);
    }
  }
  const catalog = setIn(block, 'layout', 'catalog');
  const basket = setIn(block, 'layout', 'basket');
  const ownCategories = setIn(block, 'theme', 'categoryLayout');
  const ownCart = setIn(block, 'theme', 'cartStyle');
  if (typeof catalog === 'string' && catalog in BACK_COMPAT_CATEGORY && ownCategories === null) put('theme', 'categoryLayout', BACK_COMPAT_CATEGORY[catalog]);
  if (typeof basket === 'string' && basket in BACK_COMPAT_CART && ownCart === null) put('theme', 'cartStyle', BACK_COMPAT_CART[basket]);
  const layout = isDict(out.layout) ? out.layout : {};
  if (layout.catalog === 'wall' && layout.quickAdd === 'off') put('layout', 'quickAdd', 'no_required');
  const explicitCategories = ownCategories !== null || catalog !== null;
  const explicitCart = ownCart !== null || basket !== null;
  const theme = isDict(out.theme) ? out.theme : {};
  if (!explicitCategories && (theme.categoryLayout ?? 'side') === 'side' && display.rail === false) put('theme', 'categoryLayout', 'top');
  if (!explicitCart && display.sideCart) put('theme', 'cartStyle', 'panel');
  // Nothing changed: the very same object (the roots memoise on it).
  return { config: touched ? (out as unknown as T) : cfg, explicit: { categories: explicitCategories, cart: explicitCart } };
}

/* --------------------------------------------------- the screens' measures */

/**
 * The landscape sizes in the CSS px a kiosk's screens are drawn in (`cssPerDp` CSS px make one dp: 1 in a browser
 * and the WebView, the Windows kiosk's page zoom — 0.5 at ×2 —, the preview frame's share of the device it stands
 * for). Null in portrait: the screens as today.
 */
export interface LandscapeLook {
  cssPerDp: number;
  sizes: LandscapeSizes;
  /** The category column's width (px) on this screen. */
  columnPx: number;
  categoryItemMaxPx: number;
  categoryImageMaxPx: number;
  productImageMaxPx: number;
  /** The text scale over the theme's own (textScalePct / 100). */
  textFactor: number;
}

export function landscapeLook(cfg: unknown, display: LandscapeDisplay, screenWidthPx: number, cssPerDp: number): LandscapeLook | null {
  if (!display.landscape) return null;
  const k = Number.isFinite(cssPerDp) && cssPerDp > 0 ? cssPerDp : 1;
  const sizes = resolveLandscapeSizes(isDict(cfg) ? cfg.landscape : null);
  return {
    cssPerDp: k,
    sizes,
    columnPx: Math.round(categoryColumnDp(screenWidthPx / k, sizes) * k),
    categoryItemMaxPx: Math.round(sizes.categoryItemMaxDp * k),
    categoryImageMaxPx: Math.round(sizes.categoryImageMaxDp * k),
    productImageMaxPx: Math.round(sizes.productImageMaxDp * k),
    textFactor: sizes.textScalePct / 100,
  };
}

/** The dishes' columns in `gridPx` of a landscape screen (today's `columns` in portrait). */
export function lookColumns(look: LandscapeLook | null | undefined, columns: number, gridPx: number): number {
  if (!look) return columns;
  return landscapeProductColumns(columns, gridPx / look.cssPerDp, look.sizes);
}

/** A category tile's height (px) on a landscape screen: `computedPx` capped (today's in portrait). */
export function lookCategoryItemPx(look: LandscapeLook | null | undefined, computedPx: number): number {
  if (!look) return computedPx;
  return Math.round(categoryItemDp(computedPx / look.cssPerDp, look.sizes) * look.cssPerDp);
}

/** A category's picture (px) on a landscape screen: `computedPx` capped (today's in portrait). */
export function lookCategoryImagePx(look: LandscapeLook | null | undefined, computedPx: number): number {
  if (!look) return computedPx;
  return Math.min(computedPx, look.categoryImageMaxPx);
}

/** The category column (px): `computedPx` on a portrait screen, the landscape column else. */
export function lookColumnPx(look: LandscapeLook | null | undefined, computedPx: number): number {
  return look ? look.columnPx : computedPx;
}

/* ---------------------------------------------------------------- validation */

export interface LandscapeIssue {
  path: string;
  code: string;
  params?: Record<string, string | number>;
}

/** The block's own rules, as the server's, in the dashboard's codes (`kiosks.validation`: unknownKey, enum, range). */
export function validateLandscape(block: unknown, vocab: Record<string, readonly string[]>): LandscapeIssue[] {
  const out: LandscapeIssue[] = [];
  if (block === undefined || block === null) return out;
  if (!isDict(block)) return [{ path: 'landscape', code: 'enum' }];
  for (const key of Object.keys(block)) {
    if (!['theme', 'layout', 'attract', 'sizes'].includes(key)) out.push({ path: `landscape.${key}`, code: 'unknownKey' });
  }
  for (const section of ['theme', 'layout'] as const) {
    const part = block[section];
    if (part === undefined || part === null) continue;
    if (!isDict(part)) {
      out.push({ path: `landscape.${section}`, code: 'enum' });
      continue;
    }
    for (const [key, value] of Object.entries(part)) {
      if (value === null || value === undefined) continue;
      if (!(LANDSCAPE_OVERRIDE_KEYS[section] as readonly string[]).includes(key)) out.push({ path: `landscape.${section}.${key}`, code: 'unknownKey' });
      else if (key !== 'backgroundImage' && vocab[`${section}.${key}`] && !vocab[`${section}.${key}`].includes(String(value))) {
        out.push({ path: `landscape.${section}.${key}`, code: 'enum' });
      }
    }
  }
  const sizes = block.sizes;
  if (isDict(sizes)) {
    for (const [key, value] of Object.entries(sizes)) {
      if (value === null || value === undefined) continue;
      const spec = LANDSCAPE_SIZE_SPECS[key as LandscapeSizeKey];
      const path = `landscape.sizes.${key}`;
      if (!spec) out.push({ path, code: 'unknownKey' });
      else if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max || (value - spec.min) % spec.step !== 0) {
        out.push({ path, code: 'range', params: { min: spec.min, max: spec.max } });
      }
    }
  }
  return out;
}
