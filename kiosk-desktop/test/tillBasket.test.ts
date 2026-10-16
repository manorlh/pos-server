/**
 * A mixed basket (core/till/basket.ts) — the Android till's MixedBasketTest tender legs, payout placement, card payout route
 * and credit notes, case for case.
 */

import { describe, expect, it } from 'vitest';
import {
  BasketMismatch,
  basketCreditsOf,
  basketNextStep,
  cardPayoutRoute,
  creditTotal,
  onUnlessFalse,
  planBasketTenders,
  returnCustomerComplete,
  returnCustomerRequired,
  type LinkCandidate,
} from '../src/core/till/basket';

const legs = (t: Array<{ method: string; amountAgorot: number }>) => t.map((x) => [x.method, x.amountAgorot]);

describe('the tender legs (planBasketTenders)', () => {
  it('net positive - real legs for the net, exchange for what came back', () => {
    const plan = planBasketTenders({
      saleTotalAgorot: 10_000,
      creditTotals: [4_200],
      realLegs: [
        { method: 'cash', amountAgorot: 2_000 },
        { method: 'card', amountAgorot: 3_800 },
      ],
    });
    expect(legs(plan.sale)).toEqual([
      ['cash', 2_000],
      ['card', 3_800],
      ['exchange', 4_200],
    ]);
    expect(plan.credits.map(legs)).toEqual([[['exchange', 4_200]]]);
  });

  it('net zero - exchange only, and no money may move', () => {
    const plan = planBasketTenders({ saleTotalAgorot: 4_200, creditTotals: [4_200] });
    expect(plan.sale.map((t) => t.method)).toEqual(['exchange']);
    expect(plan.credits[0][0].method).toBe('exchange');
    expect(() => planBasketTenders({ saleTotalAgorot: 4_200, creditTotals: [4_200], realLegs: [{ method: 'cash', amountAgorot: 1 }] })).toThrow(BasketMismatch);
  });

  it('net negative - the 320 in exchange, one payout leg on the credit notes', () => {
    const plan = planBasketTenders({ saleTotalAgorot: 3_800, creditTotals: [8_400], payout: { method: 'cash' } });
    expect(legs(plan.sale)).toEqual([['exchange', 3_800]]);
    expect(legs(plan.credits[0])).toEqual([
      ['exchange', 3_800],
      ['cash', 4_600],
    ]);
  });

  it("a linked card payout sits whole on its own original's credit note", () => {
    const plan = planBasketTenders({ saleTotalAgorot: 1_000, creditTotals: [2_000, 3_000], creditOriginals: [null, 'card-orig'], payout: { method: 'card', onCreditOf: 'card-orig' } });
    // Payout 40: the card original's note credits 30 — it takes 30, the catalog note the other 10.
    expect(plan.credits.flat().filter((t) => t.method === 'card').reduce((s, t) => s + t.amountAgorot, 0)).toBe(4_000);
    expect(plan.credits[1].find((t) => t.method === 'card')!.amountAgorot).toBe(3_000);
    const fits = planBasketTenders({ saleTotalAgorot: 2_500, creditTotals: [2_000, 3_000], creditOriginals: [null, 'card-orig'], payout: { method: 'card', onCreditOf: 'card-orig' } });
    expect(fits.credits[0].map((t) => t.method)).toEqual(['exchange']);
    expect(legs(fits.credits[1])).toEqual([
      ['exchange', 500],
      ['card', 2_500],
    ]);
  });

  it('legs that do not add up to the net are refused, never written', () => {
    expect(() => planBasketTenders({ saleTotalAgorot: 10_000, creditTotals: [4_200], realLegs: [{ method: 'cash', amountAgorot: 5_000 }] })).toThrow(BasketMismatch);
    expect(() => planBasketTenders({ saleTotalAgorot: 3_800, creditTotals: [8_400] })).toThrow(BasketMismatch);
    expect(() => planBasketTenders({ saleTotalAgorot: 3_800, creditTotals: [8_400], realLegs: [{ method: 'cash', amountAgorot: 4_600 }] })).toThrow(BasketMismatch);
    expect(() => planBasketTenders({ saleTotalAgorot: 10_000, creditTotals: [4_200], payout: { method: 'cash' } })).toThrow(BasketMismatch);
  });

  it('every document of a basket is paid exactly what it collects or credits; the exchange nets to zero', () => {
    const plan = planBasketTenders({ saleTotalAgorot: 9_600, creditTotals: [8_400, 2_000], creditOriginals: ['orig', null], payout: { method: 'cash' } });
    expect(plan.sale.reduce((s, t) => s + t.amountAgorot, 0)).toBe(9_600);
    expect(plan.credits.map((c) => c.reduce((s, t) => s + t.amountAgorot, 0))).toEqual([8_400, 2_000]);
    const exchangeIn = plan.sale.filter((t) => t.method === 'exchange').reduce((s, t) => s + t.amountAgorot, 0);
    const exchangeOut = plan.credits.flat().filter((t) => t.method === 'exchange').reduce((s, t) => s + t.amountAgorot, 0);
    expect(exchangeIn).toBe(exchangeOut);
  });
});

