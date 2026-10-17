/**
 * "הזמנות קיוסק לתשלום" on the Windows till (core/till/kioskOrders.ts, main/till/tillKioskOrders.ts, the engine's
 * `loadKioskOrder`; pos-android data/repo/KioskPayAtTill.kt): the cloud's list as the till shows it, the kiosk's basket
 * rebuilt line for line (choices, a meal, notes), the lock, the payment with the kiosk's vouchers and tip, "paid" reported and
 * kept until the cloud has it, backing out (release), "ביטול הזמנה", the slip scanned, and the list's markup.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KPAY_TEXT, decodeBasket, lockRefusal, orderOf, ordersOf, rowOf, slipCode, waitingCount } from '../src/core/till/kioskOrders';
import { KioskOrdersSheet, KioskOrdersStrip } from '../src/renderer/roles/till/screens/KioskOrdersScreen';
import { readyTill, type Harness } from './tillEngineHarness';

const money = (a: number) => `₪${(a / 100).toFixed(2)}`;

/** The kiosk's basket as both kiosks write it (client lib/kioskWebOrders.ts heldSaleCodec, Android HeldSaleCodec). */
function codec(lines: Array<{ productId: string; name: string; qty: number; base: number; unit: number; details?: Record<string, unknown> | null }>): string {
  return JSON.stringify({
    cartId: 'k-1',
    lines: lines.map((l, i) => ({
      id: `kl${i}`,
      quantity: l.qty,
      unitPrice: l.unit,
      discount: 0,
      discountType: null,
      notes: null,
      product: JSON.stringify({ id: l.productId, cloudId: l.productId, name: l.name, sku: 'x', categoryId: 'c-main', price: l.base }),
      details: l.details ?? null,
    })),
  });
}

const BASKET = codec([
  { productId: 'p-pizza', name: 'פיצה', qty: 1, base: 4000, unit: 4500, details: { v: 1, basePrice: 40, modifiers: [{ groupId: 'g-size', optionId: 'o-l', qty: 1, pre: null }], noteText: 'בלי מלח', important: true, allergies: ['milk'] } },
  { productId: 'p-cola', name: 'קולה', qty: 2, base: 1200, unit: 1200 },
]);

const NOW = Date.parse('2026-10-17T12:00:00Z');

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'ko-1',
    localId: 'L17',
    kioskName: 'קיוסק רויאל',
    state: 'open',
    pickupLabel: 'A-17',
    customerName: 'דנה',
    serviceType: 'take_away',
    itemCount: 3,
    totalAgorot: 6900,
    tipAgorot: 0,
    voucherAgorot: 0,
    dueAgorot: 6900,
    lines: [
      { name: 'פיצה', quantity: 1, totalAgorot: 4500, notes: 'גדול · בלי מלח' },
      { name: 'קולה', quantity: 2, totalAgorot: 2400 },
    ],
    cart: { codec: BASKET, fulfillment: 'BON' },
    vouchers: [],
    kitchenSent: false,
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    lockedBy: null,
    lockedByMe: false,
    ...over,
  };
}

const MENU = {
  groups: [{ id: 'g-size', name: 'גודל', kind: 'choice', minSelect: 1, maxSelect: 1, options: [{ id: 'o-s', name: 'רגיל', price: 0 }, { id: 'o-l', name: 'גדול', price: 5 }] }],
  links: { products: { 'p-pizza': ['g-size'] } },
  notes: {},
  meals: {},
};
const CATALOG = {
  products: [
    { id: 'p-pizza', name: 'פיצה', price: 40, categoryId: 'c-main', inStock: true, isAvailable: true, salesChannel: 'all' },
    { id: 'p-cola', name: 'קולה', price: 12, categoryId: 'c-main', inStock: true, isAvailable: true, salesChannel: 'all' },
  ],
  categories: [{ id: 'c-main', name: 'מנות', isActive: true }],
  menu: MENU,
};

