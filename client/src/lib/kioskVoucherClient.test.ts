/**
 * Run with `npm test`. A voucher scanned or typed at a TypeScript kiosk (lib/kioskVoucherClient.ts — the one copy both the Windows
 * kiosk's main process and the browser kiosk's service use, the Android kiosk's KioskPayMethodModel.redeem): looked up telling the
 * cloud what the kiosk can apply, then by what it is — a discount voucher checked by the shared rules and HELD in the cloud for the
 * order (`reserve`), a goods voucher redeemed online as a leg of the payment — with the stacking rules before and after the lookup,
 * and a hold given back or confirmed (`release` / `confirm`), retried.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISCOUNT_PAY_HERE,
  VOUCHER_SHOW_AT_TILL,
  confirmDiscount,
  redeemVoucherCode,
  releaseDiscount,
  settleDiscounts,
  stackingBeforeScan,
  startVouchersOf,
  voucherLineOf,
  type RedeemInput,
  type VoucherPost,
  type VoucherReply,
} from './kioskVoucherClient';
import { applyVoucherDiscounts, type AppliedDiscountVoucher, type VoucherBenefit } from './kioskVouchers';
import type { VoucherLeg, WebOrderLine } from './kioskWebOrders';

interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** A cloud that answers by path (the last matching answer wins), and records every call. */
function cloud(answers: Record<string, VoucherReply<unknown> | ((body: Record<string, unknown>) => VoucherReply<unknown>)> = {}) {
  const calls: Call[] = [];
  const post: VoucherPost = async <T = Record<string, unknown>>(path: string, body: unknown): Promise<VoucherReply<T>> => {
    calls.push({ path, body: body as Record<string, unknown> });
    const a = answers[path];
    if (a === undefined) return { kind: 'offline' };
    return (typeof a === 'function' ? a(body as Record<string, unknown>) : a) as VoucherReply<T>;
  };
  return { calls, post, answers };
}

const ok = (body: Record<string, unknown>): VoucherReply<Record<string, unknown>> => ({ kind: 'ok', body });
const refused = (detail: string, status = 409): VoucherReply<unknown> => ({ kind: 'refused', status, body: { detail }, detail });

const line = (key: string, productId: string, qty: number, unit: number, extra: Partial<WebOrderLine> = {}): WebOrderLine => ({
  key, productId, name: key, qty, baseAgorot: unit, unitAgorot: unit, options: [], note: null, categoryId: null, sku: null, barcode: null, imageUrl: null, allergens: [], ...extra,
});

const burger = line('L1', 'p-burger', 2, 5200);
const cola = line('L2', 'p-cola', 1, 1200);

let seq = 0;
const input = (over: Partial<RedeemInput> = {}): RedeemInput => ({
  code: 'ABCD1234EFGH5678',
  lines: [burger, cola],
  earlier: [],
  discounts: [],
  clientRequestId: 'attempt-1',
  saleRef: 'sale-1',
  operator: { id: 'kiosk:m1', name: 'קיוסק' },
  newId: () => `id-${++seq}`,
  ...over,
});

const discountBenefit = { kind: 'order_discount', discountType: 'fixed', value: 3000, minPurchaseAgorot: null, maxDiscountAgorot: null, maxUnits: null, productIds: [], categoryIds: [], promotionPolicy: 'exclude', text: '₪30 הנחה על כל ההזמנה' };
const discountDto = (over: Record<string, unknown> = {}) => ({
  id: 'vch-1', voucherId: 'vch-1', batchId: 'batch-A', batchName: 'סדרה', eventName: 'פסטיבל הקיץ', serial: 12, kind: 'order_discount', stacking: 'unlimited', redeemable: true, benefit: discountBenefit, usesAvailable: 1, ...over,
});
const goodsDto = (over: Record<string, unknown> = {}) => ({
  id: 'vch-2', voucherId: 'vch-2', batchId: 'batch-B', serial: 5, kind: 'items', stacking: 'unlimited', redeemable: true, splitAllowed: true,
  items: [{ productId: 'p-cola', tillProductId: null, name: 'קולה', quantity: 1, remaining: 1 }], ...over,
});

