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

import type { BoardNumber, BoardThemeName } from './kdsScreenTypes';

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

// The board's look (`device.display`: theme, accent, title, sound, the "בהכנה" column, the layout,
// how long a number stays ready, the media panel) is read in screenLook.ts with the kitchen's.
export { DEFAULT_BOARD_DISPLAY, boardDisplayOf, textOn } from './screenLook';

export const BOARD_THEMES: readonly BoardThemeName[] = ['dark', 'light', 'contrast', 'brand'];

/** The newest ready number first (the "מוכן עכשיו" spotlight); the cloud already sends them so. */
export function newestFirst(list: readonly BoardNumber[]): BoardNumber[] {
  return [...list].sort((a, b) => (Date.parse(b.since ?? '') || 0) - (Date.parse(a.since ?? '') || 0));
}

/** The ready numbers still on the board after `minutes` (the cloud applies it; the demo and an old board too). */
export function readyWithin(list: readonly BoardNumber[], minutes: number | null, nowMs: number): BoardNumber[] {
  if (!minutes) return [...list];
  return list.filter((n) => {
    const t = Date.parse(n.since ?? '');
    return !Number.isFinite(t) || nowMs - t <= minutes * 60_000;
  });
}

/**
 * How many numbers fit a grid of `count` on a panel `w` × `h` (any unit): the columns and the rows
 * that give the biggest square-ish tiles — the "רשת מספרים" board and the media layouts' panel.
 */
export function gridFit(count: number, w: number, h: number, aspect = 1.6): { cols: number; rows: number } {
  const n = Math.max(1, count);
  let best = { cols: 1, rows: n, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    // A tile is about `aspect` × as wide as high (3–4 digits).
    const size = Math.min(w / cols / aspect, h / rows);
    if (size > best.size) best = { cols, rows, size };
  }
  return { cols: best.cols, rows: best.rows };
}
