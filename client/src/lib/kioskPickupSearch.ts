/**
 * Finding a kiosk order by its pickup number: "17", "A17", "A-17" and "a-17" all find order A-17
 * (the owner, 09.10.2026). The same rule as the server's app/services/kiosk_pickup.py
 * `parse_pickup_query` and the till's domain/KioskPickupSearch.kt:
 *  - spaces, dashes of every kind and a "#" are dropped, letters upper-cased ("a - 17" → "A17");
 *  - a bare number (1–4 digits) matches every order of that number, whatever its letter;
 *  - with a letter, only that label ("A17" finds A-17, not B-17 or 17);
 *  - a longer number is a document number ("20000057"), never a pickup number.
 */

/** What a search box may hold around a label: spaces and dashes of every kind, a "#". */
const NOISE = /[\s\-‐-―−־#]+/g;
/** A label once normalised: up to 4 letters or digits (3 of the prefix + the offline "L"), then the number. */
const LABEL_KEY = /^[A-Z0-9א-ת]{0,4}?([0-9]{1,4})$/;

export interface PickupQuery {
  /** The label as compared: "A17", "17". */
  key: string;
  /** Its trailing number: 17. */
  number: number;
  /** Nothing but the number: matches every order of that number. */
  digitsOnly: boolean;
}

/** A label or a typed search as compared: no spaces or dashes, upper case ("a-17" → "A17"). */
export function pickupLabelKey(text: string | null | undefined): string {
  return (text ?? '').replace(NOISE, '').toUpperCase();
}

/** What the box asks as a pickup number, or null (a product name, a long document number). */
export function parsePickupQuery(text: string | null | undefined): PickupQuery | null {
  const key = pickupLabelKey(text);
  if (/^[0-9]+$/.test(key)) return key.length <= 4 ? { key, number: Number(key), digitsOnly: true } : null;
  const m = LABEL_KEY.exec(key);
  return m ? { key, number: Number(m[1]), digitsOnly: false } : null;
}

/** Does the order labelled [label] (number [number]) answer [query]? */
export function pickupMatches(query: PickupQuery, label: string | null | undefined, number: number | null | undefined): boolean {
  if (label && pickupLabelKey(label) === query.key) return true;
  return query.digitsOnly && typeof number === 'number' && number === query.number;
}

/** `yyyy-MM-dd` → `dd.MM.yyyy` (the business date beside a pickup number: it comes back daily). */
export function pickupDateText(isoDay: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (isoDay ?? '');
}
