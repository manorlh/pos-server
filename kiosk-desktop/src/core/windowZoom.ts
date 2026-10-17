/**
 * The Windows kiosk window's page zoom (main/index.ts `zoomFor`): the kiosk's screens are drawn for ~540 CSS px
 * across the short side (a portrait kiosk 540 wide, a landscape one 540 tall); the zoom fills the window at that
 * size — from the window's content size in device-independent pixels (Windows' own display scaling already in).
 * "זום" in the technician's screen (local settings) wins when it is set. Pure, so the layout audit
 * (scripts/layout-audit, P:/specs/layout-audit-1610/README.md) derives every screen exactly as the app does.
 */

export const KIOSK_DESIGN_SHORT_SIDE_PX = 540;
export const KIOSK_MIN_ZOOM = 1;
export const KIOSK_MAX_ZOOM = 3;
/**
 * A landscape window keeps at least this many CSS px of height (layout audit 16.10): at 540 the dine-in / take-away cards
 * and the technician's lower buttons ("ניתוק הקיוסק מהענן") fell below a 14" laptop's 1536×864 window (×1.6). The zoom
 * stops at height / 600 — that window is drawn 1382×600 (×1.44); a portrait or square one is as before.
 */
export const KIOSK_LANDSCAPE_MIN_CSS_HEIGHT = 600;

export function kioskWindowZoom(contentWidth: number, contentHeight: number, localZoom?: number | null): number {
  if (localZoom && localZoom > 0.5 && localZoom < 4) return localZoom;
  const short = Math.min(contentWidth, contentHeight);
  let zoom = short / KIOSK_DESIGN_SHORT_SIDE_PX;
  if (contentWidth > contentHeight) zoom = Math.min(zoom, contentHeight / KIOSK_LANDSCAPE_MIN_CSS_HEIGHT);
  return Math.max(KIOSK_MIN_ZOOM, Math.min(KIOSK_MAX_ZOOM, zoom));
}

/**
 * The automatic zoom the shell gives the window (main/index.ts `autoZoomFor`): the kiosk's ~540-px design only.
 * The till is drawn at 100% like the Android tablet (its own layout fits 1024×768 and up): on the till role, and
 * always on the Windows 7 build (till only, 1024×768 PCs), the automatic part is 1 — "גודל תצוגה" (displayScale)
 * still multiplies it. The till's view shares the window's zoom (both pages are on host `app`, and Chromium keeps
 * zoom per host), so this is the one place that sizes the till too.
 */
export function shellAutoZoom(o: { build: string; role: string | null; width: number; height: number }): number {
  if (o.build === 'win7' || o.role === 'till') return 1;
  return kioskWindowZoom(o.width, o.height);
}