describe('a discount voucher ("שובר הנחה")', () => {
  it('is looked up telling the cloud this kiosk applies goods and both discount kinds, then held for the order', async () => {
    const c = cloud({
      'prepaid-vouchers/lookup': ok(discountDto()),
      'prepaid-vouchers/reserve': ok({ reservationId: 'res-1', uses: 1, expiresAt: '2026-10-10T12:15:00+00:00' }),
    });
    const r = await redeemVoucherCode(c.post, input());
    assert.equal(r.kind, 'discount');
    if (r.kind !== 'discount') return;
    assert.deepEqual(c.calls[0], { path: 'prepaid-vouchers/lookup', body: { code: 'ABCD1234EFGH5678', supportedKinds: ['items', 'order_discount', 'item_discount'] } });
    const reserve = c.calls[1];
    assert.equal(reserve.path, 'prepaid-vouchers/reserve');
    // The order's id (how the cloud sees its other vouchers), the lines in agorot with what promotions and earlier vouchers took, the uses.
    assert.equal(reserve.body.saleRef, 'sale-1');
    assert.equal(reserve.body.uses, 1);
    assert.equal(reserve.body.posUserId, 'kiosk:m1');
    assert.deepEqual(reserve.body.lines, [
      { id: 'L1', productIds: ['p-burger'], categoryIds: [], quantity: 2, grossAgorot: 10400, lineDiscountAgorot: 0, promotionAgorot: 0, voucherAgorot: 0, discountable: true, weighed: false, general: false },
      { id: 'L2', productIds: ['p-cola'], categoryIds: [], quantity: 1, grossAgorot: 1200, lineDiscountAgorot: 0, promotionAgorot: 0, voucherAgorot: 0, discountable: true, weighed: false, general: false },
    ]);
    assert.deepEqual(reserve.body.otherVouchers, []);
    assert.deepEqual(r.voucher, {
      reservationId: 'res-1', clientRequestId: reserve.body.clientRequestId, voucherId: 'vch-1', code: 'ABCD1234EFGH5678', serial: 12, batchId: 'batch-A', batchName: 'פסטיבל הקיץ',
      stacking: 'unlimited',
      benefit: { kind: 'order_discount', discountType: 'fixed', value: 3000, minPurchase: null, maxDiscount: null, maxUnits: null, productIds: [], categoryIds: [], promotionPolicy: 'exclude', text: '₪30 הנחה על כל ההזמנה' },
      uses: 1, expiresAt: '2026-10-10T12:15:00+00:00',
    });
  });

  it('takes as many uses as still add to the discount, within what the voucher and the sale allow', async () => {
    const c = cloud({
      'prepaid-vouchers/lookup': ok(discountDto({ usesAvailable: 5, maxUsesPerSale: 3, benefit: { ...discountBenefit, value: 2000 } })),
      'prepaid-vouchers/reserve': ok({ reservationId: 'res-1', uses: 3 }),
    });
    const r = await redeemVoucherCode(c.post, input({ lines: [cola, line('L3', 'p-soda', 1, 1000)] }));
    // ₪20 a use over ₪22 of goods: the second use takes the last ₪2, a third adds nothing — two uses wanted, the cloud granted three, the cloud's word stands.
    assert.equal(c.calls[1].body.uses, 2);
    assert.equal(r.kind === 'discount' ? r.voucher.uses : 0, 3);
  });

  it('is refused by the shared rules before the cloud is asked to hold it: nothing it applies to, the minimum not met', async () => {
    const none = cloud({ 'prepaid-vouchers/lookup': ok(discountDto({ kind: 'item_discount', benefit: { ...discountBenefit, kind: 'item_discount', productIds: ['p-nothing'] } })) });
    assert.deepEqual(await redeemVoucherCode(none.post, input()), { kind: 'refused', reason: 'prepaid_voucher_no_eligible_items' });
    assert.equal(none.calls.length, 1);
    const min = cloud({ 'prepaid-vouchers/lookup': ok(discountDto({ benefit: { ...discountBenefit, minPurchaseAgorot: 99999 } })) });
    assert.deepEqual(await redeemVoucherCode(min.post, input()), { kind: 'refused', reason: 'prepaid_voucher_min_purchase' });
    assert.equal(min.calls.length, 1);
  });

  it('"לא מקבל הנחות" takes none of it: a basket of such products has nothing for the voucher', async () => {
    const c = cloud({ 'prepaid-vouchers/lookup': ok(discountDto()) });
    const r = await redeemVoucherCode(c.post, input({ lines: [line('L1', 'p-wine', 1, 10000, { noDiscount: true })] }));
    assert.deepEqual(r, { kind: 'refused', reason: 'prepaid_voucher_no_eligible_items' });
  });

  it("the same voucher again is 'already applied'; one the cloud says is not redeemable carries the cloud's own words", async () => {
    const held = { reservationId: 'res-0', clientRequestId: 'c0', voucherId: 'vch-1', code: 'X', serial: 12, batchId: 'batch-A', batchName: '', stacking: 'unlimited', benefit: discountBenefit as unknown as VoucherBenefit, uses: 1, expiresAt: null } as AppliedDiscountVoucher;
    const again = cloud({ 'prepaid-vouchers/lookup': ok(discountDto()) });
    assert.deepEqual(await redeemVoucherCode(again.post, input({ discounts: [held] })), { kind: 'refused', reason: 'prepaid_voucher_already_applied' });
    const gone = cloud({ 'prepaid-vouchers/lookup': ok(discountDto({ redeemable: false, reason: 'prepaid_voucher_expired', message: 'תוקף השובר פג ב-01.10' })) });
    assert.deepEqual(await redeemVoucherCode(gone.post, input()), { kind: 'refused', reason: 'prepaid_voucher_expired', message: 'תוקף השובר פג ב-01.10' });
  });

  it('is refused by the cloud with its reason, or not at all when there is no answer', async () => {
    const busy = cloud({ 'prepaid-vouchers/lookup': ok(discountDto()), 'prepaid-vouchers/reserve': refused('prepaid_voucher_in_use') });
    assert.deepEqual(await redeemVoucherCode(busy.post, input()), { kind: 'refused', reason: 'prepaid_voucher_in_use' });
    const off = cloud({ 'prepaid-vouchers/lookup': ok(discountDto()) });
    assert.deepEqual(await redeemVoucherCode(off.post, input()), { kind: 'offline' });
    const none = cloud();
    assert.deepEqual(await redeemVoucherCode(none.post, input()), { kind: 'offline' });
    const missing = cloud({ 'prepaid-vouchers/lookup': { kind: 'refused', status: 404, body: {}, detail: null } });
    assert.deepEqual(await redeemVoucherCode(missing.post, input()), { kind: 'refused', reason: 'prepaid_voucher_not_found' });
  });

  it('sends the vouchers already in the sale — discount ones and goods legs — and sees what they took off the lines', async () => {
    const first = applyVoucherDiscounts([voucherLineOf(burger), voucherLineOf(cola)], []);
    void first;
    const held: AppliedDiscountVoucher = {
      reservationId: 'res-0', clientRequestId: 'c0', voucherId: 'vch-0', code: 'X', serial: 3, batchId: 'batch-Z', batchName: '', stacking: 'unlimited',
      benefit: { kind: 'order_discount', discountType: 'fixed', value: 1000, minPurchase: null, maxDiscount: null, maxUnits: null, productIds: [], categoryIds: [], promotionPolicy: 'exclude', text: null }, uses: 1, expiresAt: null,
    };
    const leg: VoucherLeg = { redemptionId: 'r1', serial: 4, amountAgorot: 1200, eventName: null, redeemed: [{ productId: 'p-cola', tillProductId: null, name: null, quantity: 1 }], inSale: { voucherId: 'vch-leg', batchId: 'batch-L', kind: 'items', stacking: 'unlimited' } };
    const c = cloud({ 'prepaid-vouchers/lookup': ok(discountDto()), 'prepaid-vouchers/reserve': ok({ reservationId: 'res-1' }) });
    await redeemVoucherCode(c.post, input({ discounts: [held], earlier: [leg] }));
    const body = c.calls[1].body;
    assert.deepEqual(
      (body.otherVouchers as Array<Record<string, unknown>>).map((v) => v.voucherId),
      ['vch-0', 'vch-leg'],
    );
    // The ₪10 the first voucher took is on the lines the new one is checked against.
    assert.equal((body.lines as Array<Record<string, unknown>>).reduce((s, l) => s + (l.voucherAgorot as number), 0), 1000);
  });
});

