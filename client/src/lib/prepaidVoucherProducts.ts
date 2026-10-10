/**
 * Prepaid vouchers and every product type in the catalog (pos-server
 * docs/SPEC_VOUCHER_PRODUCTION.md §7.14; the owner, 07.10.2026: "תוודא ששוברי הפקה תומכים בכל
 * סוגי המוצרים בקטלוג").
 *
 * The pickers show every product the owner may look for, each with whether it can go on the batch
 * — as a goods voucher's item, as an item discount's target — and why not, as the cloud answers
 * (`GET /prepaid-vouchers/products`, the save's own rule). Pure: no React, no network.
 */

/** Why a product cannot go on a batch. */
export type PrepaidProductBlock = 'general' | 'open_price' | 'no_discount' | 'other_company' | 'till_shop';

/** What the owner should know about a product that can go on a batch. */
export type PrepaidProductNote =
  | 'weighed' | 'options' | 'meal' | 'open_price' | 'kiosk_only' | 'pos_only' | 'ticket' | 'gift_voucher'
  | 'not_listed' | 'till_made' | 'unavailable';

/** What a product is picked for: a goods voucher's item, an item discount's target. */
export type PrepaidProductPurpose = 'items' | 'item_discount';

/** A product as the pickers show it. */
export interface PrepaidProductOption {
  id: string;
  name: string;
  /** The base price (a product sold by weight: per its unit). */
  price: number;
  sku?: string | null;
  isWeighed?: boolean;
  unitLabel?: string | null;
  isOpenPrice?: boolean;
  isGeneral?: boolean;
  /** Null: usable. Absent (an older server): usable. */
  blocked?: { goods: PrepaidProductBlock | null; itemDiscount: PrepaidProductBlock | null };
  notes?: PrepaidProductNote[];
  /** Made on a till: its shop. */
  shopName?: string | null;
  /** Another company's: which. */
  companyName?: string | null;
}

/** What a weighed item without a unit of its own is counted in (the cloud's `DEFAULT_WEIGHT_UNIT`). */
export const DEFAULT_WEIGHT_UNIT = 'ק"ג';

/** The most of one item on a goods voucher (the cloud's `MAX_ITEM_QUANTITY`). */
export const MAX_ITEM_QUANTITY = 100;

const BLOCKS: readonly PrepaidProductBlock[] = ['general', 'open_price', 'no_discount', 'other_company', 'till_shop'];
const NOTES: readonly PrepaidProductNote[] = [
  'weighed', 'options', 'meal', 'open_price', 'kiosk_only', 'pos_only', 'ticket', 'gift_voucher', 'not_listed',
  'till_made', 'unavailable',
];

/** One row of `GET /prepaid-vouchers/products`; unknown codes are dropped (a newer server). */
export function prepaidProductOf(p: Record<string, unknown>): PrepaidProductOption {
  const blocked = p.blocked as { goods?: unknown; itemDiscount?: unknown } | null | undefined;
  const block = (v: unknown) => (BLOCKS.includes(v as PrepaidProductBlock) ? (v as PrepaidProductBlock) : null);
  return {
    id: String(p.id),
    name: String(p.name ?? ''),
    price: Number(p.price ?? 0),
    sku: typeof p.sku === 'string' ? p.sku : null,
    isWeighed: p.isWeighed === true,
    unitLabel: typeof p.unitLabel === 'string' && p.unitLabel ? p.unitLabel : null,
    isOpenPrice: p.isOpenPrice === true,
    isGeneral: p.isGeneral === true,
    blocked: { goods: block(blocked?.goods), itemDiscount: block(blocked?.itemDiscount) },
    notes: Array.isArray(p.notes) ? (p.notes.filter((n) => NOTES.includes(n as PrepaidProductNote)) as PrepaidProductNote[]) : [],
    shopName: typeof p.shopName === 'string' ? p.shopName : null,
    companyName: typeof p.companyName === 'string' ? p.companyName : null,
  };
}

