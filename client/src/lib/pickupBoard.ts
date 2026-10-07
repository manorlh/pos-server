/**
 * "מסך מוכן / לא מוכן" — the order status board's rules (pure): the cloud's pickup payload
 * (`GET /sync/{m}/kds/board` for a `pickup` KDS device → `pickup: {preparing, ready}`,
 * server app/services/kds.py `pickup_board`) made safe to show, which numbers just turned
 * ready (the chime and the flash), and the board's look (`device.display`, set on the dashboard's
 * KDS page).
 *
 * Numbers only: the payload never carries a name, a phone or a note, and nothing here adds one.
 *
 * Shared by the Windows app (kiosk-desktop/src/core/pickupBoard.ts re-exports it) and the browser
 * board at `/board`; self-contained (no `@/` imports).
 */

import type { BoardDisplay, BoardNumber, BoardThemeName } from './kdsScreenTypes';

function clean(list: unknown): BoardNumber[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: BoardNumber[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const raw = (x as { number?: unknown }).number;
    const number = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!number || number.length > 12 || seen.has(number)) continue;
    seen.add(number);
    const since = (x as { since?: unknown }).since;
    out.push({ number, since: typeof since === 'string' ? since : null });
  }
  return out;
}

/** The two columns from the payload. A number both preparing and ready is ready. */
export function boardOf(pickup: unknown): { preparing: BoardNumber[]; ready: BoardNumber[] } {
  const p = pickup && typeof pickup === 'object' ? (pickup as Record<string, unknown>) : {};
  const ready = clean(p.ready);
  const readySet = new Set(ready.map((n) => n.number));
  const preparing = clean(p.preparing).filter((n) => !readySet.has(n.number));
  return { preparing, ready };
}

/** Numbers ready now that were not ready before (the first board announces nothing). */
export function newlyReady(prev: BoardNumber[] | null, next: BoardNumber[]): string[] {
  if (prev === null) return [];
  const before = new Set(prev.map((n) => n.number));
  return next.filter((n) => !before.has(n.number)).map((n) => n.number);
}

/** How many numbers fit a column of the given size (big digits first, then smaller). */
export function columnFit(count: number): { cols: number; size: 'xl' | 'lg' | 'md' } {
  if (count <= 6) return { cols: 2, size: 'xl' };
  if (count <= 12) return { cols: 3, size: 'lg' };
  return { cols: 4, size: 'md' };
}

/* -------------------------------------------------------------------- the look */

export const BOARD_THEMES: readonly BoardThemeName[] = ['dark', 'light', 'contrast', 'brand'];

export const DEFAULT_BOARD_DISPLAY: BoardDisplay = { theme: 'dark', accent: null, sound: true, showPreparing: true, title: null };

const HEX = /^#[0-9a-f]{6}$/i;

/** The cloud's `device.display` (or a URL's `?theme=`), cleaned: unknown values fall back to the defaults. */
export function boardDisplayOf(raw: unknown): BoardDisplay {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const theme = typeof r.theme === 'string' && (BOARD_THEMES as readonly string[]).includes(r.theme) ? (r.theme as BoardThemeName) : DEFAULT_BOARD_DISPLAY.theme;
  const accent = typeof r.accent === 'string' && HEX.test(r.accent.trim()) ? r.accent.trim().toLowerCase() : null;
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 60) : null;
  return {
    theme,
    accent,
    sound: r.sound !== false,
    showPreparing: r.showPreparing !== false,
    title,
  };
}

/** Black or white text on a "#rrggbb" background (WCAG relative luminance). */
export function textOn(hex: string): '#000000' | '#ffffff' {
  if (!HEX.test(hex)) return '#ffffff';
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  // The colour where black and white text have the same contrast ratio.
  return l > 0.179 ? '#000000' : '#ffffff';
}
