import type { PosMachine } from '@/lib/types';

/**
 * A terminal's register number in its shop — the "2" in "קופה 2" — or null.
 *
 * Null whenever there is no shop: the number only means something inside a shop's run,
 * and the server clears it when a machine leaves one. Never 0 and never NaN, so a caller
 * that renders only non-null values cannot print a number that is not there.
 */
export function registerNumberOf(m: Pick<PosMachine, 'shopId' | 'posNumber'>): number | null {
  if (!m.shopId || m.posNumber == null) return null;
  const raw = String(m.posNumber).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/**
 * Order within a shop: by register number, so the list reads 1, 2, 3 the way the
 * counter does. A terminal without a number (not yet assigned by an older build, or
 * mid-move) sorts after the numbered ones, by name.
 */
export function compareByRegisterNumber(
  a: Pick<PosMachine, 'shopId' | 'posNumber' | 'name'>,
  b: Pick<PosMachine, 'shopId' | 'posNumber' | 'name'>,
): number {
  const na = registerNumberOf(a);
  const nb = registerNumberOf(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;
  return a.name.localeCompare(b.name, 'he-IL', { sensitivity: 'base' });
}
