/**
 * "זיכוי" — how much of a document is still refundable and what that slice is worth (core/till/refundMath.ts), the Android
 * till's RefundMathTest and MixedBasketTest's money cases, case for case: over-refunding is giving money away, under-refunding
 * short-changes a customer, and partial credits against the same document are where both happen.
 */

import { describe, expect, it } from 'vitest';
import { acquirerTransactionIdOf, refundFrame } from '../src/core/nayax';
import {
  collectedPerLine,
  creditFor,
  creditedShekels,
  decodeSourceItemId,
  encodeSourceItemNote,
  hasRemaining,
  refundLines,
  refundTotal,
  remainingQuantities,
  sourceItemIdOf,
  type RefundItem,
} from '../src/core/till/refundMath';

const sh = (shekels: number) => Math.round(shekels * 100);

/** A line as the Android test builds it: unit price and a line discount in shekels. */
function line(id: string, productId: string, qty: number, unitShekels: number, discountShekels?: number, notes?: string): RefundItem {
  return { id, productId, quantity: qty, unitAgorot: sh(unitShekels), discountAgorot: discountShekels !== undefined ? sh(discountShekels) : 0, notes: notes ?? null };
}

/** A refund line as recordRefund writes it: marked with its source line id. */
const refundOf = (id: string, source: RefundItem, qty: number): RefundItem => line(id, source.productId, qty, source.unitAgorot / 100, undefined, encodeSourceItemNote(source.id));

const asObj = (m: Map<string, number>) => Object.fromEntries(m);