describe('how many vouchers an order may hold', () => {
  const single = { voucherId: 'v1', batchId: 'A', kind: 'items' as const, stacking: 'single' as const };
  const free = { voucherId: 'v2', batchId: 'B', kind: 'order_discount' as const, stacking: 'unlimited' as const, maxPerSale: 2 };

  it('is checked before the voucher is even looked up: a "one voucher" voucher on the order, or the most one of them allows', async () => {
    assert.deepEqual(stackingBeforeScan([]), null);
    assert.deepEqual(stackingBeforeScan([single]), { code: 'prepaid_voucher_other_not_stackable', limit: null });
    assert.deepEqual(stackingBeforeScan([free, { ...free, voucherId: 'v3' }]), { code: 'prepaid_voucher_max_per_sale', limit: 2 });
    assert.equal(stackingBeforeScan([free]), null);
    const c = cloud({ 'prepaid-vouchers/lookup': ok(discountDto()) });
    const goodsLeg: VoucherLeg = { redemptionId: 'r1', serial: 4, amountAgorot: 1200, eventName: null, redeemed: [], inSale: single };
    assert.deepEqual(await redeemVoucherCode(c.post, input({ earlier: [goodsLeg] })), { kind: 'refused', reason: 'prepaid_voucher_other_not_stackable', message: 'ניתן לממש שובר אחד בלבד בעסקה' });
    assert.equal(c.calls.length, 0);
  });

  it("is checked again with the new voucher's own terms: a \"one voucher\" voucher joins no order that holds another", async () => {
    const c = cloud({ 'prepaid-vouchers/lookup': ok(discountDto({ stacking: 'single' })) });
    const goodsLeg: VoucherLeg = { redemptionId: 'r1', serial: 4, amountAgorot: 1200, eventName: null, redeemed: [], inSale: { ...free, maxPerSale: null } };
    const r = await redeemVoucherCode(c.post, input({ earlier: [goodsLeg] }));
    assert.deepEqual(r, { kind: 'refused', reason: 'prepaid_voucher_not_stackable', message: 'ניתן לממש שובר אחד בלבד בעסקה' });
    assert.equal(c.calls.length, 1, 'only the lookup');
  });
});

