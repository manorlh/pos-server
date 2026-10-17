/**
 * The layout audit's matrix (test/fixtures/layout_audit_matrix.json — the same file in pos-android) turned into
 * what each host shows, exactly as the apps derive it:
 *
 *   win-kiosk      the Windows kiosk: the window in DIPs (px ÷ Windows' scaling), the page zoom of
 *                  core/windowZoom.ts (short side → 540 CSS px), its decisions (side cart, rail, columns) from the
 *                  DIPs (KioskApp's useKioskDisplay: outerWidth/outerHeight at ratio 1);
 *   android-kiosk  the Android web-renderer kiosk (WebView, width=device-width, no zoom): CSS px = Android dp
 *                  (px ÷ densityDpi/160, the scale as 160/200/240 dpi), the decisions from the same;
 *   web-kiosk      the browser kiosk /k (web-kiosk-app.tsx): CSS px = DIPs, the display profile from
 *                  innerWidth × devicePixelRatio (a 4K screen at 100% is laid out as full HD and zoomed);
 *   win-till       the Windows till (roles/till, a WebContentsView with no page zoom): CSS px = DIPs, the profile
 *                  from innerWidth × devicePixelRatio, the root's CSS zoom = the profile's scale;
 *   display        the till's customer display (second screen): CSS px = DIPs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserFacts, displayProfile, kioskDisplay, tillLayoutOf } from '../../../client/src/lib/displayProfile.ts';
import { kioskWindowZoom } from '../../src/core/windowZoom.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MATRIX_FILE = path.join(here, '..', '..', 'test', 'fixtures', 'layout_audit_matrix.json');

/** Panels the web audit adds to the shared matrix: the owner's own 14" laptop (16.10 — at 125% a 1536×864 window). */
export const EXTRA_SCREENS = [{ id: '14in-1920x1080', diagonalInches: 14.0, widthPx: 1920, heightPx: 1080, tillRotates: false }];

export function loadMatrix(file = MATRIX_FILE) {
  const m = JSON.parse(readFileSync(file, 'utf8'));
  return { ...m, screens: [...m.screens, ...EXTRA_SCREENS] };
}

export const HOSTS = ['win-kiosk', 'android-kiosk', 'web-kiosk', 'win-till', 'display'];
const KIOSK_HOSTS = new Set(['win-kiosk', 'android-kiosk', 'web-kiosk']);

