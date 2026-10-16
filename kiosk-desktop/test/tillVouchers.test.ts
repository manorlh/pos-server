/**
 * Vouchers at the Windows till's payment (main/till/tillVouchers.ts over the real engine and ledger, a fake cloud) — the
 * Android till's CheckoutViewModel / PrepaidRedeemSheet / ProductionVoucherService behaviour:
 *
 *  - a discount voucher held for the sale, the total after it, confirmed with the document — or given back when abandoned;
 *  - a production voucher of groups ("פריט אחד מכל קבוצה") matched by the shared rules and held (reserve → confirm), booked by
 *    the cloud's answer: a deduction, a "שוברי הפקה" leg, ₪0 memo lines (closed by itself when nothing is left);
 *  - the cashier asked only when a unit fits several groups; a forced reduction asks a manager (VOUCHER_DISCOUNT_OVERRIDE);
 *  - a plain list voucher redeemed by `/redeem` and linked to the document (`…/transaction`);
 *  - "מצב בדיקה": the sale is a simulation — no money, "סיום בדיקה", nothing written, nothing confirmed;
 *  - scanned twice, after money was taken, offline; a voucher scanned on the sell screen goes to the payment;
 *  - the document's wire, the X's sections; a voucher product is credited from its receipt only.
 * Tests only: nothing here reaches a real server.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { documentWire } from '../src/main/fiscal/ledger';
import type { TillState } from '../src/shared/till/protocol';
import { MANAGER_PIN, harness, readyTill, type Harness, type HarnessOptions } from './tillEngineHarness';

const CODE = 'ABCD-EFGH-2345-6789';
const P = 'POST sync/m/prepaid-vouchers';

let h: Harness | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});

async function until<T>(fn: () => T | null | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const calls = (hh: Harness, path: string) => hh.sent.filter((c) => c.path.includes(path));

async function till(answers: HarnessOptions['answers'], o: Omit<HarnessOptions, 'answers'> = {}): Promise<Harness> {
  h = await readyTill({ ...o, answers: { [`${P}/reservations/*`]: () => ({ ok: true }), [`${P}/redemptions/*`]: () => ({ ok: true }), ...answers } });
  return h;
}

async function sell(hh: Harness, ...items: Array<[string, number]>) {
  for (const [productId, qty] of items) await hh.ok('sell.add', { productId, qty });
  await hh.ok('checkout.start');
}

/** A voucher scanned at the payment, its flow run to the end (its questions answered by [answer]). */
async function scan(hh: Harness, code = CODE, answer?: (s: TillState) => Promise<void>) {
  await hh.ok('checkout.voucher', { code });
  const flow = hh.engine.vouchers.lastScan!;
  if (answer) {
    await until(() => hh.state().dialog);
    await answer(hh.state());
  }
  return flow;
}

const vouchersOf = (hh: Harness) => hh.state().checkout.vouchers!;

/** The receipt printed for [docId]: its rows and texts as "label=value" / the text. */
function receiptOf(hh: Harness, docId: string): string[] {
  const job = hh.svc.printQueue.jobsFor(docId, 'receipt')[0];
  const ops = (JSON.parse(job.doc) as { ops: Array<{ t: string; label?: string; value?: string; text?: string }> }).ops;
  return ops.flatMap((o) => (o.t === 'row' ? [`${o.label}=${o.value}`] : o.t === 'text' ? [o.text!] : []));
}

/* ------------------------------------------------------------- the cloud's answers */

const discountDto = {
  id: 'v-d',
  voucherId: 'v-d',
  batchId: 'b-d',
  batchName: 'סדרה',
  serial: 7,
  kind: 'order_discount',
  stacking: 'unlimited',
  redeemable: true,
  usesAvailable: 1,
  benefit: { kind: 'order_discount', discountType: 'fixed', value: 1_000, minPurchaseAgorot: null, maxDiscountAgorot: null, maxUnits: null, productIds: [], categoryIds: [], promotionPolicy: 'combine', text: '₪10 הנחה על כל העסקה' },
};