/** Why [p] cannot be used for [purpose], or null. */
export function prepaidBlockOf(p: PrepaidProductOption, purpose: PrepaidProductPurpose): PrepaidProductBlock | null {
  return (purpose === 'item_discount' ? p.blocked?.itemDiscount : p.blocked?.goods) ?? null;
}

/**
 * The badge key (under `prepaidVouchers.eligibility.blocked`) for why [p] cannot be used: the
 * general item reads differently on an item discount's picker ("רק הנחה על כל העסקה").
 */
export function blockKeyOf(p: PrepaidProductOption, purpose: PrepaidProductPurpose): string | null {
  const block = prepaidBlockOf(p, purpose);
  if (block === 'general' && purpose === 'item_discount') return 'generalItem';
  return block;
}

/**
 * The notes to show for [p] on the [purpose] picker, as keys under
 * `prepaidVouchers.eligibility.notes`: what a goods voucher covers is not what a discount takes.
 * Nothing for a product that cannot be used (its reason is enough).
 */
export function noteKeysOf(p: PrepaidProductOption, purpose: PrepaidProductPurpose): string[] {
  if (prepaidBlockOf(p, purpose)) return [];
  const discount = purpose === 'item_discount';
  const out: string[] = [];
  for (const note of p.notes ?? []) {
    if (note === 'open_price' && !discount) continue; // a goods voucher refuses it: the reason says so
    if (note === 'till_made') out.push(p.shopName ? 'till_made' : 'till_made_plain');
    else if (discount && (note === 'weighed' || note === 'options' || note === 'meal')) out.push(`${note}Discount`);
    else out.push(note);
  }
  return out;
}

/** [value] to three decimals, as the cloud keeps a weight (thousandths). */
function thousandths(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** "2", "0.5", "1.25" — no trailing zeros. */
export function quantityNumberText(quantity: number): string {
  return String(thousandths(quantity));
}

/** The quantity column of a goods line: "2×", or by weight "0.5 ק״ג". */
export function quantityText(quantity: number, weighed?: boolean, unitLabel?: string | null): string {
  return weighed ? `${quantityNumberText(quantity)} ${unitLabel || DEFAULT_WEIGHT_UNIT}` : `${quantityNumberText(quantity)}×`;
}

/** One goods line as printed — the cloud's `item_text`: "2× נקניקייה", "0.5 ק״ג זיתים". */
export function itemText(item: { name: string; quantity: number; weighed?: boolean; unitLabel?: string | null }): string {
  return `${quantityText(item.quantity, item.weighed, item.unitLabel)} ${item.name}`;
}

/**
 * A goods quantity as the form keeps it: by weight, to the gram (0.001) — never 0; by the piece,
 * a whole unit. Both between the least and [MAX_ITEM_QUANTITY].
 */
export function clampQuantity(quantity: number, weighed?: boolean): number {
  if (!Number.isFinite(quantity)) return weighed ? 0.5 : 1;
  if (weighed) return Math.min(MAX_ITEM_QUANTITY, Math.max(0.001, thousandths(quantity)));
  return Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.round(quantity)));
}

/** The +/- step of a goods quantity: half a unit by weight (0.5 ק״ג), one by the piece. */
export function quantityStep(weighed?: boolean): number {
  return weighed ? 0.5 : 1;
}

/** Usable for [purpose] first, then by name — as the cloud sorts (kept when a list is merged). */
export function sortForPurpose(rows: readonly PrepaidProductOption[], purpose: PrepaidProductPurpose): PrepaidProductOption[] {
  return [...rows].sort((a, b) => {
    const ba = prepaidBlockOf(a, purpose) ? 1 : 0;
    const bb = prepaidBlockOf(b, purpose) ? 1 : 0;
    return ba - bb || a.name.localeCompare(b.name, 'he');
  });
}