describe('the list (KioskOpenOrderView, OrderCard)', () => {
  it('parses the cloud\'s orders, oldest first; counts the waiting ones', () => {
    const list = ordersOf({ orders: [order({ id: 'b', createdAt: new Date(NOW - 60_000).toISOString() }), order({ id: 'a' }), order({ id: 'c', state: 'paid' })] });
    expect(list.map((o) => o.id)).toEqual(['a', 'c', 'b']);
    expect(waitingCount(list)).toBe(2);
  });

  it('a row: the number, name · kiosk, service · items · age, the vouchers, another till\'s hold', () => {
    const o = orderOf(order({ voucherAgorot: 2500, dueAgorot: 4400 }))!;
    const r = rowOf(o, NOW, money);
    expect([r.label, r.title, r.sub, r.voucherNote, r.lockedBy, r.actionable]).toEqual(['A-17', 'דנה · קיוסק רויאל', 'לקחת · 3 פריטים · לפני 5 דק׳', 'שובר: ₪25.00', null, true]);
    expect(r.linesText).toBe('1× פיצה · 2× קולה');
    const held = rowOf(orderOf(order({ lockedBy: 'קופה 3 · אבי' }))!, NOW, money);
    expect([held.lockedBy, held.actionable]).toEqual(['בטיפול בקופה 3 · אבי', false]);
    expect(rowOf(orderOf(order({ createdAt: new Date(NOW).toISOString(), serviceType: null }))!, NOW, money).sub).toBe('3 פריטים · עכשיו');
  });

  it('the slip\'s code, and the refusals in Android\'s words', () => {
    expect(slipCode('KO:L17')).toBe('L17');
    expect(slipCode('ko:L17\r')).toBe('L17');
    expect(slipCode('7290000000011')).toBeNull();
    expect(lockRefusal(409, { detail: 'kiosk_order_locked', lockedBy: 'קופה 3' })).toBe('בטיפול בקופה 3');
    expect(lockRefusal(409, { detail: 'kiosk_order_closed', state: 'paid', paidBy: 'דנה' })).toBe('ההזמנה כבר שולמה (דנה)');
    expect(lockRefusal(409, { detail: 'kiosk_order_closed', state: 'expired' })).toBe(KPAY_TEXT.expired);
    expect(lockRefusal(403, { detail: 'area_locked', message: 'שייך לנקודת מכירה אחרת' })).toBe('שייך לנקודת מכירה אחרת');
    expect(lockRefusal(404, {})).toBe(KPAY_TEXT.notFound);
  });

  it('the kiosk\'s basket decoded line for line: the choices, the note, "חשוב", the allergy; a meal\'s components', () => {
    const lines = decodeBasket(BASKET)!;
    expect(lines.map((l) => [l.productId, l.qty, l.baseAgorot])).toEqual([
      ['p-pizza', 1, 4000],
      ['p-cola', 2, 1200],
    ]);
    expect(lines[0].choices).toEqual({ options: [{ groupId: 'g-size', optionId: 'o-l', qty: 1, pre: null }], notes: ['בלי מלח'], meal: null, important: true, allergies: ['חלב'] });
    expect(lines[1].choices).toBeNull();
    const meal = decodeBasket(
      codec([{ productId: 'p-meal', name: 'ארוחה', qty: 1, base: 5500, unit: 5700, details: { v: 1, basePrice: 55, modifiers: [], meal: { productId: 'p-meal', components: [{ slotId: 's1', productId: 'p-burger', modifiers: [{ groupId: 'g', optionId: 'o' }] }, { slotId: 's2', productId: 'p-cola', qty: 2, modifiers: [] }] } } }]),
    )!;
    expect(meal[0].choices?.meal?.components).toEqual([
      { slotId: 's1', productId: 'p-burger', options: [{ groupId: 'g', optionId: 'o', qty: 1, pre: null }] },
      { slotId: 's2', productId: 'p-cola' },
      { slotId: 's2', productId: 'p-cola' },
    ]);
    expect(decodeBasket(null)).toBeNull();
    expect(decodeBasket('{bad')).toBeNull();
  });
});

/** A till whose cloud lists [orders] and answers the lock, the release, the paid report and the cancel. */
async function till(orders: Array<Record<string, unknown>>, answers: Record<string, (body: Record<string, unknown> | null) => unknown> = {}): Promise<Harness> {
  const h = await readyTill({
    catalog: CATALOG,
    now: () => NOW,
    answers: {
      'GET sync/m/kiosk/open-orders': () => ({ orders }),
      'POST sync/m/kiosk/open-orders/ko-1/lock': () => ({ ...orders[0], lockedBy: 'קופה 2', lockedByMe: true }),
      'POST sync/m/kiosk/open-orders/ko-1/release': () => ({ ok: true }),
      'POST sync/m/kiosk/open-orders/ko-1/paid': () => ({ ok: true }),
      'POST sync/m/kiosk/open-orders/ko-1/cancel': () => ({ ok: true }),
      ...answers,
    },
  });
  await h.ok('kioskOrders.refresh');
  return h;
}