describe('a goods voucher ("שובר פריטים")', () => {
  it('is redeemed online for what the basket holds and is a leg of the payment: the order\'s id with it, never the tip', async () => {
    const c = cloud({
      'prepaid-vouchers/lookup': ok(goodsDto()),
      'prepaid-vouchers/redeem': ok({ redemptionId: 'red-1', redeemed: [{ productId: 'p-cola', tillProductId: null, name: 'קולה', quantity: 1 }], voucher: { serial: 5, eventName: 'ארוחה', includeExtras: false, stacking: 'unlimited' } }),
    });
    const r = await redeemVoucherCode(c.post, input());
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(c.calls[1].body.saleRef, 'sale-1');
    assert.equal(c.calls[1].body.clientRequestId, 'attempt-1');
    assert.deepEqual(c.calls[1].body.items, [{ productId: 'p-cola', quantity: 1 }]);
    assert.equal(r.leg.amountAgorot, 1200);
    assert.equal(r.leg.redemptionId, 'red-1');
    assert.equal(r.leg.serial, 5);
    assert.deepEqual(r.leg.inSale, { voucherId: 'vch-2', batchId: 'batch-B', kind: 'items', stacking: 'unlimited', maxPerSale: null });
  });

  it('covers a dish whole when the batch says "כולל תוספות", else its own price', async () => {
    const dish = line('L1', 'p-burger', 1, 5800, { baseAgorot: 5200 });
    const answers = (include: boolean) =>
      cloud({
        'prepaid-vouchers/lookup': ok(goodsDto({ items: [{ productId: 'p-burger', tillProductId: null, name: 'המבורגר', quantity: 1, remaining: 1 }] })),
        'prepaid-vouchers/redeem': ok({ redemptionId: 'red-1', redeemed: [{ productId: 'p-burger', tillProductId: null, name: null, quantity: 1 }], voucher: { serial: 5, includeExtras: include } }),
      });
    const own = await redeemVoucherCode(answers(false).post, input({ lines: [dish] }));
    const all = await redeemVoucherCode(answers(true).post, input({ lines: [dish] }));
    assert.equal(own.kind === 'ok' ? own.leg.amountAgorot : -1, 5200);
    assert.equal(all.kind === 'ok' ? all.leg.amountAgorot : -1, 5800);
  });

  it('finds nothing in the basket, asks before giving up the rest of a one-time voucher, and never keeps one that pays nothing', async () => {
    const nothing = cloud({ 'prepaid-vouchers/lookup': ok(goodsDto({ items: [{ productId: 'p-other', tillProductId: null, name: 'x', quantity: 1, remaining: 1 }] })) });
    assert.deepEqual(await redeemVoucherCode(nothing.post, input()), { kind: 'no_match' });
    const part = cloud({ 'prepaid-vouchers/lookup': ok(goodsDto({ splitAllowed: false, items: [{ productId: 'p-cola', tillProductId: null, name: 'קולה', quantity: 2, remaining: 2 }] })) });
    assert.deepEqual(await redeemVoucherCode(part.post, input()), { kind: 'forfeit' });
    const reversed: string[] = [];
    const empty = cloud({ 'prepaid-vouchers/lookup': ok(goodsDto()), 'prepaid-vouchers/redeem': ok({ redemptionId: 'red-9', redeemed: [{ productId: 'p-elsewhere', tillProductId: null, name: null, quantity: 1 }], voucher: { serial: 5 } }) });
    assert.deepEqual(await redeemVoucherCode(empty.post, input({ reverse: async (id) => void reversed.push(id) })), { kind: 'no_match' });
    assert.deepEqual(reversed, ['red-9']);
  });

  it('a staff test voucher is a till user\'s permission, never a kiosk\'s', async () => {
    const c = cloud({ 'prepaid-vouchers/lookup': ok(goodsDto({ isTest: true })) });
    assert.deepEqual(await redeemVoucherCode(c.post, input()), { kind: 'refused', reason: VOUCHER_SHOW_AT_TILL });
    assert.equal(c.calls.length, 1);
  });

  it('a voucher that needs a till that books it is the till\'s: the cloud\'s words for the cashier are not the customer\'s', async () => {
    const c = cloud({ 'prepaid-vouchers/lookup': ok(goodsDto({ redeemable: false, reason: 'prepaid_voucher_update_required', message: 'יש לעדכן את גרסת הקופה' })) });
    assert.deepEqual(await redeemVoucherCode(c.post, input()), { kind: 'refused', reason: 'prepaid_voucher_update_required' });
  });
});

