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

export function sideBasketWidthDp(widthDp: number): number {
  return Math.min(440, Math.max(340, Math.floor(widthDp * 0.3 + 0.5)));
}

export function productColumnsFor(paneWidthDp: number, tileTargetDp: number, phoneColumns = 3): number {
  if (paneWidthDp < TABLET_MIN_SMALLEST_WIDTH_DP) return Math.min(6, Math.max(2, phoneColumns));
  return Math.min(8, Math.max(2, Math.floor((paneWidthDp - 2 * SIDE_PADDING_DP + GAP_DP) / (tileTargetDp + GAP_DP))));
}

export function productTileHeightDp(paneWidthDp: number, columns: number, baseHeightDp = 96): number {
  if (paneWidthDp < TABLET_MIN_SMALLEST_WIDTH_DP || columns <= 0) return baseHeightDp;
  const tileW = (paneWidthDp - 2 * SIDE_PADDING_DP - (columns - 1) * GAP_DP) / columns;
  return Math.min(Math.max(baseHeightDp, 140), Math.max(baseHeightDp, Math.floor(tileW * 0.6 + 0.5)));
}

export function tillLayout(p: DisplayProfile, opts: { phoneColumns?: number } = {}): TillLayout {
  const cls = tillLayoutOf(p);
  const phoneColumns = opts.phoneColumns ?? 3;
  const w = p.widthDp;
  const h = p.heightDp;
  let panes: Panes;
  if (cls === 'HANDHELD') panes = 'single';
  else if (w >= TWO_PANE_MIN_WIDTH_DP) panes = 'side';
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
    tileHeightDp: productTileHeightDp(productsWidth, columns),
    checkoutMaxWidthDp: cls === 'BIG' ? 1100 : cls === 'TABLET' ? 720 : null,
    reportMaxWidthDp: cls === 'HANDHELD' ? null : 960,
    reportTwoColumns: w >= 1400,
    touchMinDp: MIN_TOUCH_DP,
  };
}