describe('the card payout route (cardPayoutRoute)', () => {
  it('a card payout is linked only when one card original can take all of it', () => {
    const candidate: LinkCandidate = { originalId: 'orig', creditedAgorot: 8_400, cardAgorot: 8_400, acquirerTransactionId: 'acq-1' };
    expect(cardPayoutRoute(4_600, [candidate], true)).toEqual({ kind: 'linked', originalId: 'orig', acquirerTransactionId: 'acq-1' });
    // More than the basket credits against it: the rest is not that card's money.
    expect(cardPayoutRoute(9_000, [candidate], true)).toEqual({ kind: 'unlinked' });
    // No acquirer reference, nothing to link to.
    expect(cardPayoutRoute(100, [{ ...candidate, acquirerTransactionId: null }], true)).toEqual({ kind: 'unlinked' });
    // Catalog returns only, with unlinked credits switched off: no card payout at all.
    expect(cardPayoutRoute(4_200, [], false)).toEqual({ kind: 'unavailable' });
    expect(cardPayoutRoute(4_600, [candidate], false)).toEqual({ kind: 'linked', originalId: 'orig', acquirerTransactionId: 'acq-1' });
  });

  it('`unlinkedCardCreditEnabled` and `refundCustomerDetailsRequired` are on unless the cloud says "false"', () => {
    expect(onUnlessFalse(undefined)).toBe(true);
    expect(onUnlessFalse('')).toBe(true);
    expect(onUnlessFalse('true')).toBe(true);
    expect(onUnlessFalse(' FALSE ')).toBe(false);
    expect(onUnlessFalse(false)).toBe(false);
  });
});

describe('the credit notes (basketCreditsOf) and the return customer', () => {
  it('one per original, in the order picked, then one for the returns with no receipt', () => {
    const credits = basketCreditsOf([
      { productId: 'wine', name: 'יין', sku: null, qty: 2, unitAgorot: 4_200, totalAgorot: 7_560, refundOf: { transactionId: 'orig', itemId: 'orig-l1' } },
      { productId: 'cake', name: 'עוגה', sku: null, qty: 1, unitAgorot: 2_000, totalAgorot: 2_000, refundOf: null },
      { productId: 'beer', name: 'בירה', sku: null, qty: 1, unitAgorot: 3_800, totalAgorot: 3_800, refundOf: { transactionId: 'orig', itemId: 'orig-l2' } },
    ]);
    expect(credits.map((c) => c.originalId)).toEqual(['orig', null]);
    expect(credits[0].lines.map((l) => l.sourceItemId)).toEqual(['orig-l1', 'orig-l2']);
    // A receipt line credited for less than its gross: the difference is its discount share.
    expect(credits[0].lines[0]).toMatchObject({ discountShareAgorot: 840, discountType: 'fixed', totalAgorot: 7_560 });
    expect(credits[1].lines[0]).toMatchObject({ sourceItemId: null, discountShareAgorot: 0, totalAgorot: 2_000 });
    expect(credits.map(creditTotal)).toEqual([11_360, 2_000]);
  });

  it('a return with no receipt needs a name and a phone or an address, unless the merchant relaxed it', () => {
    expect(returnCustomerRequired(true, true)).toBe(true);
    expect(returnCustomerRequired(true, false)).toBe(false);
    expect(returnCustomerRequired(false, true)).toBe(false);
    expect(returnCustomerComplete('Avi Cohen', '050-1234567', '')).toBe(true);
    expect(returnCustomerComplete('Avi Cohen', '', 'הרצל 1')).toBe(true);
    expect(returnCustomerComplete('Avi Cohen', ' ', ' ')).toBe(false);
    expect(returnCustomerComplete('', '050', '')).toBe(false);
  });

  it('where a basket goes next: tenders, one confirmation, or the payout', () => {
    expect(basketNextStep(100)).toBe('tender');
    expect(basketNextStep(0)).toBe('exchange');
    expect(basketNextStep(-100)).toBe('payout');
  });
});