describe('giving a hold back, confirming it with the sale', () => {
  const noSleep = async () => undefined;

  it('release goes to the reservation; retried while there is no answer, never when the cloud answered', async () => {
    let tries = 0;
    const flaky = cloud({ 'prepaid-vouchers/reservations/res-1/release': () => (++tries < 3 ? { kind: 'offline' } : ok({})) });
    assert.equal(await releaseDiscount(flaky.post, { reservationId: 'res-1' }, noSleep), true);
    assert.equal(tries, 3);
    const gone = cloud({ 'prepaid-vouchers/reservations/res-1/release': refused('prepaid_voucher_reservation_not_found', 404) });
    assert.equal(await releaseDiscount(gone.post, { reservationId: 'res-1' }, noSleep), false);
    assert.equal(gone.calls.length, 1);
    const down = cloud();
    assert.equal(await releaseDiscount(down.post, { reservationId: 'res-1' }, noSleep), false);
    assert.equal(down.calls.length, 3);
  });

  it('confirm names the document, what the voucher took and its uses; settle confirms what took something and releases what took nothing', async () => {
    const c = cloud({ 'prepaid-vouchers/reservations/res-1/confirm': ok({}), 'prepaid-vouchers/reservations/res-2/release': ok({}) });
    assert.equal(await confirmDiscount(c.post, { reservationId: 'res-1', uses: 2 }, { transactionId: 'tx-1', amountAgorot: 3000 }, noSleep), true);
    assert.deepEqual(c.calls[0].body, { transactionId: 'tx-1', amountAgorot: 3000, uses: 2 });
    const benefit = discountBenefit as unknown as VoucherBenefit;
    const v = (id: string): AppliedDiscountVoucher => ({ reservationId: id, clientRequestId: 'c', voucherId: id, code: 'X', serial: 1, batchId: 'b', batchName: '', stacking: 'unlimited', benefit, uses: 1, expiresAt: null });
    c.calls.length = 0;
    await settleDiscounts(c.post, [
      { voucher: v('res-1'), amountAgorot: 3000, shares: {}, skipped: [], refusal: null },
      { voucher: v('res-2'), amountAgorot: 0, shares: {}, skipped: [], refusal: 'prepaid_voucher_min_purchase' },
    ], 'tx-2', noSleep);
    assert.deepEqual(c.calls.map((x) => x.path), ['prepaid-vouchers/reservations/res-1/confirm', 'prepaid-vouchers/reservations/res-2/release']);
  });
});

