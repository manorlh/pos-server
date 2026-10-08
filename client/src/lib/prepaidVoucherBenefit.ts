/**
 * Prepaid voucher kinds (docs/SPEC_VOUCHER_PRODUCTION.md §7): goods (`items`, a tender), a
 * discount on the whole sale (`order_discount`) or on chosen items (`item_discount`) — the
 * last two a discount on the document, never a tender.
 *
 * [benefitText] is what a discount voucher says it gives ("₪30 הנחה על כל ההזמנה", "20% הנחה
 * על קפה") — the server prints the same words on the PDF (prepaid_voucher_rules.benefit_text),
 * both pinned by server/tests/fixtures/prepaid_voucher_rules.json.
 */

export type PrepaidVoucherKind = 'items' | 'order_discount' | 'item_discount';
export type PrepaidDiscountType = 'fixed' | 'percent';
/** Other vouchers in the same sale: none (the default), only of other batches, any. */
export type PrepaidStacking = 'single' | 'distinct_batches' | 'unlimited';
/** A discount voucher on a promoted line: never (default), the better of the two, both. */
export type PrepaidPromotionPolicy = 'exclude' | 'best' | 'combine';

export const PREPAID_KINDS: PrepaidVoucherKind[] = ['items', 'order_discount', 'item_discount'];
export const PREPAID_STACKING: PrepaidStacking[] = ['single', 'distinct_batches', 'unlimited'];
export const PREPAID_PROMOTION_POLICIES: PrepaidPromotionPolicy[] = ['exclude', 'best', 'combine'];

export function isDiscountKind(kind: PrepaidVoucherKind | null | undefined): boolean {
  return kind === 'order_discount' || kind === 'item_discount';
}

/** ₪30, ₪12.50 — whole shekels without decimals. */
export function moneyText(agorot: number): string {
  const a = Math.round(agorot);
  if (a % 100 === 0) return `₪${a / 100}`;
  return `₪${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** 20%, 12.5% — from basis points (2000 = 20%), no trailing zeros. */
export function percentText(basisPoints: number): string {
  return `${Number((Math.round(basisPoints) / 100).toFixed(2))}%`;
}

export interface BenefitTerms {
  kind: PrepaidVoucherKind;
  discountType?: PrepaidDiscountType | null;
  /** Agorot (fixed) or basis points (percent). */
  value?: number | null;
  minPurchaseAgorot?: number | null;
  maxDiscountAgorot?: number | null;
  maxUnits?: number | null;
  names?: string[];
}

/** What a discount voucher gives, in Hebrew; null for goods (or incomplete terms). */
export function benefitText(t: BenefitTerms): string | null {
  if (!isDiscountKind(t.kind) || t.value == null || (t.discountType !== 'fixed' && t.discountType !== 'percent')) return null;
  const amount = t.discountType === 'fixed' ? moneyText(t.value) : percentText(t.value);
  if (t.kind === 'order_discount') {
    let text = `${amount} הנחה על כל ההזמנה`;
    if (t.discountType === 'percent' && t.maxDiscountAgorot) text += ` (עד ${moneyText(t.maxDiscountAgorot)})`;
    if (t.minPurchaseAgorot) text += ` בקנייה מעל ${moneyText(t.minPurchaseAgorot)}`;
    return text;
  }
  const names = (t.names ?? []).map((n) => n.trim()).filter(Boolean);
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ' ועוד' : '');
  let text = `${amount} הנחה על ${shown || 'פריטים נבחרים'}`;
  if (t.maxUnits && t.maxUnits > 1) text += ` (עד ${t.maxUnits} יחידות)`;
  return text;
}

/** A batch as the API returns it (₪ and %), as [BenefitTerms] (agorot and basis points). */
export function termsOfBatch(b: {
  kind?: PrepaidVoucherKind;
  discountType?: PrepaidDiscountType | null;
  discountValue?: number | null;
  minPurchase?: number | null;
  maxDiscount?: number | null;
  maxUnits?: number | null;
  targets?: { names?: string[] } | null;
}): BenefitTerms {
  const x100 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));
  return {
    kind: b.kind ?? 'items',
    discountType: b.discountType ?? null,
    value: x100(b.discountValue),
    minPurchaseAgorot: x100(b.minPurchase),
    maxDiscountAgorot: x100(b.maxDiscount),
    maxUnits: b.maxUnits ?? null,
    names: b.targets?.names ?? [],
  };
}

/**
 * What a voucher prints between its title and its free text — the server's PDF says the same
 * (`card_contents`, app/services/prepaid_voucher_pdf.py): a discount voucher's benefit
 * ("₪30 הנחה על כל ההזמנה"), or the goods; neither when the batch hides them
 * ("הצגת הפריטים על השובר" off, `showItems: false`; absent: shown).
 */
export function cardContents<I>(
  b: Parameters<typeof termsOfBatch>[0] & { items: I[]; showItems?: boolean; benefitText?: string | null },
): { benefit: string | null; items: I[] } {
  if (b.showItems === false) return { benefit: null, items: [] };
  const benefit = isDiscountKind(b.kind) ? (b.benefitText ?? benefitText(termsOfBatch(b))) : null;
  return { benefit, items: benefit ? [] : b.items };
}

export interface DiscountDraft {
  kind: PrepaidVoucherKind;
  discountType: PrepaidDiscountType;
  /** As typed: ₪ for fixed, % for percent. */
  value: string;
  minPurchase: string;
  maxDiscount: string;
  targetCount: number;
  maxUnits: string;
  usesPerVoucher: string;
  maxUsesPerSale: string;
  maxUsesPerDay: string;
}

export type DiscountDraftError =
  | 'value' | 'percentOver100' | 'minPurchase' | 'maxDiscount' | 'targets' | 'maxUnits' | 'uses' | 'usesPerSale' | 'usesPerDay';

function num(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function wholeIn(text: string, min: number, max: number, optional: boolean): boolean {
  const n = num(text);
  if (n === null) return optional;
  return Number.isInteger(n) && n >= min && n <= max;
}

/** What is wrong with a discount voucher's terms on the form (empty: nothing; goods: always empty). */
export function discountDraftErrors(d: DiscountDraft): DiscountDraftError[] {
  if (!isDiscountKind(d.kind)) return [];
  const out: DiscountDraftError[] = [];
  const value = num(d.value);
  if (value === null || Number.isNaN(value) || value <= 0 || value > 100000) out.push('value');
  else if (d.discountType === 'percent' && value > 100) out.push('percentOver100');
  const min = num(d.minPurchase);
  if (d.kind === 'order_discount' && min !== null && (Number.isNaN(min) || min < 0)) out.push('minPurchase');
  const cap = num(d.maxDiscount);
  if (d.kind === 'order_discount' && d.discountType === 'percent' && cap !== null && (Number.isNaN(cap) || cap < 0)) {
    out.push('maxDiscount');
  }
  if (d.kind === 'item_discount') {
    if (d.targetCount < 1) out.push('targets');
    if (!wholeIn(d.maxUnits, 1, 100, true)) out.push('maxUnits');
  }
  if (!wholeIn(d.usesPerVoucher, 1, 1000, false)) out.push('uses');
  if (!wholeIn(d.maxUsesPerSale, 1, 1000, false)) out.push('usesPerSale');
  if (!wholeIn(d.maxUsesPerDay, 1, 1000, true)) out.push('usesPerDay');
  return out;
}