/** "פריט אחד מכל קבוצה": food (the burger) and drink (the cola). */
const groupsDto = (over: Record<string, unknown> = {}) => ({
  id: 'v-g',
  voucherId: 'v-g',
  batchId: 'b-g',
  eventName: 'פסטיבל',
  serial: 8,
  kind: 'items',
  stacking: 'unlimited',
  redeemable: true,
  selection: 'groups',
  typeName: 'שובר ארוחה',
  productionName: 'קייטרינג אלון',
  redemptionAccounting: 'discount',
  pricing: 'cover',
  splitAllowed: true,
  wholeAtOnce: false,
  totalMax: 2,
  totalRemaining: 2,
  remaining: 2,
  groups: [
    { key: 'food', name: 'מזון', minQty: 0, maxQty: 1, remaining: 1, productIds: ['p-burger'], eligibleProductIds: ['p-burger'] },
    { key: 'drink', name: 'שתייה', minQty: 0, maxQty: 1, remaining: 1, productIds: ['p-cola'], eligibleProductIds: ['p-cola'] },
  ],
  ...over,
});

/** The cloud's hold of the units sent, priced by cover in [accounting] (production_voucher_reserve.value_units). */
const holdOf =
  (accounting: 'discount' | 'payment' | 'zero', id = 'res-g', extra: Record<string, unknown> = {}) =>
  (body: Record<string, unknown> | null) => {
    const units = (body!.units as Array<Record<string, unknown>>).map((u) => ({
      ref: u.ref,
      productId: u.productId,
      productName: u.productName,
      groupKey: u.groupKey ?? null,
      quantity: 1,
      valueAgorot: u.listPriceAgorot,
      coveredAgorot: accounting === 'zero' ? 0 : u.listPriceAgorot,
      listValueAgorot: u.listValueAgorot,
      forced: false,
      reductionAgorot: 0,
    }));
    return {
      ok: true,
      reservationId: id,
      status: 'held',
      redemptionAccounting: accounting,
      pricing: 'cover',
      units,
      coveredAgorot: units.reduce((s, u) => s + (u.coveredAgorot as number), 0),
      topUpAgorot: 0,
      tender: accounting === 'payment' ? 'production_voucher' : null,
      deduction: accounting === 'discount' ? { kind: 'production_voucher' } : null,
      serial: 8,
      typeName: 'שובר ארוחה',
      productionName: 'קייטרינג אלון',
      needsApproval: false,
      ...extra,
    };
  };

/* -------------------------------------------------------------------- tests */

describe('a discount voucher at the payment ("שובר הנחה")', () => {
  it("is looked up with what this till can do, held for the sale, the total after it, and confirmed with the document", async () => {
    const hh = await till({ [`${P}/lookup`]: () => discountDto, [`${P}/reserve`]: () => ({ reservationId: 'res-d', uses: 1 }) });
    await sell(hh, ['p-burger', 1], ['p-cola', 1]);
    expect(hh.state().checkout.totalAgorot).toBe(5_450);
    const out = await scan(hh);
    expect(out).toEqual({ kind: 'applied', text: 'השובר הוחל: ₪10 הנחה על כל העסקה' });
    const look = calls(hh, 'prepaid-vouchers/lookup')[0].body as Record<string, unknown>;
    expect(look).toMatchObject({ code: 'ABCDEFGH23456789', supportedKinds: ['items', 'order_discount', 'item_discount'] });
    expect(look.features).toEqual(['accounting', 'override', 'groups', 'production_voucher', 'reserve_goods']);
    expect(calls(hh, 'prepaid-vouchers/reserve')[0].body).toMatchObject({ uses: 1, testModeAware: true, posUserId: 'u-cashier' });
    expect(hh.state().checkout.totalAgorot).toBe(4_450);
    expect(vouchersOf(hh).items).toEqual([{ id: 'res-d', kind: 'discount', label: 'שובר #7 · סדרה', what: '₪10 הנחה על כל העסקה', amountAgorot: 1_000, test: false }]);
    await hh.ok('checkout.cash', { amountAgorot: 4_450 });
    const doc = hh.svc.ledger.doc(hh.state().checkout.documentId!)!;
    expect(doc.totals.totalAgorot).toBe(4_450);
    expect(doc.voucherDiscounts).toMatchObject([{ reservationId: 'res-d', amountAgorot: 1_000, uses: 1 }]);
    const wire = documentWire(doc);
    expect(wire.voucherDiscounts).toMatchObject([{ reservationId: 'res-d', kind: 'order_discount', amount: 10 }]);
    const confirm = await until(() => calls(hh, 'reservations/res-d/confirm')[0]);
    expect(confirm.body).toEqual({ transactionId: doc.id, amountAgorot: 1_000, uses: 1 });
  });

  it('removed ("הסר"), or the payment cancelled: given back; the total as before', async () => {
    const hh = await till({ [`${P}/lookup`]: () => discountDto, [`${P}/reserve`]: () => ({ reservationId: 'res-d', uses: 1 }) });
    await sell(hh, ['p-burger', 1]);
    await scan(hh);
    expect(hh.state().checkout.totalAgorot).toBe(3_200);
    await hh.ok('checkout.removeVoucher', { id: 'res-d' });
    expect(hh.state().checkout.totalAgorot).toBe(4_200);
    await until(() => calls(hh, 'reservations/res-d/release')[0]);
    await scan(hh);
    await hh.ok('checkout.cancel');
    await until(() => calls(hh, 'reservations/res-d/release')[1]);
  });
});

