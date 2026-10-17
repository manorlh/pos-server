/**
 * Prices by level and in bulk (P:/specs/chain-areas.md §6, §9): the request bodies the dashboard sends and the
 * small formatting the price screens share. Pure — compiled on its own by `npm test` (bulkPrice.test.ts), so no
 * React and no path aliases here.
 */

export type BulkPriceOp = 'set' | 'add' | 'pct';
export type BulkPriceRound = 'none' | '0.90' | '0.50' | '1' | '0.10';

export const BULK_OPS: { id: BulkPriceOp; label: string }[] = [
  { id: 'set', label: 'מחיר חדש' },
  { id: 'add', label: '+₪' },
  { id: 'pct', label: '+%' },
];

export const BULK_ROUNDS: { id: BulkPriceRound; label: string }[] = [
  { id: 'none', label: 'ללא' },
  { id: '0.90', label: '.90' },
  { id: '0.50', label: '.50' },
  { id: '1', label: 'שקל שלם' },
  { id: '0.10', label: "10 אג'" },
];

export interface BulkPriceForm {
  productIds: string[];
  categoryIds: string[];
  op: BulkPriceOp;
  /** As typed. */
  value: string;
  round: BulkPriceRound;
  /** null — the whole shop ("כל הסניף (כל הנקודות)"); a list — those points of sale. */
  areaIds: string[] | null;
  overrideAreas: boolean;
  /** `datetime-local` values ('' — none). */
  startsAt: string;
  endsAt: string;
  label: string;
}

export interface BulkPriceBody {
  productIds?: string[];
  categoryIds?: string[];
  op: BulkPriceOp;
  value: number;
  round: BulkPriceRound;
  areaIds: string[] | null;
  overrideAreas: boolean;
  startsAt?: string;
  endsAt?: string;
  label?: string;
}

/** A typed amount as a number ("12,5" too); null when it is not one. */
export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A `datetime-local` value ("2026-10-20T08:00", the browser's own zone) as ISO with its zone; null when empty / bad. */
export function localToIso(local: string): string | null {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** What is wrong with the form, in Hebrew; null — it can be sent. */
export function bulkFormProblem(form: BulkPriceForm, now: Date = new Date()): string | null {
  if (!form.productIds.length && !form.categoryIds.length) return 'בחרו מוצרים או קטגוריות';
  const value = parseAmount(form.value);
  if (value === null) return 'הזינו ערך';
  if (form.op === 'set' && value < 0) return 'מחיר לא יכול להיות שלילי';
  if (form.areaIds !== null && form.areaIds.length === 0) return 'בחרו נקודת מכירה';
  const starts = localToIso(form.startsAt);
  const ends = localToIso(form.endsAt);
  if (form.startsAt.trim() && !starts) return 'מועד ההתחלה אינו תקין';
  if (form.endsAt.trim() && !ends) return 'מועד הסיום אינו תקין';
  if (ends && new Date(ends).getTime() <= (starts ? new Date(starts).getTime() : now.getTime())) {
    return 'מועד הסיום חייב להיות אחרי ההתחלה';
  }
  return null;
}

/** The body of `POST /shops/{id}/prices/bulk[/preview]`. */
export function bulkPriceBody(form: BulkPriceForm): BulkPriceBody {
  const body: BulkPriceBody = {
    op: form.op,
    value: parseAmount(form.value) ?? 0,
    round: form.round,
    areaIds: form.areaIds === null ? null : [...form.areaIds],
    // Only the shop's own price clears the points of sale's.
    overrideAreas: form.areaIds === null && form.overrideAreas,
  };
  if (form.productIds.length) body.productIds = [...form.productIds];
  if (form.categoryIds.length) body.categoryIds = [...form.categoryIds];
  const starts = localToIso(form.startsAt);
  const ends = localToIso(form.endsAt);
  if (starts) body.startsAt = starts;
  if (ends) body.endsAt = ends;
  if (form.label.trim()) body.label = form.label.trim().slice(0, 120);
  return body;
}

/** "תזמן" rather than "שמור": the change starts later. */
export function isScheduled(form: Pick<BulkPriceForm, 'startsAt'>, now: Date = new Date()): boolean {
  const starts = localToIso(form.startsAt);
  return !!starts && new Date(starts).getTime() > now.getTime();
}

/** "₪12.50" (— for none). */
export function formatShekel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `₪${value.toFixed(2)}`;
}

export type ScheduleStatus = 'pending' | 'applied' | 'reverted' | 'cancelled' | 'failed';

export const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  pending: 'ממתין',
  applied: 'הוחל',
  reverted: 'הוחזר',
  cancelled: 'בוטל',
  failed: 'נכשל',
};

export function scheduleStatusLabel(status: string): string {
  return (SCHEDULE_STATUS_LABEL as Record<string, string>)[status] ?? status;
}

/** The action a schedule offers: a pending one is cancelled, an applied one with an end is put back now. */
export function scheduleAction(status: string, endsAt: string | null | undefined): 'cancel' | 'revert' | null {
  if (status === 'pending') return 'cancel';
  if (status === 'applied' && endsAt) return 'revert';
  return null;
}

/** The level a price row speaks of. */
export const PRICE_LEVEL_LABEL: Record<string, string> = { base: 'רשת', shop: 'סניף', area: 'נקודת מכירה' };

/** Toggle one id in a list (order kept). */
export function toggleId(ids: readonly string[], id: string, on: boolean): string[] {
  const has = ids.includes(id);
  if (on && !has) return [...ids, id];
  if (!on && has) return ids.filter((x) => x !== id);
  return [...ids];
}

/**
 * The `areaIds` of `PUT /products/{id}/areas`: every live point of sale picked → null ("כל הנקודות"), else the
 * picked ones (an empty list — the shop stops selling it).
 */
export function productAreasPayload(allAreaIds: readonly string[], picked: readonly string[]): string[] | null {
  const set = new Set(picked);
  if (allAreaIds.length > 0 && allAreaIds.every((id) => set.has(id))) return null;
  return allAreaIds.filter((id) => set.has(id));
}

/** A price input's value as the API's `price` (null — back to the level above); undefined — not a price. */
export function priceInput(raw: string): number | null | undefined {
  if (!raw.trim()) return null;
  const n = parseAmount(raw);
  if (n === null || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}
