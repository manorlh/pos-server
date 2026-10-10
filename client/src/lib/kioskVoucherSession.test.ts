/**
 * Run with `npm test`. The vouchers of ONE order at a TypeScript kiosk (lib/kioskVoucherSession.ts — what the Windows kiosk's
 * renderer and the browser kiosk's screens both drive): goods vouchers as legs of the payment, discount vouchers held for the order,
 * what is left to pay, what the customer is told, giving them back — the same on both, tested without a screen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { priceKioskBasket, type PricedBasket } from './kioskMoney';
import { KioskVoucherSession, type VoucherSessionDeps, type VoucherWords } from './kioskVoucherSession';
import type { VoucherResult } from './kioskVoucherClient';
import type { AppliedDiscountVoucher, VoucherBenefit } from './kioskVouchers';
import type { VoucherLeg } from './kioskWebOrders';

const BASKET = [
  { id: 'L1', productIds: ['p-burger'], categoryId: null, unitAgorot: 5200, qty: 2 },
  { id: 'L2', productIds: ['p-cola'], categoryId: null, unitAgorot: 1200, qty: 1 },
];
const NOW = { date: '2026-10-08', hour: 13, minute: 0 };

const words: VoucherWords = {
  checking: 'בודקים',
  appliedLeg: (a) => `נקלט ${a}`,
  appliedDiscount: (serial, a) => `שובר ${serial}: הנחה ${a}`,
  offline: 'אין חיבור',
  noMatch: 'אין התאמה',
  reason: (reason, message) => message ?? `סיבה:${reason}`,
  codeOf: (raw) => (raw.trim().length >= 4 ? raw.trim().toUpperCase() : null),
};

const benefit = (value: number): VoucherBenefit => ({ kind: 'order_discount', discountType: 'fixed', value, minPurchase: null, maxDiscount: null, maxUnits: null, productIds: [], categoryIds: [], promotionPolicy: 'exclude', text: null });
const held = (id: string, value: number, serial = 1): AppliedDiscountVoucher => ({
  reservationId: `res-${id}`, clientRequestId: `c-${id}`, voucherId: id, code: id, serial, batchId: `b-${id}`, batchName: `סדרה ${id}`, stacking: 'unlimited', benefit: benefit(value), uses: 1, expiresAt: null,
});
const leg = (id: string, serial: number, productId: string, quantity = 1): VoucherLeg => ({
  redemptionId: `red-${id}`, serial, amountAgorot: 0, eventName: null, redeemed: [{ productId, tillProductId: null, name: null, quantity }],
});

function rig(tipPercent = 0) {
  const log = { calls: [] as Array<Record<string, unknown>>, reversed: [] as string[], released: [] as string[][], covered: 0 };
  const answers: VoucherResult[] = [];
  const deps: VoucherSessionDeps<{ priced: PricedBasket }> = {
    price: (discounts) => ({ priced: priceKioskBasket(BASKET, [], NOW, discounts) }),
    lineInfo: (key) => {
      const l = BASKET.find((x) => x.id === key);
      return l ? { productId: l.productIds[0], baseAgorot: l.unitAgorot, name: key === 'L1' ? 'המבורגר' : 'קולה' } : null;
    },
    tipOf: (goods) => Math.floor((goods * tipPercent + 50) / 100),
    call: async (i) => {
      log.calls.push({ code: i.code, forfeitRest: i.forfeitRest, id: i.clientRequestId, saleRef: i.saleRef, earlier: i.earlier.length, discounts: i.discounts.length });
      return answers.shift() ?? { kind: 'offline' };
    },
    reverse: (id) => void log.reversed.push(id),
    release: (v) => void log.released.push(v.map((x) => x.reservationId)),
    words,
    onCovered: () => void (log.covered += 1),
  };
  return { s: new KioskVoucherSession(deps, 'sale-1'), log, answers, deps };
}

describe('a discount voucher on the order', () => {
  it('is held, priced in at once: the order\'s total, the VAT-free totals and what is left to pay all have it', async () => {
    const { s, answers } = rig();
    answers.push({ kind: 'discount', voucher: held('a', 3000, 12) });
    await s.redeem('ABCD');
    const v = s.view();
    assert.equal(v.goodsAgorot, 11600 - 3000);
    assert.equal(v.dueAgorot, 8600);
    assert.equal(s.state.note, 'שובר 12: הנחה 3000');
    assert.equal(s.state.error, null);
    assert.equal(s.state.busy, false);
    assert.equal(v.rows.length, 1);
    assert.deepEqual({ id: v.rows[0].id, amount: v.rows[0].amountAgorot, title: v.rows[0].title }, { id: 'res-a', amount: 3000, title: 'שובר #12 — סדרה a' });
    // Priced with the discount: the shares are on the lines, the order's id is the session's.
    assert.equal(v.price.priced.voucherAgorot, 3000);
  });

  it('with a tip, the tip is on what is left after the voucher', async () => {
    const { s, answers } = rig(10);
    answers.push({ kind: 'discount', voucher: held('a', 3000) });
    await s.redeem('ABCD');
    const v = s.view();
    assert.equal(v.tipAgorot, 860);
    assert.equal(v.dueAgorot, 8600 + 860);
  });

  it('is removable until the payment starts: off the order, its hold given back', async () => {
    const { s, answers, log } = rig();
    answers.push({ kind: 'discount', voucher: held('a', 3000) });
    await s.redeem('ABCD');
    s.remove('res-a');
    assert.equal(s.state.discounts.length, 0);
    assert.deepEqual(log.released, [['res-a']]);
    assert.equal(s.view().goodsAgorot, 11600);
    // Nothing to remove twice.
    s.remove('res-a');
    assert.equal(log.released.length, 1);
  });

  it('says why a voucher takes nothing now, and what it left out — as rows under it', async () => {
    const { s, answers } = rig();
    answers.push({ kind: 'discount', voucher: { ...held('a', 3000), benefit: { ...benefit(3000), minPurchase: 999999, text: '₪30 הנחה' } } });
    await s.redeem('ABCD');
    const row = s.view().rows[0];
    assert.equal(row.amountAgorot, 0);
    assert.deepEqual(row.lines, ['₪30 הנחה', 'לא חל כרגע: סכום הקנייה (בלי פריטים שהשובר לא חל עליהם) נמוך ממינימום הקנייה של השובר.']);
  });

  it('the second voucher sees what the first took', async () => {
    const { s, answers } = rig();
    answers.push({ kind: 'discount', voucher: held('a', 1000, 1) }, { kind: 'discount', voucher: held('b', 500, 2) });
    await s.redeem('AAAA');
    await s.redeem('BBBB');
    const v = s.view();
    assert.equal(v.goodsAgorot, 11600 - 1500);
    assert.deepEqual(v.outcomes.map((o) => o.amountAgorot), [1000, 500]);
  });
});

describe('a goods voucher on the order', () => {
  it('is a leg of the payment: it pays what it covers, the rest is left to pay', async () => {
    const { s, answers } = rig();
    answers.push({ kind: 'ok', leg: leg('a', 5, 'p-cola') });
    await s.redeem('ABCD');
    const v = s.view();
    assert.deepEqual(v.legs.map((l) => l.amountAgorot), [1200]);
    assert.equal(v.dueAgorot, 10400);
    assert.equal(s.state.note, 'נקלט 1200');
    assert.equal(v.rows[0].amountAgorot, 1200);
  });

  it('is worth what it covers net of a discount voucher added after it: the screen shows what the payment will charge', async () => {
    const { s, answers } = rig();
    answers.push({ kind: 'ok', leg: leg('a', 5, 'p-burger', 2) }, { kind: 'discount', voucher: held('d', 2000) });
    await s.redeem('AAAA');
    assert.equal(s.view().legs[0].amountAgorot, 10400);
    await s.redeem('DDDD');
    const v = s.view();
    // ₪20 over ₪116 of goods: the burgers' 17/29 share of it comes off what the voucher covers.
    const burgers = v.price.priced.lines.find((l) => l.id === 'L1')!;
    assert.equal(v.legs[0].amountAgorot, burgers.totalAgorot);
    assert.equal(v.dueAgorot, v.goodsAgorot - burgers.totalAgorot);
  });

  it('is reversed when taken off', async () => {
    const { s, answers, log } = rig();
    answers.push({ kind: 'ok', leg: leg('a', 5, 'p-cola') });
    await s.redeem('ABCD');
    s.remove('red-a');
    assert.deepEqual(log.reversed, ['red-a']);
    assert.equal(s.view().dueAgorot, 11600);
  });
});

describe('what the vouchers can do together', () => {
  it('when they pay it all and no tip is left, the host goes on by itself — once, on this answer', async () => {
    const { s, answers, log } = rig();
    answers.push({ kind: 'ok', leg: leg('a', 5, 'p-burger', 2) }, { kind: 'ok', leg: leg('b', 6, 'p-cola') });
    await s.redeem('AAAA');
    assert.equal(log.covered, 0);
    await s.redeem('BBBB');
    assert.equal(log.covered, 1);
    assert.equal(s.view().dueAgorot, 0);
  });

  it('with a tip there is always something left: the host does not go on by itself', async () => {
    const { s, answers, log } = rig(10);
    answers.push({ kind: 'ok', leg: leg('a', 5, 'p-burger', 2) }, { kind: 'ok', leg: leg('b', 6, 'p-cola') });
    await s.redeem('AAAA');
    await s.redeem('BBBB');
    assert.equal(log.covered, 0);
    assert.equal(s.view().dueAgorot, 1160);
  });

  it('every voucher goes back when the order is left: holds released, goods reversed, a new order starts clean', async () => {
    const { s, answers, log } = rig();
    answers.push({ kind: 'ok', leg: leg('a', 5, 'p-cola') }, { kind: 'discount', voucher: held('d', 1000) });
    await s.redeem('AAAA');
    await s.redeem('DDDD');
    const before = s.state.saleRef;
    s.giveBack();
    assert.deepEqual(log.reversed, ['red-a']);
    assert.deepEqual(log.released, [['res-d']]);
    assert.equal(s.state.legs.length + s.state.discounts.length, 0);
    assert.notEqual(s.state.saleRef, before);
    // An empty order gives nothing back.
    s.giveBack();
    assert.equal(log.released.length, 1);
  });

  it('a paid order keeps them: reset starts a new order without giving anything back', async () => {
    const { s, answers, log } = rig();
    answers.push({ kind: 'discount', voucher: held('d', 1000) });
    await s.redeem('DDDD');
    s.reset();
    assert.equal(s.state.discounts.length, 0);
    assert.deepEqual(log.released, []);
  });
});

describe('what the customer is told', () => {
  it('a code that cannot be one is not even tried; one at a time', async () => {
    const { s, log } = rig();
    await s.redeem('ab');
    assert.equal(log.calls.length, 0);
  });

  it('a refusal, no answer, no match — each in words; the same code is retried with the same attempt id', async () => {
    const { s, answers, log } = rig();
    answers.push({ kind: 'offline' }, { kind: 'refused', reason: 'prepaid_voucher_used' }, { kind: 'no_match' });
    await s.redeem('ABCD');
    assert.equal(s.state.error, 'אין חיבור');
    await s.redeem('ABCD');
    assert.equal(s.state.error, 'סיבה:prepaid_voucher_used');
    await s.redeem('WXYZ');
    assert.equal(s.state.error, 'אין התאמה');
    // The unanswered attempt kept its id (a lost answer never redeems twice); a refused one is over.
    assert.equal(log.calls[0].id, log.calls[1].id);
    assert.notEqual(log.calls[1].id, log.calls[2].id);
    assert.deepEqual(log.calls.map((c) => c.saleRef), ['sale-1', 'sale-1', 'sale-1']);
  });

  it('the cloud\'s own words win; a one-time voucher taken in part asks first, then redeems the rest forfeited', async () => {
    const { s, answers, log } = rig();
    answers.push({ kind: 'refused', reason: 'prepaid_voucher_expired', message: 'תוקף השובר פג' }, { kind: 'forfeit' }, { kind: 'ok', leg: leg('a', 5, 'p-cola') });
    await s.redeem('ABCD');
    assert.equal(s.state.error, 'תוקף השובר פג');
    await s.redeem('EFGH');
    assert.equal(s.state.forfeit, 'EFGH');
    assert.equal(s.state.error, null);
    await s.redeem('EFGH', true);
    assert.equal(s.state.forfeit, null);
    assert.equal(log.calls[2].forfeitRest, true);
    assert.equal(s.state.legs.length, 1);
  });

  it('declining the forfeit closes the question; a message of the host\'s own can be shown', async () => {
    const { s, answers } = rig();
    answers.push({ kind: 'forfeit' });
    await s.redeem('EFGH');
    s.dismissForfeit();
    assert.equal(s.state.forfeit, null);
    s.setError('שובר הנחה ממומש רק כאן');
    assert.equal(s.state.error, 'שובר הנחה ממומש רק כאן');
    s.clearMessages();
    assert.equal(s.state.error, null);
  });

  it('a call that throws is "no answer"', async () => {
    const { s, deps } = rig();
    s.use({ ...deps, call: async () => { throw new Error('boom'); } });
    await s.redeem('ABCD');
    assert.equal(s.state.error, 'אין חיבור');
    assert.equal(s.state.busy, false);
  });

  it('listeners hear every change', async () => {
    const { s, answers } = rig();
    let n = 0;
    const off = s.subscribe(() => void (n += 1));
    answers.push({ kind: 'discount', voucher: held('a', 1000) });
    await s.redeem('ABCD');
    assert.ok(n >= 3);
    off();
    const before = n;
    s.remove('res-a');
    assert.equal(n, before);
  });
});