const posted = (h: Harness, path: string) => h.sent.filter((s) => s.method === 'POST' && s.path === path);

describe('paying a kiosk order at the till', () => {
  it('lists them; "לתשלום" locks it, rebuilds its basket and opens the payment; cash writes the document and reports it paid', async () => {
    const h = await till([order()]);
    expect(h.state().kioskOrders?.waiting).toBe(1);
    await h.ok('kioskOrders.pay', { id: 'ko-1' });
    expect(posted(h, 'sync/m/kiosk/open-orders/ko-1/lock')[0].body).toMatchObject({ posUserName: 'דנה כהן' });
    const s = h.state();
    expect(s.checkout.phase).toBe('tender');
    expect(s.checkout.totalAgorot).toBe(4500 + 2400);
    expect(s.sell.lines.map((l) => [l.name, l.qty, l.totalAgorot])).toEqual([
      ['פיצה', 1, 4500],
      ['קולה', 2, 2400],
    ]);
    expect(s.sell.lines[0].subLines).toEqual(['גדול', '! בלי מלח', 'אלרגיה: חלב']);
    expect(s.order?.name).toBe('A-17 · דנה');
    // The basket is the kiosk's: never edited at the till.
    expect((await h.fail('sell.add', { productId: 'p-cola' })).code).toBe('checkout_busy');
    await h.ok('checkout.cash', { amountAgorot: 10_000 });
    const done = h.state().checkout;
    expect([done.phase, done.changeAgorot]).toEqual(['done', 3100]);
    await h.engine.call({ id: 999, op: 'kioskOrders.refresh', args: {} });
    const paid = posted(h, 'sync/m/kiosk/open-orders/ko-1/paid');
    expect(paid).toHaveLength(1);
    expect(paid[0].body).toMatchObject({ transactionId: done.documentId, transactionNumber: done.documentRef, posUserName: 'דנה כהן' });
    expect(h.engine.kioskOrders.pendingReports()).toBe(0);
    h.stop();
  });

  it('its vouchers are legs taken first; its tip is on top; the kiosk sent the bon — the till sends none', async () => {
    const o = order({
      tipAgorot: 500,
      voucherAgorot: 2400,
      dueAgorot: 6900 + 500 - 2400,
      kitchenSent: true,
      vouchers: [{ redemptionId: 'r-1', serial: 12, amountAgorot: 2400, eventName: 'פסטיבל', redeemed: [] }],
    });
    const h = await till([o]);
    await h.ok('kioskOrders.pay', { id: 'ko-1' });
    const c = h.state().checkout;
    expect([c.totalAgorot, c.dueAgorot, c.legs]).toEqual([7400, 5000, [{ method: 'production_voucher', amountAgorot: 2400, status: 'approved', voucher: { serial: 12 } }]]);
    await h.ok('checkout.cash', { amountAgorot: 5000 });
    const doc = h.svc.ledger.doc(h.state().checkout.documentId!)!;
    expect(doc.totals.tipAgorot).toBe(500);
    expect((doc.payments ?? []).map((l) => [l.method, l.amountAgorot])).toEqual([
      ['production_voucher', 2400],
      ['cash', 5000],
    ]);
    // The kiosk printed its bon before payment: nothing queued for the kitchen here.
    expect(h.state().checkout.kitchenWarning ?? null).toBeNull();
    h.stop();
  });

  it('backing out of the payment puts the order back (release) and empties the cart', async () => {
    const h = await till([order()]);
    await h.ok('kioskOrders.pay', { id: 'ko-1' });
    await h.ok('checkout.cancel');
    expect(h.state().checkout.phase).toBe('idle');
    expect(h.state().sell.lines).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted(h, 'sync/m/kiosk/open-orders/ko-1/release')).toHaveLength(1);
    expect(h.engine.kioskOrders.current()).toBeNull();
    h.stop();
  });

  it('refused over a basket of its own, by another till\'s hold, and in the cloud\'s words', async () => {
    const h = await till([order()], { 'POST sync/m/kiosk/open-orders/ko-1/lock': () => ({ __status: 409, detail: 'kiosk_order_locked', lockedBy: 'קופה 3' }) });
    await h.ok('sell.add', { productId: 'p-cola' });
    expect((await h.fail('kioskOrders.pay', { id: 'ko-1' })).message).toBe(KPAY_TEXT.basketBusy);
    expect(posted(h, 'sync/m/kiosk/open-orders/ko-1/lock')).toHaveLength(0);
    await h.ok('sell.clear');
    expect((await h.fail('kioskOrders.pay', { id: 'ko-1' })).message).toBe('בטיפול בקופה 3');
    expect(h.state().checkout.phase).toBe('idle');
    h.stop();
  });

  it('"ביטול הזמנה" with a reason; the slip scanned opens its order', async () => {
    const h = await till([order()]);
    expect((await h.fail('kioskOrders.cancel', { id: 'ko-1', reason: '' })).code).toBe('invalid_args');
    await h.ok('kioskOrders.cancel', { id: 'ko-1', reason: 'הלקוח ויתר' });
    expect(posted(h, 'sync/m/kiosk/open-orders/ko-1/cancel')[0].body).toMatchObject({ reason: 'הלקוח ויתר', posUserName: 'דנה כהן' });
    h.stop();
    const g = await till([order()]);
    await g.ok('kioskOrders.scan', { code: 'KO:L17' });
    expect(g.state().checkout.phase).toBe('tender');
    g.stop();
  });

  it('"paid" is kept while the cloud does not answer, and sent on the next round', async () => {
    let up = false;
    const h = await till([order()], {
      'POST sync/m/kiosk/open-orders/ko-1/paid': () => (up ? { ok: true } : { __status: 503 }),
    });
    await h.ok('kioskOrders.pay', { id: 'ko-1' });
    await h.ok('checkout.cash', { amountAgorot: 6900 });
    await h.ok('checkout.finish');
    await h.ok('kioskOrders.refresh');
    expect(h.engine.kioskOrders.pendingReports()).toBe(1);
    up = true;
    await h.ok('kioskOrders.refresh');
    expect(h.engine.kioskOrders.pendingReports()).toBe(0);
    h.stop();
  });

  it('a line this till does not sell: refused, the lock given back', async () => {
    const h = await till([order({ cart: { codec: codec([{ productId: 'p-gone', name: 'מנה שהוסרה', qty: 1, base: 1000, unit: 1000 }]) } })]);
    expect((await h.fail('kioskOrders.pay', { id: 'ko-1' })).message).toBe(KPAY_TEXT.notSoldHere('מנה שהוסרה'));
    expect(h.state().sell.lines).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted(h, 'sync/m/kiosk/open-orders/ko-1/release')).toHaveLength(1);
    h.stop();
  });
});

