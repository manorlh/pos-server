/**
 * The Windows kiosk window's page zoom (main/index.ts `zoomFor`): the kiosk's screens are drawn for ~371 CSS px
 * across the short side — the Android kiosk's 540 dp (a 1080×1920 kiosk at xhdpi, 960×540 dp on its side) at the web
 * screens' own proportion, 1 CSS px = KIOSK_DP_PER_PX (785/540 ≈ 1.45) dp (client lib/posLook.ts; the web's sizes are the
 * native dp ÷ 1.45 — a 22 sp button word is 15 CSS px). So the two kiosks draw every screen at one size, side by side
 * (P:/specs/till-visual-parity, 17.10: at 540 CSS px the web was 1.45× smaller than the Android kiosk). The zoom fills
 * the window at that size — from the window's content size in device-independent pixels (Windows' own display scaling
 * already in). "זום" in the technician's screen (local settings) wins when it is set. Pure, so the layout audit
 * (scripts/layout-audit, P:/specs/layout-audit-1610/README.md) derives every screen exactly as the app does.
 */

/** The Android kiosk's short side (dp) and its dp per CSS px of these screens (client posLook KIOSK_DP_PER_PX). */
export const KIOSK_NATIVE_SHORT_SIDE_DP = 540;
export const KIOSK_DP_PER_CSS_PX = 785 / 540;
export const KIOSK_DESIGN_SHORT_SIDE_PX = Math.round(KIOSK_NATIVE_SHORT_SIDE_DP / KIOSK_DP_PER_CSS_PX);
export const KIOSK_MIN_ZOOM = 1;
/** A 4K panel at 100 % (2160 DIPs short) still fills: 2160 / 371 ≈ 5.8. */
export const KIOSK_MAX_ZOOM = 6;
/**
 * A landscape window keeps at least this many CSS px of height (layout audit 16.10): the web's landscape design — the side
 * cart, two columns, "לתשלום" / "המשך" / both service cards inside the window without scrolling (the owner, 0.5.9) — needs
 * 600 CSS px; at the Android kiosk's size on its side (540 dp = 371 CSS px) none of them fit (the Android kiosk itself
 * scrolls its tip and pay steps there). So a landscape window keeps the web's own landscape scale: 1920×1080 at 100 % is
 * 1067×600 CSS px (×1.8), 1536×864 is ×1.44 — as before 17.10; only portrait (and square) moved to the Android size.
 */
export const KIOSK_LANDSCAPE_MIN_CSS_HEIGHT = 600;

export function kioskWindowZoom(contentWidth: number, contentHeight: number, localZoom?: number | null): number {
  if (localZoom && localZoom > 0.5 && localZoom < KIOSK_MAX_ZOOM) return localZoom;
  const short = Math.min(contentWidth, contentHeight);
  let zoom = short / KIOSK_DESIGN_SHORT_SIDE_PX;
  if (contentWidth > contentHeight) zoom = Math.min(zoom, contentHeight / KIOSK_LANDSCAPE_MIN_CSS_HEIGHT);
  return Math.max(KIOSK_MIN_ZOOM, Math.min(KIOSK_MAX_ZOOM, zoom));
}
