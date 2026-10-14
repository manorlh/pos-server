/**
 * "שם פריט מלא על הכפתור, ותג i" on the web till / the Windows till (P:/specs/product-tile-text.md; the web
 * till matches the APK): the product grid's tiles through the one set of rules the APK and the dashboard's
 * preview run (`@dash-lib/productTileText` — pos-android domain/ProductTileText.kt step for step):
 *
 *  - the name: fit / wrap / clip by the engine's `display.productText` (the design's `look` over the till
 *    parameters), from the tile's own size (16) and its own lines (2, as the tile drew it before);
 *  - the price, never cut: smaller to 10, then without ".00", then smaller still;
 *  - the "i": auto (a description, or a name not shown whole) / always / off, at the tile's top-left
 *    (the count's corner is the right), its room taken from the name;
 *  - wrap grows a row of tiles to its tallest — the virtualised grid keeps a height per row.
 *
 * Pure (the measure is passed in) and cached per product and tile width, never per frame: a J1900 till
 * scrolling 200 products only reads answers back.
 */

import {
  PRODUCT_TEXT_DEFAULTS,
  TileTextCache,
  canvasMeasure,
  estimateTextWidth,
  layoutTileText,
  nameHeight,
  type MeasureText,
  type NameFitResult,
  type PriceFitResult,
  type ProductTextSettings,
} from '@dash-lib/productTileText';
import type { Product } from '../../../../shared/till/protocol';
import { money } from '../text';

/** The tile's own type sizes and box (till.css `.t-tile`): what the rules start from. */
export const TILE_NAME_PX = 16;
export const TILE_NAME_LINE_HEIGHT = 1.25;
export const TILE_PRICE_PX = 16;
/** The tile drew its name on two lines before ("-webkit-line-clamp: 2"): clip keeps them, fit tries them first. */
export const TILE_OWN_LINES = 2;
export const TILE_PAD_X = 10;
export const TILE_PAD_Y = 8;
/** The department's colour stripe at the tile's start. */
export const TILE_STRIPE = 6;
/** The price's line and the gap above it. */
export const TILE_PRICE_LINE = 22;
export const TILE_GAP = 4;
/** The room the "i" takes from the name's width (its 22 px square and a gap); its touch target is 32. */
export const TILE_BADGE_ROOM = 26;

const FONT = '"Noto Sans Hebrew", Arial, sans-serif';

/** The name's box in a tile of this size. */
export function nameBox(tileWidth: number, tileHeight: number): { width: number; height: number } {
  return {
    width: Math.max(1, tileWidth - 2 * TILE_PAD_X - TILE_STRIPE),
    height: Math.max(1, tileHeight - 2 * TILE_PAD_Y - TILE_PRICE_LINE - TILE_GAP),
  };
}

export interface TileText {
  name: NameFitResult;
  badge: boolean;
  price: PriceFitResult;
  /** The tile's height: its own, or (wrap) as tall as its name needs. */
  height: number;
}

/**
 * One tile's name, badge and price at one tile size, read back from the caches when worked out before
 * (`names` measures the bold name, `prices` the regular price).
 */
export function layoutTile(
  product: Product,
  tileWidth: number,
  tileHeight: number,
  settings: ProductTextSettings,
  names: TileTextCache,
  prices: TileTextCache = names,
  arranging = false,
): TileText {
  const box = nameBox(tileWidth, tileHeight);
  const wrap = settings.productNameFit === 'wrap';
  const laid = layoutTileText(
    (req) => names.name(req),
    { name: product.name, width: box.width, height: wrap ? 0 : box.height, size: TILE_NAME_PX, tileLines: TILE_OWN_LINES, settings, lineHeight: TILE_NAME_LINE_HEIGHT },
    { mode: settings.productInfoBadge, description: product.description, arranging },
    TILE_BADGE_ROOM,
  );
  const price = prices.price(money(product.priceAgorot), box.width, TILE_PRICE_PX);
  const needed = 2 * TILE_PAD_Y + nameHeight(laid.name, TILE_NAME_LINE_HEIGHT) + TILE_GAP + TILE_PRICE_LINE;
  return { name: laid.name, badge: laid.badge, price, height: wrap ? Math.max(tileHeight, needed) : tileHeight };
}

/** Each row's height: the tile height, or (wrap) its tallest tile's. */
export function rowHeights(rows: readonly Product[][], tileWidth: number, tileHeight: number, settings: ProductTextSettings, names: TileTextCache, prices: TileTextCache = names): number[] {
  if (settings.productNameFit !== 'wrap') return rows.map(() => tileHeight);
  return rows.map((row) => row.reduce((h, p) => Math.max(h, layoutTile(p, tileWidth, tileHeight, settings, names, prices).height), tileHeight));
}

/** The settings the engine sent, any missing one at its default (an older engine sends none). */
export function displayProductText(display: { productText?: Partial<ProductTextSettings> } | undefined | null): ProductTextSettings {
  return { ...PRODUCT_TEXT_DEFAULTS, ...(display?.productText ?? {}) };
}

/* ------------------------------------------------------------ measuring */

const caches = new Map<number, TileTextCache>();

/** The answers at one weight, measured with the till's font (the rough measure where there is no canvas). */
export function tileCache(weight: number, measure?: MeasureText): TileTextCache {
  if (measure) return new TileTextCache(measure);
  let cache = caches.get(weight);
  if (!cache) {
    cache = new TileTextCache(canvasMeasure(FONT, weight) ?? estimateTextWidth);
    caches.set(weight, cache);
  }
  return cache;
}

/** Measured again with the web font once it has loaded (a first paint may measure the fallback). */
export function resetTileCaches(): void {
  caches.clear();
}
