/**
 * "ערוך סדרה" — editing a batch after it was set up (the cloud's app/services/prepaid_voucher_edit.py).
 *
 * The form sends only what changed ([changedFields]); the cloud plans it first
 * (`POST …/edit-preview`): each change before → after with its category, and what it touches.
 * Free changes (texts, print settings) are saved at once; anything else is confirmed first with
 * that list ("ישפיע על 340 שוברים שטרם מומשו").
 */

export type PrepaidEditCategory = 'free' | 'validity' | 'where' | 'rules' | 'accounting' | 'contents' | 'quantity' | 'price';

/** The order the confirmation lists them in (the cloud's FIELDS order). */
export const EDIT_CATEGORIES: readonly PrepaidEditCategory[] = [
  'free', 'validity', 'where', 'rules', 'accounting', 'contents', 'quantity', 'price',
];

export interface PrepaidBatchEditChange {
  /** The setting's wire name (`validUntil`, `items`, `productionPrice`…). */
  field: string;
  category: PrepaidEditCategory;
  before: unknown;
  after: unknown;
}

export interface PrepaidBatchEditEffects {
  free?: { reprintSameCodes: boolean };
  /** Open vouchers: unredeemed or partly redeemed. */
  validity?: { vouchers: number };
  where?: { vouchers: number; offlineAssigned?: boolean };
  rules?: { vouchers: number };
  accounting?: { vouchers: number };
  contents?: { unredeemed: number; partial: number; applyToPartial: boolean; vouchers: number };
  quantity?: { issued: number; issue: number };
  price?: { fromSerial: number; issued: number };
}

export interface PrepaidBatchEditPlan {
  changes: PrepaidBatchEditChange[];
  effects: PrepaidBatchEditEffects;
  /** Anything but free changes: confirmed first. */
  confirm: boolean;
}

/** What a voucher gives: changing it asks whether the partly redeemed ones take it too. */
export const CONTENT_FIELDS: readonly string[] = [
  'items', 'includeExtras', 'splitAllowed', 'discountType', 'discountValue', 'minPurchase', 'maxDiscount',
  'maxUnits', 'targets', 'usesPerVoucher', 'selection', 'groups', 'totalQty', 'catalogMode',
];

/** A value with its object keys in order, so two equal settings compare equal whatever built them. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v === undefined ? null : v;
}

export function sameSetting(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The fields of [next] that differ from [base]: the PATCH body (nothing changed: empty). */
export function changedFields<T extends Record<string, unknown>>(base: T, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (!sameSetting(base[key], next[key])) out[key] = next[key];
  }
  return out;
}

/** Whether [body] changes what a voucher gives. */
export function touchesContents(body: Record<string, unknown>): boolean {
  return CONTENT_FIELDS.some((f) => f in body);
}

/** The plan's changes by category, in the confirmation's order (empty categories left out). */
export function changesByCategory(plan: Pick<PrepaidBatchEditPlan, 'changes'>): { category: PrepaidEditCategory; changes: PrepaidBatchEditChange[] }[] {
  return EDIT_CATEGORIES
    .map((category) => ({ category, changes: plan.changes.filter((c) => c.category === category) }))
    .filter((g) => g.changes.length > 0);
}

/** How the confirmation words a value (the page passes its own texts and formats). */
export interface EditValueFormat {
  money: (shekels: number) => string;
  date: (iso: string) => string;
  yes: string;
  no: string;
  /** An empty value: no date, no text, every shop, no maximum. */
  none: (field: string) => string;
  /** A choice's label (`redemptionAccounting` "discount" → "קיזוז מהחשבונית"); null: as it is. */
  choice: (field: string, value: string) => string | null;
  shopName: (id: string) => string;
}

const MONEY_FIELDS = new Set(['tillValue', 'productionPrice', 'minPurchase', 'maxDiscount']);
const DATE_FIELDS = new Set(['validFrom', 'validUntil']);

function quantityText(q: unknown): string {
  const n = Number(q);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(q);
}

/** One side of a change as the owner reads it. */
export function editValueText(field: string, value: unknown, f: EditValueFormat): string {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return f.none(field);
  }
  if (typeof value === 'boolean') return value ? f.yes : f.no;
  if (MONEY_FIELDS.has(field) && typeof value === 'number') return f.money(value);
  if (field === 'discountValue' && typeof value === 'number') return String(value);
  if (DATE_FIELDS.has(field) && typeof value === 'string') return f.date(value);
  if (field === 'shopIds' && Array.isArray(value)) return value.map((id) => f.shopName(String(id))).join(', ');
  if (field === 'items' && Array.isArray(value)) {
    return value
      .map((i) => {
        const row = i as { name?: string; quantity?: unknown; unitLabel?: string | null };
        return row.unitLabel ? `${quantityText(row.quantity)} ${row.unitLabel} ${row.name ?? ''}`.trim() : `${quantityText(row.quantity)}× ${row.name ?? ''}`.trim();
      })
      .join(', ');
  }
  if (field === 'targets' && value && typeof value === 'object') {
    const names = (value as { names?: string[] }).names ?? [];
    return names.length ? names.join(', ') : f.none(field);
  }
  if (field === 'groups' && Array.isArray(value)) {
    return value.map((g) => {
      const row = g as { name?: string; minQty?: number; maxQty?: number };
      return `${row.name ?? ''} (${row.minQty ?? 0}–${row.maxQty ?? 0})`;
    }).join(', ');
  }
  if (field === 'discountBlockPolicy' && value && typeof value === 'object') {
    const mode = String((value as { mode?: string }).mode ?? 'honour');
    return f.choice(field, mode) ?? mode;
  }
  if (typeof value === 'string') return f.choice(field, value) ?? value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}