describe('a production voucher of groups ("פריט אחד מכל קבוצה")', () => {
  it('discount mode: one item of each group held and deducted — the rest of the line to pay; the document names its hold', async () => {
    const hh = await till({ [`${P}/lookup`]: () => groupsDto(), [`${P}/reserve`]: holdOf('discount') });
    await sell(hh, ['p-burger', 1], ['p-cola', 2]);
    const out = await scan(hh);
    expect(out).toEqual({ kind: 'applied', text: 'השובר הוחל: המבורגר, קולה' });
    const reserve = calls(hh, 'prepaid-vouchers/reserve')[0].body as Record<string, unknown>;
    expect(reserve).toMatchObject({ code: 'ABCDEFGH23456789', saleRef: expect.any(String), testModeAware: true, features: expect.arrayContaining(['groups', 'reserve_goods', 'accounting']) });
    expect((reserve.units as Array<Record<string, unknown>>).map((u) => [u.productId, u.groupKey, u.listPriceAgorot])).toEqual([
      ['p-burger', 'food', 4_200],
      ['p-cola', 'drink', 1_250],
    ]);
    const c = hh.state().checkout;
    expect(c.totalAgorot).toBe(1_250);
    expect(c.legs).toEqual([]);
    expect(c.vouchers).toMatchObject({ deductionAgorot: 5_450, items: [{ id: 'res-g', kind: 'production', label: 'שובר #8 · שובר ארוחה', amountAgorot: 5_450 }] });
    expect(hh.state().sell.lines.find((l) => l.productId === 'p-burger')).toMatchObject({ voucher: 'כלול בשובר #8 · שובר ארוחה', totalAgorot: 0 });
    expect(hh.state().sell.lines.find((l) => l.productId === 'p-cola')).toMatchObject({ voucher: 'כלול בשובר #8 · שובר ארוחה (1)', totalAgorot: 1_250 });
    await hh.ok('checkout.cash', { amountAgorot: 1_250 });
    const doc = hh.svc.ledger.doc(hh.state().checkout.documentId!)!;
    expect(doc.totals).toMatchObject({ grossAgorot: 6_700, discountAgorot: 5_450, prepaidDeductionAgorot: 5_450, totalAgorot: 1_250 });
    const wire = documentWire(doc);
    const items = wire.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.prepaidDeduction)).toEqual([42, 12.5]);
    expect(items.map((i) => i.notes)).toEqual(['כלול בשובר #8 · שובר ארוחה', 'כלול בשובר #8 · שובר ארוחה (1)']);
    expect(wire.voucherDiscounts).toEqual([
      {
        reservationId: 'res-g',
        voucherId: 'v-g',
        batchId: 'b-g',
        serial: 8,
        batchName: 'פסטיבל',
        kind: 'production_voucher',
        uses: 1,
        amount: 54.5,
        lines: [
          { itemId: doc.itemIds[0], amount: 42 },
          { itemId: doc.itemIds[1], amount: 12.5 },
        ],
        typeName: 'שובר ארוחה',
        units: [
          { productName: 'המבורגר', groupName: 'מזון', quantity: 1 },
          { productName: 'קולה', groupName: 'שתייה', quantity: 1 },
        ],
      },
    ]);
    expect(wire.documentDiscount).toBe(54.5);
    const confirm = await until(() => calls(hh, 'reservations/res-g/confirm')[0]);
    expect(confirm.body).toEqual({ transactionId: doc.id, amountAgorot: 5_450 });
    // The paper: the lines' marks, "קיזוז שובר הפקה מס׳ 0008" (never "הנחה"), the total after it.
    const paper = receiptOf(hh, doc.id);
    expect(paper).toContain('כלול בשובר #8 · שובר ארוחה');
    expect(paper).toContain('קיזוז שובר הפקה מס׳ 0008=-54.50');
    expect(paper).toContain('סה"כ פריטים לתשלום=12.50');
    expect(paper.some((r) => r.startsWith('הנחה='))).toBe(false);
    // The X: the deduction out of the sales and out of the discounts, the vouchers' own section.
    const x = await hh.ok<Record<string, unknown>>('report.x');
    expect(x).toMatchObject({ salesAgorot: 1_250, discountsAgorot: 0, cashAgorot: 1_250 });
    expect((x.voucherInfo as Array<{ label: string; value: string }>).slice(0, 4)).toEqual([
      { label: 'שוברי הפקה', value: '', title: true },
      { label: 'שוברים', value: '1' },
      { label: 'פריטים', value: '2' },
      { label: 'קיזוזי שוברים', value: '54.50' },
    ]);
  });

  it('payment mode: a "שוברי הפקה" leg naming its hold, cash for the rest; the X counts it apart from the drawer', async () => {
    const hh = await till({ [`${P}/lookup`]: () => groupsDto({ redemptionAccounting: 'payment' }), [`${P}/reserve`]: holdOf('payment', 'res-p') });
    await sell(hh, ['p-burger', 1], ['p-cola', 1]);
    await scan(hh);
    // The vouchers paid it all and nothing is left to offer: the sale closed by itself, no drawer, no money.
    const c = await until(() => (hh.state().checkout.phase === 'done' ? hh.state().checkout : null));
    expect(c.totalAgorot).toBe(5_450);
    expect(c.legs).toEqual([{ method: 'production_voucher', amountAgorot: 5_450, status: 'approved', voucher: { serial: 8 } }]);
    const wire = documentWire(hh.svc.ledger.doc(c.documentId!)!);
    expect(wire.paymentMethod).toBe('production_voucher');
    expect((wire.payments as Array<Record<string, unknown>>).map((p) => [p.method, p.amount, p.reservationId])).toEqual([['production_voucher', 54.5, 'res-p']]);
    expect(wire.totalAmount).toBe(54.5);
    expect(wire.documentDiscount).toBeUndefined();
  });

  it('payment mode with something left: the leg first, the cash after it; paymentMethod the last real tender', async () => {
    const hh = await till({ [`${P}/lookup`]: () => groupsDto({ redemptionAccounting: 'payment', groups: [groupsDto().groups[0]] }), [`${P}/reserve`]: holdOf('payment', 'res-p') });
    await sell(hh, ['p-burger', 1], ['p-cola', 1]);
    await scan(hh);
    expect(hh.state().checkout.dueAgorot).toBe(1_250);
    await hh.ok('checkout.cash', { amountAgorot: 2_000 });
    const doc = hh.svc.ledger.doc(hh.state().checkout.documentId!)!;
    const wire = documentWire(doc);
    expect((wire.payments as Array<Record<string, unknown>>).map((p) => [p.method, p.amount, p.reservationId])).toEqual([
      ['production_voucher', 42, 'res-p'],
      ['cash', 12.5, undefined],
    ]);
    expect(wire.paymentMethod).toBe('cash');
    expect(wire.changeAmount).toBe(7.5);
    expect(receiptOf(hh, doc.id)).toContain('שובר הפקה=42.00');
    const x = await hh.ok<Record<string, unknown>>('report.x');
    expect(x).toMatchObject({ vouchersAgorot: 4_200, cashAgorot: 1_250, expectedCashAgorot: 20_000 + 1_250 });
    await until(() => calls(hh, 'reservations/res-p/confirm')[0]);
  });

  it('zero mode: the covered goods at ₪0 with their value as a memo — nothing left to pay, the sale closes by itself', async () => {
    const hh = await till({ [`${P}/lookup`]: () => groupsDto({ redemptionAccounting: 'zero', groups: [groupsDto().groups[0]] }), [`${P}/reserve`]: holdOf('zero', 'res-z') });
    await sell(hh, ['p-burger', 1]);
    await scan(hh);
    const c = await until(() => (hh.state().checkout.phase === 'done' ? hh.state().checkout : null));
    const doc = hh.svc.ledger.doc(c.documentId!)!;
    expect(doc.totals.totalAgorot).toBe(0);
    const wire = documentWire(doc);
    expect((wire.items as Array<Record<string, unknown>>)[0]).toMatchObject({ unitPrice: 0, totalPrice: 0, voucherMemoValueAgorot: 4_200, voucherReservationId: 'res-z', notes: 'כלול בשובר #8 · שובר ארוחה' });
    expect(wire.voucherMemo).toBe(true);
    expect(wire.voucherDiscounts).toBeUndefined();
    await until(() => calls(hh, 'reservations/res-z/confirm')[0]);
    expect(calls(hh, 'reservations/res-z/confirm')[0].body).toEqual({ transactionId: doc.id, amountAgorot: 0 });
    // The paper: the line at ₪0 with its value as a memo, and the goods' value — outside every total.
    const paper = receiptOf(hh, doc.id);
    expect(paper).toContain('₪42.00 · כלול בשובר #8 · שובר ארוחה');
    expect(paper).toContain('שווי הפריטים בשובר: ₪42.00 · שולם בשובר הפקה');
  });

  it('`voucherAutoClose` off: ₪0 left waits for "סגור עסקה וממש שובר"', async () => {
    const hh = await till({ [`${P}/lookup`]: () => groupsDto({ redemptionAccounting: 'zero', groups: [groupsDto().groups[0]] }), [`${P}/reserve`]: holdOf('zero', 'res-z') }, { parameters: { voucherAutoClose: 'off' } });
    await sell(hh, ['p-burger', 1]);
    await scan(hh);
    expect(hh.state().checkout).toMatchObject({ phase: 'tender', dueAgorot: 0 });
    await hh.ok('checkout.cash', { amountAgorot: 0 });
    expect(hh.state().checkout.phase).toBe('done');
  });

  it('a unit that fits two groups: the cashier says which; its group goes with the hold', async () => {
    const both = groupsDto({
      groups: [
        { key: 'drink', name: 'שתייה', minQty: 0, maxQty: 1, remaining: 1, eligibleProductIds: ['p-cola'] },
        { key: 'side', name: 'תוספת', minQty: 0, maxQty: 1, remaining: 1, eligibleProductIds: ['p-cola', 'p-burger'] },
      ],
    });
    const hh = await till({ [`${P}/lookup`]: () => both, [`${P}/reserve`]: holdOf('discount') });
    await sell(hh, ['p-cola', 1]);
    const flow = await scan(hh, CODE, async (s) => {
      expect(s.dialog).toMatchObject({ title: 'לאיזו קבוצה שייך הפריט?', body: '"קולה" מתאים לכמה קבוצות פריטים בשובר — בחרו לאיזו לשייך אותו' });
      expect(s.dialog!.actions.map((a) => a.label)).toEqual(['שתייה', 'תוספת', 'לא בשובר', 'ביטול']);
      await hh.ok('dialog.answer', { dialogId: s.dialog!.id, action: 'g:side' });
    });
    expect((await flow).kind).toBe('applied');
    expect((calls(hh, 'prepaid-vouchers/reserve')[0].body as { units: Array<{ groupKey: string }> }).units[0].groupKey).toBe('side');
  });

  it('which item fills a full group is a choice: the one picked goes with the hold', async () => {
    const one = groupsDto({ groups: [{ key: 'drink', name: 'שתייה', minQty: 0, maxQty: 1, remaining: 1, eligibleProductIds: ['p-cola', 'p-burger'] }] });
    const hh = await till({ [`${P}/lookup`]: () => one, [`${P}/reserve`]: holdOf('discount') });
    await sell(hh, ['p-cola', 1], ['p-burger', 1]);
    const flow = await scan(hh, CODE, async (s) => {
      expect(s.dialog).toMatchObject({ title: 'איזה פריט השובר מכסה?' });
      expect(s.dialog!.actions.map((a) => a.label)).toEqual(['קולה', 'המבורגר', 'ביטול']);
      await hh.ok('dialog.answer', { dialogId: s.dialog!.id, action: s.dialog!.actions[1].id });
    });
    expect((await flow).kind).toBe('applied');
    expect((calls(hh, 'prepaid-vouchers/reserve')[0].body as { units: Array<{ productId: string }> }).units.map((u) => u.productId)).toEqual(['p-burger']);
  });

  it('a package not complete: said, nothing held', async () => {
    const meal = groupsDto({ splitAllowed: false, wholeAtOnce: true, groups: groupsDto().groups.map((g) => ({ ...g, minQty: 1 })) });
    const hh = await till({ [`${P}/lookup`]: () => meal, [`${P}/reserve`]: holdOf('discount') });
    await sell(hh, ['p-burger', 1]);
    expect(await scan(hh)).toEqual({ kind: 'refused', text: 'חסר שתייה להשלמת שובר ארוחה' });
    expect(calls(hh, 'prepaid-vouchers/reserve')).toEqual([]);
    expect(vouchersOf(hh).error).toBe('חסר שתייה להשלמת שובר ארוחה');
  });

  it("a forced reduction: a manager's code (VOUCHER_DISCOUNT_OVERRIDE), then held again with the approval", async () => {
    let n = 0;
    const hh = await till({
      [`${P}/lookup`]: () => groupsDto(),
      [`${P}/reserve`]: (body) => {
        n += 1;
        if (n === 1) return { __status: 409, detail: { code: 'prepaid_voucher_approval_needed', message: 'נדרש אישור מנהל להנחה שהוגדרה בשובר', needsApproval: true } };
        return holdOf('discount')(body);
      },
    });
    await sell(hh, ['p-burger', 1], ['p-cola', 1]);
    const flow = await scan(hh, CODE, async (s) => {
      expect(s.dialog).toMatchObject({ kind: 'manager_approval', body: 'נדרש אישור מנהל להנחה שהוגדרה בשובר' });
      await hh.ok('dialog.answer', { dialogId: s.dialog!.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    });
    expect((await flow).kind).toBe('applied');
    expect(calls(hh, 'prepaid-vouchers/reserve')[1].body).toMatchObject({ approval: { posUserId: 'u-manager', method: 'pin' } });
  });

  it('a one-sale voucher with something left: the one confirmation before the close', async () => {
    const left = groupsDto({ splitAllowed: false, wholeAtOnce: true });
    const hh = await till({ [`${P}/lookup`]: () => left, [`${P}/reserve`]: holdOf('discount') });
    await sell(hh, ['p-burger', 1]);
    expect(vouchersOf(hh).entitlement).toBeNull();
    await scan(hh);
    expect(vouchersOf(hh).entitlement).toContain('הלקוח זכאי לעוד פריט');
    // Nothing left to pay, but the customer is entitled to more: it waits for the cashier.
    expect(hh.state().checkout).toMatchObject({ phase: 'tender', dueAgorot: 0 });
    const ask = (await hh.ok<{ dialogId: string }>('checkout.cash', { amountAgorot: 0 }))!;
    expect(hh.state().dialog).toMatchObject({ id: ask.dialogId, body: 'סגירה עכשיו — מה שלא מומש מהשובר יאבד (שתייה ×1)' });
    await hh.ok('dialog.answer', { dialogId: ask.dialogId, action: 'approve' });
    expect(hh.state().checkout.phase).toBe('done');
  });
});