/** The panel's orientations on this host: the kiosk either way (a monitor may be mounted turned), the till only where it turns. */
export function orientationsOf(screen, host) {
  const square = screen.widthPx === screen.heightPx;
  if (square) return [{ orientation: 'square', widthPx: screen.widthPx, heightPx: screen.heightPx }];
  const land = { orientation: 'landscape', widthPx: screen.widthPx, heightPx: screen.heightPx };
  const port = { orientation: 'portrait', widthPx: screen.heightPx, heightPx: screen.widthPx };
  if (KIOSK_HOSTS.has(host)) return [land, port];
  if (host === 'win-till' && screen.tillRotates) return [land, port];
  return [land];
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/** One screen on one host at one scale: the emulation and what the app decides on it. */
export function hostCase(host, screen, orient, scale) {
  const dipW = Math.round(orient.widthPx / scale);
  const dipH = Math.round(orient.heightPx / scale);
  const id = `${screen.id}@${Math.round(scale * 100)}%-${orient.orientation}`;
  // The panel's pixel pitch (mm): its diagonal over its pixels (the typical one where the owner gave a range).
  const diagonal = screen.diagonalInches ?? screen.approxDiagonal ?? null;
  const pitchMm = diagonal ? (diagonal * 25.4) / Math.hypot(screen.widthPx, screen.heightPx) : 0;
  const base = { host, id, screen: screen.id, orientation: orient.orientation, scale, widthPx: orient.widthPx, heightPx: orient.heightPx, pitchMm };
  if (host === 'win-kiosk') {
    // LAYOUT_AUDIT_ZOOM=legacy: the zoom before the audit (short side / 540, no landscape height floor) — the "before" run.
    const zoom = process.env.LAYOUT_AUDIT_ZOOM === 'legacy' ? Math.max(1, Math.min(3, Math.min(dipW, dipH) / 540)) : kioskWindowZoom(dipW, dipH, null);
    const display = kioskDisplay(displayProfile(browserFacts(dipW, dipH, 1)));
    return { ...base, cssWidth: Math.round(dipW / zoom), cssHeight: Math.round(dipH / zoom), dpr: round3(scale * zoom), outerWidth: dipW, outerHeight: dipH, pageZoom: round3(zoom), profileScale: 1, display };
  }
  if (host === 'android-kiosk') {
    const dpi = Math.round(160 * scale);
    const density = dpi / 160;
    const w = Math.floor(orient.widthPx / density);
    const h = Math.floor(orient.heightPx / density);
    const display = kioskDisplay(displayProfile(browserFacts(w, h, 1)));
    return { ...base, cssWidth: w, cssHeight: h, dpr: density, outerWidth: w, outerHeight: h, pageZoom: 1, profileScale: 1, display };
  }
  // The till, /k and the display: CSS px = DIPs; the profile from the window × the ratio.
  const profile = displayProfile(browserFacts(dipW, dipH, scale));
  const extra = host === 'win-till' ? { tillLayout: tillLayoutOf(profile) } : host === 'web-kiosk' ? { display: kioskDisplay(profile) } : {};
  return { ...base, cssWidth: dipW, cssHeight: dipH, dpr: scale, outerWidth: dipW, outerHeight: dipH, pageZoom: 1, profileScale: profile.scale, profile, ...extra };
}

/** The panel's millimetres per CSS px of the case (pitch × device pixel ratio). */
export function withMm(c) {
  return { ...c, mmPerCssPx: c.pitchMm > 0 ? Math.round(c.pitchMm * c.dpr * 10000) / 10000 : 0 };
}

export function casesFor(host, matrix = loadMatrix()) {
  const out = [];
  for (const screen of matrix.screens) for (const orient of orientationsOf(screen, host)) for (const scale of matrix.scales) out.push(withMm(hostCase(host, screen, orient, scale)));
  return out;
}

/**
 * `--windows 1536x864,1080x1920`: exact windows (in DIPs, at 100% — the owner's screenshots: a 14" panel at 125% is a
 * 1536×864 window) instead of the matrix; a window taller than wide is a portrait one.
 */
export function windowCases(host, spec) {
  return String(spec)
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => {
      const [widthPx, heightPx] = w.split('x').map(Number);
      const orientation = widthPx === heightPx ? 'square' : widthPx > heightPx ? 'landscape' : 'portrait';
      return withMm(hostCase(host, { id: `win-${w}`, diagonalInches: null, widthPx, heightPx }, { orientation, widthPx, heightPx }, 1));
    });
}

/**
 * The cases that draw differently: the same CSS viewport with the same decisions renders the same layout (the
 * pixel ratio only sharpens it). Each render keeps the list of matrix cases it stands for.
 */
export function distinctRenders(cases) {
  const by = new Map();
  for (const c of cases) {
    const key = JSON.stringify([c.cssWidth, c.cssHeight, c.display ?? null, c.profileScale, c.tillLayout ?? null, Math.round(c.pageZoom * 100)]);
    const hit = by.get(key);
    // A render stands for its cases; the target rule takes the smallest millimetre of them (the strictest).
    if (hit) {
      hit.covers.push(c.id);
      if (c.mmPerCssPx > 0 && (hit.mmPerCssPx === 0 || c.mmPerCssPx < hit.mmPerCssPx)) hit.mmPerCssPx = c.mmPerCssPx;
    }
    else by.set(key, { ...c, covers: [c.id] });
  }
  return [...by.values()];
}