describe('the strip and the list', () => {
  const view = { waiting: 1, rows: [rowOf(orderOf(order({ voucherAgorot: 2500 }))!, NOW, money)], busyId: null, notice: null, active: null };
  const noop = () => undefined;
  it('the strip says how many; the list each order with "לתשלום" / "ביטול הזמנה"', () => {
    expect(renderToStaticMarkup(createElement(KioskOrdersStrip, { count: 2, onOpen: noop }))).toContain('הזמנות קיוסק ממתינות לתשלום (2)');
    expect(renderToStaticMarkup(createElement(KioskOrdersStrip, { count: 0, onOpen: noop }))).toBe('');
    const html = renderToStaticMarkup(createElement(KioskOrdersSheet, { view, actions: { refresh: noop, pay: noop, cancel: noop }, onClose: noop }));
    for (const w of ['הזמנות קיוסק ממתינות לתשלום', 'A-17', 'דנה · קיוסק רויאל', 'שובר: ₪25.00', 'לתשלום', 'ביטול הזמנה', 'סגירה']) expect(html).toContain(w);
    const empty = renderToStaticMarkup(createElement(KioskOrdersSheet, { view: { ...view, waiting: 0, rows: [] }, actions: { refresh: noop, pay: noop, cancel: noop }, onClose: noop }));
    expect(empty).toContain('אין הזמנות ממתינות');
  });
});