describe('a plain list voucher ("/redeem")', () => {
  it('its items the sale holds redeemed now, booked as a "שוברי הפקה" leg, linked to the document', async () => {
    const plain = { id: 'v-l', voucherId: 'v-l', batchId: 'b-l', serial: 5, kind: 'items', stacking: 'unlimited', redeemable: true, selection: 'items', pricing: 'cover', redemptionAccounting: 'payment', splitAllowed: true, items: [{ productId: 'p-cola', name: 'קולה', quantity: 1, remaining: 1 }] };
    const hh = await till({
      [`${P}/lookup`]: () => plain,
      [`${P}/redeem`]: () => ({ redemptionId: 'red-1', redeemed: [{ productId: 'p-cola', quantity: 1 }], voucher: { serial: 5, redemptionAccounting: 'payment' } }),
    });
    await sell(hh, ['p-burger', 1], ['p-cola', 1]);
    expect(await scan(hh)).toEqual({ kind: 'applied', text: 'השובר הוחל: קולה' });
    expect(calls(hh, 'prepaid-vouchers/redeem')[0].body).toMatchObject({ code: 'ABCDEFGH23456789', items: [{ productId: 'p-cola', quantity: 1 }], forfeitRest: false, testModeAware: true });
    expect(hh.state().checkout).toMatchObject({ dueAgorot: 4_200, legs: [{ method: 'production_voucher', amountAgorot: 1_250 }] });
    await hh.ok('checkout.cash', { amountAgorot: 4_200 });
    const doc = hh.svc.ledger.doc(hh.state().checkout.documentId!)!;
    const wire = documentWire(doc);
    expect((wire.payments as Array<Record<string, unknown>>)[0]).toMatchObject({ method: 'production_voucher', amount: 12.5 });
    expect((wire.payments as Array<Record<string, unknown>>)[0].reservationId).toBeUndefined();
    const link = await until(() => calls(hh, 'redemptions/red-1/transaction')[0]);
    expect(link.body).toEqual({ transactionId: doc.id });
  });

  it('cancelled: the redemption goes back on the voucher', async () => {
    const plain = { id: 'v-l', voucherId: 'v-l', batchId: 'b-l', serial: 5, kind: 'items', redeemable: true, selection: 'items', pricing: 'cover', redemptionAccounting: 'payment', splitAllowed: true, items: [{ productId: 'p-cola', name: 'קולה', quantity: 1, remaining: 1 }] };
    const hh = await till({ [`${P}/lookup`]: () => plain, [`${P}/redeem`]: () => ({ redemptionId: 'red-2', redeemed: [{ productId: 'p-cola', quantity: 1 }], voucher: { serial: 5 } }) });
    await sell(hh, ['p-cola', 1], ['p-burger', 1]);
    await scan(hh);
    await hh.ok('checkout.cancel');
    await until(() => calls(hh, 'redemptions/red-2/reverse')[0]);
  });
});