describe('the vouchers of a payment, read field by field', () => {
  const good = {
    saleRef: 'sale-1',
    legs: [{ redemptionId: 'r1', serial: 5, amountAgorot: 1200, eventName: 'ארוחה', redeemed: [{ productId: 'p-cola', tillProductId: null, name: 'קולה', quantity: 1 }], includeExtras: true, inSale: { voucherId: 'v', batchId: 'b', kind: 'items', stacking: 'single' } }],
    discounts: [{ reservationId: 'res-1', clientRequestId: 'c1', voucherId: 'vch-1', code: 'X', serial: 12, batchId: 'b', batchName: 'פסטיבל', stacking: 'unlimited', benefit: discountBenefit, uses: 1, expiresAt: null }],
  };

  it('reads a well-formed order', () => {
    const v = startVouchersOf(good);
    assert.ok(v);
    assert.equal(v.legs[0].includeExtras, true);
    assert.equal(v.legs[0].inSale?.stacking, 'single');
    assert.equal(v.discounts[0].benefit.value, 3000);
    assert.equal(v.saleRef, 'sale-1');
  });

  it("a discount voucher's minimum, cap and units survive the trip from the page to the kiosk (JSON, the bridge)", () => {
    const benefit: VoucherBenefit = { kind: 'order_discount', discountType: 'percent', value: 1500, minPurchase: 6000, maxDiscount: 700, maxUnits: 2, productIds: ['p-1'], categoryIds: ['c-1'], promotionPolicy: 'best', text: '15% הנחה' };
    const applied: AppliedDiscountVoucher = { reservationId: 'res-1', clientRequestId: 'c1', voucherId: 'vch-1', code: 'X', serial: 12, batchId: 'b', batchName: 'פסטיבל', stacking: 'distinct_batches', benefit, uses: 2, expiresAt: '2026-10-10T12:15:00+00:00' };
    const v = startVouchersOf(JSON.parse(JSON.stringify({ saleRef: 's', legs: [], discounts: [applied] })));
    assert.ok(v);
    assert.deepEqual(v.discounts[0], applied);
  });

  it('anything unreadable is no payment', () => {
    assert.equal(startVouchersOf(null), null);
    assert.equal(startVouchersOf({ ...good, saleRef: '' }), null);
    assert.equal(startVouchersOf({ ...good, legs: [{ ...good.legs[0], amountAgorot: -1 }] }), null);
    assert.equal(startVouchersOf({ ...good, legs: [{ ...good.legs[0], redemptionId: 7 }] }), null);
    assert.equal(startVouchersOf({ ...good, legs: [{ ...good.legs[0], redeemed: [{ productId: 'p', quantity: 0 }] }] }), null);
    assert.equal(startVouchersOf({ ...good, discounts: [{ ...good.discounts[0], benefit: { kind: 'items' } }] }), null);
    assert.equal(startVouchersOf({ ...good, discounts: [{ ...good.discounts[0], uses: 0 }] }), null);
    assert.equal(startVouchersOf({ ...good, discounts: Array.from({ length: 21 }, () => good.discounts[0]) }), null);
  });

  it('an order with a discount voucher is not handed to a till: the Android kiosk\'s words', () => {
    assert.equal(DISCOUNT_PAY_HERE, 'שובר הנחה ממומש רק בתשלום כאן בעמדה. לתשלום בקופה — הסירו אותו והציגו אותו בקופה.');
  });
});
