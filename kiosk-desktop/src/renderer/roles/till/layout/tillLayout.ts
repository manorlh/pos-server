/**
 * The till's layout from the display profile (§6.10; kiosk-landscape spec §6) — pure, so a
 * rotation, Split View or a resized window lays the screens out again while the cart, the step
 * and the tip stay in the engine. Mirrors the APK's `ui/common/Adaptive.kt`:
 *
 *  - HANDHELD (short side < 600 dp): one pane, the cart behind a bar at the bottom;
 *  - TABLET: products and cart side by side from 840 dp; the cart under the products when the
 *    screen is at least 600 wide and 900 tall; the side cart 30% of the width, 340–440 dp;
 *    product columns by the tile size (medium ≈ 200 dp), 2–8;
 *  - BIG (S15+ with room): the side cart clamp(0.28 × w, 420, 560), product tiles 20% larger,
 *    payment centred up to 1100 dp, X / Z up to 960 dp (two columns from 1400).
 *
 * Touch targets never under 48 dp.
 */

import { bigBasketWidthDp, tillLayoutOf, type DisplayProfile, type TillLayoutClass } from './displayProfileAdapter';

export const TWO_PANE_MIN_WIDTH_DP = 840;
/**
 * A screen on its side keeps the order beside the products from this width (the owner, 17.10: a Windows 7 till at
 * 1024×768 and 125% — 819 dp — shows the categories, the products, the order and its pay button at once, as an Android
 * tablet on its side does). Narrower than Android's 840 on purpose.
 */
export const LANDSCAPE_TWO_PANE_MIN_WIDTH_DP = 760;
export const STACKED_MIN_HEIGHT_DP = 900;
export const TABLET_MIN_SMALLEST_WIDTH_DP = 600;
export const MIN_TOUCH_DP = 48;
const SIDE_PADDING_DP = 8;
const GAP_DP = 6;
const STACKED_CART_FRACTION = 0.38;
const BIG_STACKED_CART_FRACTION = 0.34;

export type Panes = 'single' | 'side' | 'stacked';

export interface TillLayout {
  cls: TillLayoutClass;
  panes: Panes;
  /** The side cart's width (dp); 0 when the cart is not beside the products. */
  cartWidthDp: number;
  /** The stacked cart's share of the height (0 when not stacked). */
  cartHeightFraction: number;
  /** The product grid's columns and a tile's height (dp). */
  columns: number;
  tileHeightDp: number;
  /** The payment screen's readable width (null: the whole width). */
  checkoutMaxWidthDp: number | null;
  /** X / Z and the shift screen. */
  reportMaxWidthDp: number | null;
  reportTwoColumns: boolean;
  touchMinDp: number;
}

/** The tile a tablet aims at, by the cloud's "גודל ריבוע מוצר" (phone columns: 4 small, 3 medium, 2 large). */
export function productTileTargetDp(phoneColumns: number): number {
  if (phoneColumns >= 5) return 110;
  if (phoneColumns >= 4) return 135;
  if (phoneColumns === 3) return 200;
  return 270;
}

/** The tablet's order panel beside the products (Android Adaptive.kt quickOrderPanelWidthDp): 30%, 360–440 dp. */
export function sideBasketWidthDp(widthDp: number): number {
  return Math.min(440, Math.max(360, Math.floor(widthDp * 0.3 + 0.5)));
}

export function productColumnsFor(paneWidthDp: number, tileTargetDp: number, phoneColumns = 3): number {
  if (paneWidthDp < TABLET_MIN_SMALLEST_WIDTH_DP) return Math.min(6, Math.max(2, phoneColumns));
  return Math.min(8, Math.max(2, Math.floor((paneWidthDp - 2 * SIDE_PADDING_DP + GAP_DP) / (tileTargetDp + GAP_DP))));
}

/** Above the products' grid on a tablet: the island, the till's line, the search and the categories (Android, dp). */
export const PRODUCT_GRID_CHROME_DP = 180;

/**
 * A tile's height (Android Adaptive.kt productTileHeightDp): the tile size's own on a handheld; on a tablet's wider tiles
 * nine tenths of their width (a photo, or the name as the picture, reads whole) — never under the size's own, never over
 * 280, and on a short pane a row and a half in sight under the grid's top.
 */
export function productTileHeightDp(paneWidthDp: number, columns: number, baseHeightDp = 96, paneHeightDp: number | null = null): number {
  if (paneWidthDp < TABLET_MIN_SMALLEST_WIDTH_DP || columns <= 0) return baseHeightDp;
  const tileW = Math.floor((paneWidthDp - 2 * SIDE_PADDING_DP - (columns - 1) * GAP_DP) / columns);
  const inSight = paneHeightDp === null ? Number.MAX_SAFE_INTEGER : Math.floor(((paneHeightDp - PRODUCT_GRID_CHROME_DP) * 2) / 3) - GAP_DP;
  return Math.min(Math.max(Math.round(tileW * 0.9), baseHeightDp), Math.max(baseHeightDp, Math.min(280, inSight)));
}

export function tillLayout(p: DisplayProfile, opts: { phoneColumns?: number } = {}): TillLayout {
  const cls = tillLayoutOf(p);
  const phoneColumns = opts.phoneColumns ?? 3;
  const w = p.widthDp;
  const h = p.heightDp;
  let panes: Panes;
  if (cls === 'HANDHELD') panes = 'single';
  else if (w >= TWO_PANE_MIN_WIDTH_DP || (w > h && w >= LANDSCAPE_TWO_PANE_MIN_WIDTH_DP)) panes = 'side';
  else if (w >= TABLET_MIN_SMALLEST_WIDTH_DP && h >= STACKED_MIN_HEIGHT_DP) panes = 'stacked';
  else panes = 'single';
  // BIG upright: stacked, the cart 34% of the height (§6.1).
  if (cls === 'BIG' && !p.landscape) panes = 'stacked';
  const cartWidthDp = panes === 'side' ? (cls === 'BIG' ? bigBasketWidthDp(w) : sideBasketWidthDp(w)) : 0;
  const productsWidth = panes === 'side' ? w - cartWidthDp : w;
  const target = Math.round(productTileTargetDp(phoneColumns) * (cls === 'BIG' ? 1.2 : 1));
  const columns = cls === 'HANDHELD' ? productColumnsFor(Math.min(productsWidth, TABLET_MIN_SMALLEST_WIDTH_DP - 1), target, phoneColumns) : productColumnsFor(productsWidth, target, phoneColumns);
  return {
    cls,
    panes,
    cartWidthDp,
    cartHeightFraction: panes === 'stacked' ? (cls === 'BIG' ? BIG_STACKED_CART_FRACTION : STACKED_CART_FRACTION) : 0,
    columns,
    tileHeightDp: productTileHeightDp(productsWidth, columns, 96, panes === 'stacked' ? Math.floor(h * (1 - (cls === 'BIG' ? BIG_STACKED_CART_FRACTION : STACKED_CART_FRACTION))) : h),
    // The payment across the tablet's width as Android draws it (TillBigScreenWidth narrows the big screen only).
    checkoutMaxWidthDp: cls === 'BIG' ? 1100 : null,
    reportMaxWidthDp: cls === 'HANDHELD' ? null : 960,
    reportTwoColumns: w >= 1400,
    touchMinDp: MIN_TOUCH_DP,
  };
}