describe('"מצב בדיקה" (a batch being checked)', () => {
  it('said first, the sale a simulation: no money, "סיום בדיקה", nothing written, nothing confirmed', async () => {
    const hh = await till({ [`${P}/lookup`]: () => groupsDto({ testMode: true }), [`${P}/reserve`]: holdOf('discount', 'test-1', { testMode: true }) });
    await sell(hh, ['p-burger', 1], ['p-cola', 2]);
    const flow = await scan(hh, CODE, async (s) => {
      expect(s.dialog).toMatchObject({ title: 'מצב בדיקה', body: 'מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם' });
      await hh.ok('dialog.answer', { dialogId: s.dialog!.id, action: 'approve' });
    });
    expect((await flow).kind).toBe('applied');
    expect(vouchersOf(hh)).toMatchObject({ testBar: 'מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם', testDue: 'נותר לתשלום: ₪12.50 — בבדיקה לא נגבה דבר' });
    expect((await hh.fail('checkout.cash', { amountAgorot: 1_250 })).message).toBe('לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו');
    expect((await hh.fail('checkout.card')).message).toBe('לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו');
    const end = await hh.ok<{ lines: string[] }>('checkout.finishTest');
    expect(end.lines).toEqual(['בדיקה הושלמה — השובר תקין. לא מומש ולא נרשם דבר', 'היו מכוסים בשובר: 2 פריטים · ₪54.50', 'היה נותר לתשלום: ₪12.50']);
    expect(hh.state().checkout).toMatchObject({ phase: 'done', testEnd: end.lines, documentRef: null });
    expect(hh.state().sell.lines).toEqual([]);
    expect(hh.svc.ledger.docsOfShift(hh.svc.ledger.currentShift()!.id)).toEqual([]);
    await hh.ok('checkout.finish');
    expect(calls(hh, '/confirm')).toEqual([]);
    expect(calls(hh, '/release')).toEqual([]);
  });

  it('never with a real voucher in the same sale', async () => {
    let n = 0;
    const hh = await till({
      [`${P}/lookup`]: () => (++n === 1 ? groupsDto({ testMode: true }) : { ...discountDto }),
      [`${P}/reserve`]: holdOf('discount', 'test-1', { testMode: true }),
    });
    await sell(hh, ['p-burger', 1]);
    await scan(hh, CODE, async (s) => void (await hh.ok('dialog.answer', { dialogId: s.dialog!.id, action: 'approve' })));
    expect(await scan(hh, 'BCDE-FGHJ-2345-6789')).toEqual({ kind: 'refused', text: 'לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו' });
  });
});