describe('RefundMath (RefundMathTest)', () => {
  it('nothing refunded leaves the full quantity', () => {
    const original = [line('l1', 'p1', 3, 10)];
    expect(asObj(remainingQuantities(original, []))).toEqual({ l1: 3 });
    expect(hasRemaining(original, [])).toBe(true);
  });

  it('a partial credit reduces what is left', () => {
    const original = [line('l1', 'p1', 3, 10)];
    expect(asObj(remainingQuantities(original, [refundOf('r1', original[0], 1)]))).toEqual({ l1: 2 });
  });

  it('credits accumulate across separate refund documents', () => {
    const original = [line('l1', 'p1', 2, 10)];
    const prior = [refundOf('r1', original[0], 1), refundOf('r2', original[0], 1)];
    expect(asObj(remainingQuantities(original, prior))).toEqual({ l1: 0 });
    expect(hasRemaining(original, prior)).toBe(false);
  });

  it('remaining never goes negative', () => {
    const original = [line('l1', 'p1', 1, 10)];
    expect(remainingQuantities(original, [refundOf('r1', original[0], 5)]).get('l1')).toBe(0);
  });

  it('lines are tracked independently', () => {
    const original = [line('l1', 'p1', 2, 10), line('l2', 'p2', 4, 5)];
    const remaining = remainingQuantities(original, [refundOf('r1', original[1], 3)]);
    expect(remaining.get('l1')).toBe(2);
    expect(remaining.get('l2')).toBe(1);
  });

  it('two lines of the same product are tracked separately', () => {
    const big = line('l1', 'p1', 5, 10);
    const small = line('l2', 'p1', 2, 10);
    const original = [big, small];
    const remaining = remainingQuantities(original, [refundOf('r1', big, 5)]);
    expect(remaining.get('l1')).toBe(0);
    expect(remaining.get('l2')).toBe(2);
    // The total still creditable is the smaller line only — never the whole document.
    expect(refundTotal(original, remaining)).toBe(sh(20));
  });

  it('refunding the same product twice cannot exceed what was sold', () => {
    const big = line('l1', 'p1', 5, 10);
    const small = line('l2', 'p1', 2, 10);
    const original = [big, small];
    const prior = [refundOf('r1', big, 5), refundOf('r2', small, 2)];
    expect(hasRemaining(original, prior)).toBe(false);
    expect(refundTotal(original, remainingQuantities(original, prior))).toBe(0);
  });

  it('an unmarked legacy refund still reduces the line by product', () => {
    const original = [line('l1', 'p1', 3, 10)];
    expect(asObj(remainingQuantities(original, [line('r1', 'p1', 1, 10)]))).toEqual({ l1: 2 });
  });

  it('a marked refund is not counted a second time under its product', () => {
    const original = [line('l1', 'p1', 3, 10)];
    expect(remainingQuantities(original, [refundOf('r1', original[0], 1)]).get('l1')).toBe(2);
  });

  it('the source marker round-trips', () => {
    expect(encodeSourceItemNote('l1')).toBe('refund-src:l1');
    expect(decodeSourceItemId('refund-src:l1')).toBe('l1');
    expect(decodeSourceItemId(null)).toBeNull();
    expect(decodeSourceItemId('')).toBeNull();
    expect(decodeSourceItemId('refund-src:')).toBeNull();
    expect(decodeSourceItemId('customer asked for a bag')).toBeNull();
  });

  it('refund total is quantity times unit price', () => {
    expect(refundTotal([line('l1', 'p1', 3, 19.99)], { l1: 2 })).toBe(sh(39.98));
  });

  it('a discount is apportioned to the fraction returned', () => {
    // 4 × ₪10 less a ₪4 line discount = ₪36 paid. Returning half credits ₪18, not ₪20.
    expect(refundTotal([line('l1', 'p1', 4, 10, 4)], { l1: 2 })).toBe(sh(18));
  });

  it('refunding a whole discounted line credits exactly what was paid', () => {
    expect(refundTotal([line('l1', 'p1', 4, 10, 4)], { l1: 4 })).toBe(sh(36));
  });

  it('zero and unselected quantities contribute nothing', () => {
    const original = [line('l1', 'p1', 2, 10), line('l2', 'p2', 2, 10)];
    expect(refundTotal(original, {})).toBe(0);
    expect(refundTotal(original, { l1: 0 })).toBe(0);
    expect(refundTotal(original, { l1: 1 })).toBe(sh(10));
  });

  it('a fractional quantity refunds proportionally', () => {
    expect(refundTotal([line('l1', 'p1', 2, 12)], { l1: 0.5 })).toBe(sh(6));
  });

  it('a refund line carries the apportioned discount, not the gross', () => {
    const lines = refundLines([line('l1', 'p1', 4, 10, 4)], { l1: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0].discountShareAgorot).toBe(sh(2));
    expect(lines[0].totalAgorot).toBe(sh(18));
  });

  it('the persisted lines always sum to the amount sent to the terminal', () => {
    const original = [line('l1', 'p1', 3, 19.99, 5), line('l2', 'p2', 2, 7.5), line('l3', 'p3', 1, 3.33, 1.11)];
    const quantities = { l1: 2, l2: 1, l3: 1 };
    const lines = refundLines(original, quantities);
    expect(lines.reduce((s, l) => s + l.totalAgorot, 0)).toBe(refundTotal(original, quantities));
  });

  it('a fractional refund line keeps its fraction', () => {
    const lines = refundLines([line('l1', 'p1', 2, 12)], { l1: 0.5 });
    expect(lines[0].quantity).toBe(0.5);
    expect(lines[0].totalAgorot).toBe(sh(6));
  });

  it('each refund line names the original line it credits, and that is what the next refund reads back', () => {
    const original = [line('l1', 'p1', 2, 10), line('l2', 'p1', 1, 10)];
    const lines = refundLines(original, { l1: 1, l2: 1 });
    expect(lines.map((l) => l.sourceItemId)).toEqual(['l1', 'l2']);
    const credited = lines.map((l, i): RefundItem => ({ id: `r${i}`, productId: l.productId, quantity: l.quantity, unitAgorot: sh(10), refundOfItemId: l.sourceItemId }));
    expect(asObj(remainingQuantities(original, credited))).toEqual({ l1: 1, l2: 0 });
  });

  it('unselected lines produce no refund line at all', () => {
    const original = [line('l1', 'p1', 2, 10), line('l2', 'p2', 2, 10)];
    expect(refundLines(original, {})).toEqual([]);
    expect(refundLines(original, { l2: 1 }).map((l) => l.sourceItemId)).toEqual(['l2']);
  });
});

