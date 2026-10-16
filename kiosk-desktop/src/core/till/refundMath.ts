/**
 * How much of an original sale is still refundable, and what that slice is worth — the Android till's RefundMath.kt
 * (pos-android domain/RefundMath.kt, itself ported from the desktop's refundHelpers.ts), one to one, in agorot.
 *
 *  - a document can be credited more than once, so "already refunded" is per original LINE (its id), with the product id
 *    only as the legacy fallback (a credit line written before the line id existed);
 *  - what the customer paid per line is its gross less its own discounts (the cashier's, the promotions', the discount
 *    vouchers') less its share of the basket discount (largest remainder, to the agora; a "לא מקבל הנחות" line takes none);
 *  - a credit is cumulative: the rounded share of everything credited up to and including these units, less the rounded
 *    share of what went before — a line returned in any number of pieces credits exactly what was paid for it.
 *
 * Pure.
 */

import { javaRound } from '../money';

/** Marker of the source line in a credit line's `notes` (the legacy form; the column `refundOfItemId` replaced it). */
export const SOURCE_ITEM_PREFIX = 'refund-src:';

export function encodeSourceItemNote(originalItemId: string): string {
  return `${SOURCE_ITEM_PREFIX}${originalItemId}`;
}

export function decodeSourceItemId(notes: string | null | undefined): string | null {
  if (!notes || !notes.startsWith(SOURCE_ITEM_PREFIX)) return null;
  const id = notes.slice(SOURCE_ITEM_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** One line of a document as the refund reads it (TransactionItemEntity's fields that matter). */
export interface RefundItem {
  id: string;
  productId: string;
  quantity: number;
  /** The unit price before any discount, agorot. */
  unitAgorot: number;
  /** The line's own discounts: the cashier's (or OTH's), the promotions' share, the discount vouchers' share. */
  discountAgorot?: number;
  promotionAgorot?: number;
  voucherAgorot?: number;
  /** "לא מקבל הנחות": takes no share of the basket discount. */
  noDiscount?: boolean;
  /** On a credit line: the original line it credits. */
  refundOfItemId?: string | null;
  notes?: string | null;
  /** The original's line details (modifiers, a meal), carried to the credit line. */
  details?: unknown;
}

/** The original line a credit line credits: its own column, else the legacy marker. */
export function sourceItemIdOf(item: Pick<RefundItem, 'refundOfItemId' | 'notes'>): string | null {
  return item.refundOfItemId && item.refundOfItemId.length > 0 ? item.refundOfItemId : decodeSourceItemId(item.notes);
}

/** Quantity already credited, by original line id (marked lines) or by product id (unmarked ones). */
export function refundedQuantities(priorRefundItems: readonly RefundItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of priorRefundItems) {
    const key = sourceItemIdOf(item) ?? item.productId;
    out.set(key, (out.get(key) ?? 0) + item.quantity);
  }
  return out;
}

/** Remaining refundable quantity per original line; never negative. */
export function remainingQuantities(originalItems: readonly RefundItem[], priorRefundItems: readonly RefundItem[]): Map<string, number> {
  const refunded = refundedQuantities(priorRefundItems);
  const out = new Map<string, number>();
  for (const item of originalItems) {
    // Line id first, product id only as the legacy fallback: a marked refund is never counted twice.
    const already = refunded.get(item.id) ?? refunded.get(item.productId) ?? 0;
    out.set(item.id, Math.max(0, item.quantity - already));
  }
  return out;
}

/** Already credited per original line: what [remainingQuantities] took off. */
export function alreadyRefunded(originalItems: readonly RefundItem[], priorRefundItems: readonly RefundItem[]): Map<string, number> {
  const remaining = remainingQuantities(originalItems, priorRefundItems);
  const out = new Map<string, number>();
  for (const item of originalItems) out.set(item.id, Math.max(0, item.quantity - (remaining.get(item.id) ?? 0)));
  return out;
}

export function hasRemaining(originalItems: readonly RefundItem[], priorRefundItems: readonly RefundItem[]): boolean {
  for (const v of remainingQuantities(originalItems, priorRefundItems).values()) if (v > 0) return true;
  return false;
}

/** One line of a credit note: the slice of an original line coming back. */
export interface RefundLine {
  /** The original line this credits (the item's `refundOfItemId`). */
  sourceItemId: string;
  productId: string;
  /** May be fractional: weighed goods come back by weight. */
  quantity: number;
  unitAgorot: number;
  /** What of the gross the customer did not pay: line and basket discount share. */
  discountShareAgorot: number;
  discountType: string | null;
  /** What goes back for this line. */
  totalAgorot: number;
  details?: unknown;
}

const own = (i: RefundItem) => Math.max(0, i.discountAgorot ?? 0) + Math.max(0, i.promotionAgorot ?? 0) + Math.max(0, i.voucherAgorot ?? 0);

/**
 * What the customer actually paid for each line, by line id: its gross less its own discount, less its share of the
 * basket discount ([documentDiscountAgorot] is every discount — line and basket — so the basket part is what is left
 * after the lines' own), shared by value after the lines' own; the agorot that do not divide go to the largest remainders.
 */
export function collectedPerLine(items: readonly RefundItem[], documentDiscountAgorot: number | null = null): Map<string, number> {
  const afterLine = new Map<string, number>();
  for (const item of items) afterLine.set(item.id, javaRound(item.unitAgorot * item.quantity) - own(item));
  const lineDiscounts = items.reduce((s, i) => s + own(i), 0);
  // A product that took no discount ("לא מקבל הנחות") had no share of the basket's.
  const shared = items.filter((i) => !i.noDiscount).map((i) => [i.id, afterLine.get(i.id)!] as const);
  const sumAfterLine = shared.reduce((s, [, a]) => s + a, 0);
  const basket = Math.min(Math.max((documentDiscountAgorot ?? 0) - lineDiscounts, 0), Math.max(sumAfterLine, 0));
  if (basket === 0 || sumAfterLine <= 0) return afterLine;
  // Largest remainder: floor every share, then hand the leftover agorot out.
  const exact = shared.map(([id, a]) => [id, (a * basket) / sumAfterLine] as const);
  const floors = new Map(exact.map(([id, e]) => [id, Math.floor(e)] as const));
  let leftover = basket - [...floors.values()].reduce((s, v) => s + v, 0);
  const extra = new Map<string, number>();
  const order = [...exact].sort((a, b) => b[1] - floors.get(b[0])! - (a[1] - floors.get(a[0])!));
  for (const [id] of order) {
    if (leftover <= 0) break;
    extra.set(id, 1);
    leftover -= 1;
  }
  const out = new Map<string, number>();
  for (const [id, a] of afterLine) out.set(id, a - (floors.get(id) ?? 0) - (extra.get(id) ?? 0));
  return out;
}

/**
 * The money for crediting [quantity] of a line the customer paid [collected] for, [originalQty] in all, [already] of them
 * credited before: cumulative, so pieces add up to exactly what was paid.
 */
export function creditFor(collectedAgorot: number, originalQty: number, already: number, quantity: number): number {
  if (quantity <= 0 || originalQty <= 0) return 0;
  const before = Math.min(Math.max(already, 0), originalQty);
  const after = Math.min(before + quantity, originalQty);
  const share = (q: number) => javaRound(collectedAgorot * (q / originalQty));
  return share(after) - share(before);
}

/**
 * The credit-note lines for [quantities] (original line id → quantity): a line discount and the basket share are
 * apportioned by the fraction returned; unselected lines give none.
 */
export function refundLines(
  originalItems: readonly RefundItem[],
  quantities: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  documentDiscountAgorot: number | null = null,
  alreadyCredited: ReadonlyMap<string, number> = new Map(),
): RefundLine[] {
  const qOf = (id: string) => (quantities instanceof Map ? quantities.get(id) : (quantities as Record<string, number>)[id]) ?? 0;
  const collected = collectedPerLine(originalItems, documentDiscountAgorot);
  const out: RefundLine[] = [];
  for (const item of originalItems) {
    const qty = qOf(item.id);
    if (!(qty > 0)) continue;
    const gross = javaRound(item.unitAgorot * qty);
    const total = creditFor(collected.get(item.id)!, item.quantity, alreadyCredited.get(item.id) ?? 0, qty);
    const discountShare = gross - total;
    out.push({
      sourceItemId: item.id,
      productId: item.productId,
      quantity: qty,
      unitAgorot: item.unitAgorot,
      discountShareAgorot: discountShare,
      // As the original line's own (a discounted line's is "fixed"), or "fixed" for a share of the basket's.
      discountType: discountShare === 0 ? ((item.discountAgorot ?? 0) > 0 ? 'fixed' : null) : 'fixed',
      totalAgorot: total,
      ...(item.details !== undefined ? { details: item.details } : {}),
    });
  }
  return out;
}

/** Value of a refund: exactly the sum of the lines that will be persisted. */
export function refundTotal(
  originalItems: readonly RefundItem[],
  quantities: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  documentDiscountAgorot: number | null = null,
  alreadyCredited: ReadonlyMap<string, number> = new Map(),
): number {
  return refundLines(originalItems, quantities, documentDiscountAgorot, alreadyCredited).reduce((s, l) => s + l.totalAgorot, 0);
}

/** What a credit note gives back, in shekels (creditedShekels) — the one figure a refund's limit is held to. */
export function creditedShekels(lines: readonly Pick<RefundLine, 'totalAgorot'>[]): number {
  return Math.abs(lines.reduce((s, l) => s + l.totalAgorot, 0)) / 100;
}