describe('the scan itself', () => {
  it('scanned twice: said with what it covers, never sent again', async () => {
    const hh = await till({ [`${P}/lookup`]: () => groupsDto(), [`${P}/reserve`]: holdOf('discount') });
    // A second cola: something is left to pay, the payment stays open.
    await sell(hh, ['p-burger', 1], ['p-cola', 2]);
    await scan(hh);
    const again = await hh.fail('checkout.voucher', { code: 'abcd efgh 2345 6789' });
    expect(again.message).toBe('השובר כבר נסרק בעסקה זו (שובר #8 · המבורגר, קולה · ₪54.50)');
    expect(calls(hh, 'prepaid-vouchers/lookup')).toHaveLength(1);
  });

  it('after money was taken: refused; offline: said; refused by the cloud: its words', async () => {
    const hh = await till({
      [`${P}/lookup`]: (body) => {
        if (String(body!.code) === 'ABCDEFGH23456789') return { __status: 409, detail: 'prepaid_voucher_used' };
        throw new Error('no network');
      },
    });
    await sell(hh, ['p-burger', 1]);
    expect(await scan(hh)).toEqual({ kind: 'refused', text: 'השובר כבר מומש במלואו — אין בו יתרה, ולא ניתן לממש אותו שוב.' });
    expect(await scan(hh, 'BCDE-FGHJ-2345-6789')).toEqual({ kind: 'refused', text: 'אין חיבור לענן — השובר לא נבדק ולא מומש, כי מימוש נבדק בענן בלבד. בדקו את החיבור ונסו שוב.' });
    await hh.ok('checkout.cash', { amountAgorot: 1_000 });
    expect((await hh.fail('checkout.voucher', { code: CODE })).message).toBe('יש לממש שוברים לפני התשלום — בטלו את התשלום שהתקבל וסרקו שוב');
  });

  it('on the sell screen with items in the order: to the payment, where it is applied', async () => {
    const hh = await till({ [`${P}/lookup`]: () => groupsDto(), [`${P}/reserve`]: holdOf('discount') });
    await hh.ok('sell.add', { productId: 'p-burger' });
    await hh.ok('sell.voucher', { code: `PV:${CODE.replace(/-/g, '')}` });
    await hh.engine.vouchers.lastScan;
    expect(hh.state().checkout).toMatchObject({ phase: 'tender', totalAgorot: 0 });
    // An empty order: the items first.
    await hh.ok('checkout.cancel');
    await hh.ok('sell.clear');
    expect((await hh.fail('sell.voucher', { code: CODE })).message).toBe('השובר משלם על פריטים שבסל — הוסיפו את הפריטים לסל, ואז סרקו את השובר (או לחצו "שובר" במסך התשלום).');
  });
});

describe('a voucher product on a refund', () => {
  it('is credited from its receipt only — never a catalog return', async () => {
    h = harness({ products: [{ id: 'p-gift', name: 'שובר מתנה', price: 100, categoryId: 'c-main', inStock: true, isAvailable: true, salesChannel: 'all', voucherId: '7c0a0e3e-1111-4222-8333-444455556666' }] });
    await h.ok('session.login', { pin: MANAGER_PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    expect((await h.ok<{ products: Array<{ id: string; voucher?: boolean }> }>('catalog.snapshot')).products[0]).toMatchObject({ id: 'p-gift', voucher: true });
    await h.ok('refund.button');
    await h.ok('refund.catalog');
    const no = await h.fail('sell.add', { productId: 'p-gift' });
    expect(no).toMatchObject({ code: 'refund_refused', message: 'שובר מתנה הוא שובר. זיכוי שובר רק מקבלה.' });
  });
});
