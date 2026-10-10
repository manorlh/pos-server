/**
 * Prepaid vouchers ("שוברי הפקה") on the dashboard: what the batch form says before it is sent,
 * and the batch list's filters. Pure, so `npm test` covers them (lib/prepaidBatchForm.test.ts).
 */

/** Why "צור" is not available yet — each a key of `prepaidVouchers.create.problem`. */
export type BatchFormProblem = 'name' | 'company' | 'items' | 'terms' | 'maxVouchers' | 'count' | 'dates' | 'groupSize';

export interface BatchFormDraft {
  name: string;
  companyId: string;
  discount: boolean;
  itemCount: number;
  termErrors: number;
  count: number;
  groupOk: boolean;
  /** yyyy-mm-dd, or empty. */
  validFrom: string;
  validUntil: string;
  /** "מספר שוברים מקסימלי בעסקה" is empty or a whole number in range (absent: true). */
  stackingOk?: boolean;
}

/** Everything the form still needs, in the form's order (empty: it may be created). */
export function batchFormProblems(d: BatchFormDraft): BatchFormProblem[] {
  const out: BatchFormProblem[] = [];
  if (!d.name.trim()) out.push('name');
  if (!d.companyId) out.push('company');
  if (d.discount ? d.termErrors > 0 : d.itemCount === 0) out.push(d.discount ? 'terms' : 'items');
  if (d.stackingOk === false) out.push('maxVouchers');
  if (!Number.isFinite(d.count) || d.count < 1 || d.count > 5000) out.push('count');
  if (!d.groupOk) out.push('groupSize');
  if (d.validFrom && d.validUntil && d.validFrom > d.validUntil) out.push('dates');
  return out;
}

export interface IssueTotals {
  /** Units by the piece the whole run entitles to (100 vouchers × 3 = 300). */
  units: number;
  /** Weighed goods, per unit label ("ק״ג"): the run's total. */
  weights: { unit: string; quantity: number }[];
}

/**
 * What a run of [count] vouchers entitles to in all — the spec's "100 שוברים מסוג ארוחה, הכוללים
 * זכאות ל-300 יחידות", shown before the run is issued.
 */
export function issueTotals(
  count: number,
  items: { quantity: number; weighed?: boolean; unitLabel?: string | null }[],
  defaultUnit: string,
): IssueTotals {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  let units = 0;
  const weights = new Map<string, number>();
  for (const i of items) {
    if (i.weighed) {
      const unit = i.unitLabel || defaultUnit;
      weights.set(unit, Math.round(((weights.get(unit) ?? 0) + i.quantity * n) * 1000) / 1000);
    } else {
      units += i.quantity * n;
    }
  }
  return { units, weights: Array.from(weights, ([unit, quantity]) => ({ unit, quantity })) };
}

export type BatchStatusFilter = 'all' | 'active' | 'cancelled';
export type BatchKindFilter = 'all' | 'items' | 'discount';

export interface BatchFilters {
  search: string;
  status: BatchStatusFilter;
  kind: BatchKindFilter;
  /** '' : every company. */
  companyId: string;
}

export const NO_BATCH_FILTERS: BatchFilters = { search: '', status: 'all', kind: 'all', companyId: '' };

interface FilterableBatch {
  name: string;
  eventName?: string | null;
  customerName?: string | null;
  orderRef?: string | null;
  status: string;
  kind?: string | null;
  companyId: string;
}

/** The batches the list shows under [f]: free text over name, event, customer and order. */
export function filterBatches<B extends FilterableBatch>(batches: B[], f: BatchFilters): B[] {
  const words = f.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return batches.filter((b) => {
    if (f.status !== 'all' && b.status !== f.status) return false;
    const discount = !!b.kind && b.kind !== 'items';
    if (f.kind === 'items' && discount) return false;
    if (f.kind === 'discount' && !discount) return false;
    if (f.companyId && b.companyId !== f.companyId) return false;
    const hay = [b.name, b.eventName, b.customerName, b.orderRef].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
