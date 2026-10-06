/**
 * "מסך מוכן / לא מוכן" — the order status board's rules (pure): the cloud's pickup payload
 * (`GET /sync/{m}/kds/board` for a `pickup` KDS device → `pickup: {preparing, ready}`,
 * server app/services/kds.py `pickup_board`) made safe to show, and which numbers just turned
 * ready (the chime and the flash).
 *
 * Numbers only: the payload never carries a name, a phone or a note, and nothing here adds one.
 */

import type { BoardNumber } from '../shared/roles';

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