describe('what the customer paid, basket discount included (MixedBasketTest)', () => {
  it('a basket discount is shared across the lines and adds up to the agora', () => {
    const items: RefundItem[] = [
      { id: 'a', productId: 'p1', quantity: 1, unitAgorot: 1000 },
      { id: 'b', productId: 'p2', quantity: 1, unitAgorot: 2000 },
      { id: 'c', productId: 'p3', quantity: 3, unitAgorot: 333 },
    ];
    // ₪39.99 sold at ₪10 off the basket.
    const collected = collectedPerLine(items, 1000);
    expect([...collected.values()].reduce((s, c) => s + c, 0)).toBe(2999);
    expect(collected.get('b')!).toBeLessThan(2000);
    // The whole document credited back is exactly what it collected.
    expect(refundTotal(items, { a: 1, b: 1, c: 3 }, 1000)).toBe(2999);
  });

  it('a line returned in pieces credits exactly what was paid for it', () => {
    const collected = 1000; // three units for ₪10
    const first = creditFor(collected, 3, 0, 1);
    const second = creditFor(collected, 3, 1, 1);
    const third = creditFor(collected, 3, 2, 1);
    expect(first + second + third).toBe(collected);
    // And never more than is left.
    expect(creditFor(collected, 3, 3, 1)).toBe(0);
  });

  it('a product that takes no discount takes no share of the basket discount', () => {
    const items: RefundItem[] = [
      { id: 'a', productId: 'p1', quantity: 1, unitAgorot: 1000 },
      { id: 'b', productId: 'p2', quantity: 1, unitAgorot: 1000, noDiscount: true },
    ];
    const collected = collectedPerLine(items, 100);
    expect(collected.get('a')).toBe(900);
    expect(collected.get('b')).toBe(1000);
  });

  it("a line's own discounts (the cashier's, the promotions', the vouchers') are not basket", () => {
    const items: RefundItem[] = [
      { id: 'a', productId: 'p1', quantity: 2, unitAgorot: 1000, discountAgorot: 200, promotionAgorot: 100 },
      { id: 'b', productId: 'p2', quantity: 1, unitAgorot: 1000 },
    ];
    // documentDiscount 500 = 300 own + 200 basket, shared by value after the own (1700 : 1000).
    const collected = collectedPerLine(items, 500);
    expect((collected.get('a') ?? 0) + (collected.get('b') ?? 0)).toBe(3000 - 500);
    expect(collected.get('a')).toBe(1700 - 126);
  });

  it('the item column names the source line, the old marker still read', () => {
    expect(sourceItemIdOf({ refundOfItemId: null, notes: encodeSourceItemNote('x') })).toBe('x');
    expect(sourceItemIdOf({ refundOfItemId: 'y', notes: encodeSourceItemNote('x') })).toBe('y');
    const original: RefundItem[] = [{ id: 'orig-l1', productId: 'wine', quantity: 2, unitAgorot: 4200 }];
    const remaining = remainingQuantities(original, [{ id: 'cn', productId: 'wine', quantity: 1, unitAgorot: 4200, refundOfItemId: 'orig-l1' }]);
    expect(remaining.get('orig-l1')).toBe(1);
  });

  it('the credited sum is what the credit note gives back, in shekels (DetailRefundApproverLimitTest)', () => {
    expect(creditedShekels(refundLines([line('l1', 'p1', 4, 10, 4)], { l1: 2 }))).toBe(18);
    expect(creditedShekels([])).toBe(0);
  });
});

describe('money back to a card (TweezerRequests.refund / cardCredit)', () => {
  it("tranType 53, the empty card fields kept; linked only with the original's acquirer id", () => {
    const linked = JSON.parse(refundFrame(4_200, 'v-1', 'acq-1')) as { method: string; params: [string, Record<string, unknown>] };
    expect(linked.method).toBe('doTransaction');
    expect(linked.params[0]).toBe('ashrait');
    expect(Object.keys(linked.params[1])).toEqual(['amount', 'vuid', 'currency', 'creditTerms', 'tranCode', 'tranType', 'originalTransactionId', 'cardNumber', 'expDate', 'cvv']);
    expect(linked.params[1]).toMatchObject({ amount: 4_200, vuid: 'v-1', currency: '376', creditTerms: 1, tranCode: 1, tranType: 53, originalTransactionId: 'acq-1', cardNumber: '' });
    const unlinked = JSON.parse(refundFrame(4_200, 'v-2', null)) as { params: [string, Record<string, unknown>] };
    expect('originalTransactionId' in unlinked.params[1]).toBe(false);
  });

  it("the original's acquirer id: on the meta, or inside its result (an object or its JSON)", () => {
    expect(acquirerTransactionIdOf({ transactionId: 'a1' })).toBe('a1');
    expect(acquirerTransactionIdOf({ result: { transactionId: 77 } })).toBe('77');
    expect(acquirerTransactionIdOf({ result: JSON.stringify({ transactionId: 'a3' }) })).toBe('a3');
    expect(acquirerTransactionIdOf({ result: 'not json', transactionId: ' ' })).toBeNull();
    expect(acquirerTransactionIdOf({ transactionId: 'null' })).toBeNull();
    expect(acquirerTransactionIdOf(null)).toBeNull();
  });
});
