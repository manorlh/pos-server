/**
 * Vouchers at the Windows till, the pure rules (core/till/vouchers.ts) — pos-android VoucherAutoApplyTest, VoucherTestModeTest,
 * ProductionVoucherBookingTest, VoucherCloseTest's expectations: "מימוש אוטומטי בסריקת שובר" (applied at once, or the question
 * a person answers), the booking by accounting (₪0 lines, a deduction, a "שוברי הפקה" leg), a second voucher on what the first
 * left and "הסר" pricing the sale again, "מצב בדיקה" words, the close's words, the X's sections, and a voucher product's refund.
 */

import { describe, expect, it } from 'vitest';
import { lineGross, saleTotals, buildXTill, type SaleLine, type XDoc } from '../src/core/sale';
import {
  bookProductionVouchers,
  choiceOf,
  coverPriced,
  coveredUnitCounts,
  isHeld,
  isPlain,
  resolveVoucherAutoApply,
  termsOf,
  voucherAppliedWhat,
  voucherAutoDecision,
  voucherCloseMessages,
  voucherDayLimitReached,
  voucherGroupChoice,
  voucherInfoFromJson,
  voucherInfoJson,
  voucherInfoLines,
  voucherInfoOf,
  voucherRefundRefusal,
  voucherRescanText,
  voucherSaleCap,
  voucherScanState,
  voucherTestEndLines,
  voucherTestMixRefusal,
  voucherTestMoneyRefusal,
  voucherUnitsOf,
  withPick,
  VOUCHER_TEST_TEXT,
  type AppliedProduction,
  type VoucherAccounting,
  type VoucherTerms,
} from '../src/core/till/vouchers';

/* ------------------------------------------------------------------ the sale */

const line = (key: string, productId: string, agorot: number, qty = 1, extra: Partial<SaleLine> = {}): SaleLine => ({
  key,
  productId,
  name: productId,
  sku: null,
  basePriceAgorot: agorot,
  options: [],
  notes: [],
  qty,
  categoryId: 'c',
  ...extra,
});

const burger = (key = 'l1', qty = 1) => line(key, 'burger', 5_000, qty);
const cola = (key = 'l2', qty = 1) => line(key, 'cola', 1_200, qty);
const water = (key = 'l3', qty = 1) => line(key, 'water', 800, qty);
const fries = (key = 'l3', qty = 1) => line(key, 'fries', 1_500, qty);
const coffee = (key = 'l1', qty = 1) => line(key, 'coffee', 1_000, qty);

const group = (key: string, name: string, products: string[], o: { min?: number; max?: number; remaining?: number } = {}) => ({
  key,
  name,
  minUnits: o.min ?? 1,
  maxUnits: o.max ?? 1,
  remaining: o.remaining ?? o.max ?? 1,
  productIds: new Set(products),
  excludedIds: new Set<string>(),
  allowRepeat: true,
  item: false,
});

/** "מנה + משקה" (VoucherAutoApplyTest.meal). */
const meal = (accounting: VoucherAccounting = 'zero', split = false, drinks = ['cola', 'water']): VoucherTerms => ({
  typeName: 'שובר ארוחה',
  pricing: 'cover',
  tillValue: null,
  accounting,
  groups: [group('main', 'מנה', ['burger']), group('drink', 'משקה', drinks)],
  maxUnits: null,
  unitsLeft: null,
  splitAllowed: split,
  includeExtras: false,
  listItems: false,
});

const stateOf = (terms: VoucherTerms, lines: SaleLine[], cap: number | null = null) => voucherScanState(terms, voucherUnitsOf(lines, { includeExtras: false, covered: new Map() }), cap);

const totalOf = (ls: readonly SaleLine[]) => saleTotals(ls, 0).totalAgorot;

/** A voucher applied as the cloud (or `/redeem`) would price it by cover: the placed units at their own prices (₪0 in zero mode). */
function applied(terms: VoucherTerms, lines: SaleLine[], serial = 12, id = 'r1', prepaid: AppliedProduction[] = []): AppliedProduction {
  const booked = bookProductionVouchers(lines, prepaid, totalOf);
  const units = voucherUnitsOf(booked.lines, { includeExtras: terms.includeExtras, covered: coveredUnitCounts(booked.redemptions) });
  const st = voucherScanState(terms, units);
  const placed = st.units.filter((u) => u.id in st.assigned);
  const priced = coverPriced(terms.accounting, placed, (u) => ({ key: st.assigned[u.id], name: terms.groups.find((g) => g.key === st.assigned[u.id])?.name ?? null }));
  return {
    source: 'reserve',
    reservationId: `res-${id}`,
    redemptionId: id,
    code: `CODE-${id}`,
    voucherId: `v-${id}`,
    batchId: 'b1',
    serial,
    typeName: terms.typeName,
    batchName: null,
    productionName: null,
    accounting: terms.accounting,
    pricing: 'cover',
    tillValue: null,
    includeExtras: false,
    amountAgorot: priced.reduce((s, u) => s + u.covered, 0),
    topUpAgorot: 0,
    note: null,
    units: priced,
    inSale: { voucherId: `v-${id}`, batchId: 'b1', kind: 'items', stacking: 'unlimited' },
    testMode: false,
    approval: null,
  };
}

const due = (lines: SaleLine[], list: AppliedProduction[]) => {
  const b = bookProductionVouchers(lines, list, totalOf);
  return totalOf(b.lines) - b.legs.reduce((s, l) => s + l.amountAgorot, 0);
};

/* ------------------------------------------------------------- the parameter */

describe('voucherAutoApply', () => {
  it('on unless said off', () => {
    expect(resolveVoucherAutoApply({})).toBe(true);
    expect(resolveVoucherAutoApply({ voucherAutoApply: 'on' })).toBe(true);
    expect(resolveVoucherAutoApply({ voucherAutoApply: 'junk' })).toBe(true);
    expect(resolveVoucherAutoApply({ voucherAutoApply: 'off' })).toBe(false);
    expect(resolveVoucherAutoApply({ voucherAutoApply: ' FALSE ' })).toBe(false);
  });
});

/* -------------------------------------------------------------- the decision */

describe('the decision: applied at once, or a question', () => {
  it("goods - the order holds exactly the voucher's items - applied; a paid item beside it changes nothing", () => {
    const single: VoucherTerms = { ...meal(), typeName: 'המבורגר', groups: [group('main', 'מנה', ['burger'])] };
    expect(voucherAutoDecision(true, stateOf(single, [burger()]))).toEqual({ kind: 'apply' });
    expect(voucherAutoDecision(true, stateOf(single, [burger(), fries()]))).toEqual({ kind: 'apply' });
  });

  it('a group voucher - one candidate per group - applied', () => {
    const st = stateOf(meal(), [burger(), cola(), fries()]);
    expect(st.assigned).toEqual({ 'l1#0': 'main', 'l2#0': 'drink' });
    expect(voucherAutoDecision(true, st)).toEqual({ kind: 'apply' });
  });

  it('an ambiguous product - it fits two open groups - a question', () => {
    const terms: VoucherTerms = { ...meal('zero', true), groups: [group('drink', 'משקה', ['water']), group('side', 'תוספת', ['water', 'fries'])] };
    expect(voucherAutoDecision(true, stateOf(terms, [water('l1')]))).toEqual({ kind: 'sheet', why: 'ambiguous' });
    // The cashier's pick places it.
    const st = stateOf(terms, [water('l1')]);
    expect(withPick(st, 'l1#0', 'side').assigned).toEqual({ 'l1#0': 'side' });
  });

  it('which item fills a full group is a choice - more of the same item is not', () => {
    const choice = stateOf(meal('zero', true), [burger(), cola(), water()]);
    expect(voucherGroupChoice(choice)).toBe(true);
    expect(voucherAutoDecision(true, choice)).toEqual({ kind: 'sheet', why: 'choice' });
    const c = choiceOf(choice)!;
    expect(c.groupKey).toBe('drink');
    expect(c.candidates.map((u) => u.productId)).toEqual(['cola', 'water']);
    // Water picked in place of the cola.
    expect(withPick(choice, 'l3#0', 'drink', c.placed).assigned).toEqual({ 'l1#0': 'main', 'l3#0': 'drink' });
    const same = stateOf(meal(), [burger(), cola('l2', 2)]);
    expect(voucherGroupChoice(same)).toBe(false);
    expect(voucherAutoDecision(true, same)).toEqual({ kind: 'apply' });
  });

  it('a package not complete in the order - its items are picked first', () => {
    expect(voucherAutoDecision(true, stateOf(meal(), [burger()]))).toEqual({ kind: 'sheet', why: 'incomplete' });
    expect(stateOf(meal(), [burger()]).refusal?.text).toBe('חסר משקה להשלמת שובר ארוחה');
    expect(voucherAutoDecision(true, stateOf(meal(), [fries('l1')]))).toEqual({ kind: 'sheet', why: 'incomplete' });
  });

  it('entitlement left is no choice - applied', () => {
    expect(voucherAutoDecision(true, stateOf(meal('zero', true), [burger()]))).toEqual({ kind: 'apply' });
  });

  it('a punch card - its units within what is left, within its per-sale limit - applied', () => {
    const card: VoucherTerms = { ...meal('zero', true), typeName: 'כרטיסיית קפה', maxUnits: 10, unitsLeft: 6, groups: [group('coffee', 'קפה', ['coffee'], { max: 10, remaining: 6 })] };
    const st = stateOf(card, [coffee('l1', 2)]);
    expect(Object.keys(st.assigned)).toHaveLength(2);
    expect(voucherAutoDecision(true, st)).toEqual({ kind: 'apply' });
    const capped = stateOf(card, [coffee('l1', 4)], voucherSaleCap(6, 2, 0));
    expect(Object.keys(capped.assigned)).toHaveLength(2);
    expect(voucherAutoDecision(true, capped)).toEqual({ kind: 'apply' });
    expect(voucherSaleCap(6, 4, 3)).toBe(1);
    expect(voucherSaleCap(6, null)).toBe(6);
  });

  it('a discount voucher keeps the order\'s own path; test mode, a test voucher, the parameter off, an older voucher - a question', () => {
    const st = stateOf(meal(), [burger(), cola()]);
    expect(voucherAutoDecision(true, st, { discount: true })).toEqual({ kind: 'discount' });
    expect(voucherAutoDecision(false, null, { discount: true })).toEqual({ kind: 'discount' });
    expect(voucherAutoDecision(true, st, { testMode: true })).toEqual({ kind: 'sheet', why: 'test_mode' });
    expect(voucherAutoDecision(true, st, { testNeedsApproval: true })).toEqual({ kind: 'sheet', why: 'test_approval' });
    expect(voucherAutoDecision(false, st)).toEqual({ kind: 'sheet', why: 'off' });
    expect(voucherAutoDecision(true, null)).toEqual({ kind: 'sheet', why: 'not_groups' });
  });
});

/* -------------------------------------------------------------- the booking */

describe("the order's lines and total, as the payment books each voucher", () => {
  const c = () => [burger(), cola(), fries()];

  it('zero: the covered lines at ₪0 and marked, the total updated', () => {
    const a = applied(meal(), c());
    const b = bookProductionVouchers(c(), [a], totalOf);
    expect(totalOf(b.lines)).toBe(1_500);
    expect(b.legs).toEqual([]);
    const covered = b.lines.filter((l) => l.key !== 'l3');
    expect(covered.every((l) => lineGross(l) === 0 && l.voucherMark!.startsWith('כלול בשובר #12'))).toBe(true);
    expect(covered.every((l) => l.noDiscount === true)).toBe(true);
    expect(`השובר הוחל: ${voucherAppliedWhat(a, c())}`).toBe('השובר הוחל: burger, cola');
    // The redemption on the sale: its units by line, their list values (the memo).
    expect(b.redemptions[0].units.map((u) => [u.lineKey, u.listValueAgorot, u.salePriceAgorot])).toEqual([
      ['l1', 5_000, 0],
      ['l2', 1_200, 0],
    ]);
  });

  it('discount: a deduction lowers the total (inside the document discount); payment: a "שוברי הפקה" leg pays it', () => {
    const deduction = bookProductionVouchers(c(), [applied(meal('discount'), c())], totalOf);
    expect(totalOf(deduction.lines)).toBe(1_500);
    expect(deduction.legs).toEqual([]);
    expect(deduction.lines.find((l) => l.key === 'l1')!.prepaidDeductionAgorot).toBe(5_000);
    expect(deduction.lines.find((l) => l.key === 'l1')!.voucherMark).toBe('כלול בשובר #12 · שובר ארוחה');
    const t = saleTotals(deduction.lines, 0.18);
    expect(t.discountAgorot).toBe(6_200);
    expect(t.prepaidDeductionAgorot).toBe(6_200);
    const payment = bookProductionVouchers(c(), [applied(meal('payment'), c())], totalOf);
    expect(totalOf(payment.lines)).toBe(7_700);
    expect(payment.legs.map((l) => l.amountAgorot)).toEqual([6_200]);
    expect(due(c(), [applied(meal('payment'), c())])).toBe(1_500);
  });

  it('two colas, one covered - the rest of the line to pay', () => {
    const lines = [burger(), cola('l2', 2)];
    const a = applied(meal(), lines);
    expect(voucherAppliedWhat(a, lines)).toBe('burger, cola');
    const b = bookProductionVouchers(lines, [a], totalOf);
    expect(totalOf(b.lines)).toBe(1_200);
    // The covered unit on a line of its own, at ₪0; the other cola stays on the line.
    expect(b.lines.map((l) => [l.key, l.qty, lineGross(l)])).toEqual([
      ['l1', 1, 0],
      ['l2', 1, 1_200],
      ['l2~v0', 1, 0],
    ]);
  });

  it('a second voucher takes what the first left, and removing the first prices the sale again', () => {
    const lines = [burger('l1', 2), cola('l2', 2)];
    const first = applied(meal(), lines, 12, 'r1');
    const second = applied(meal(), lines, 13, 'r2', [first]);
    // The second matched to the sale as it stands: the first's units taken.
    expect(second.units.map((u) => u.lineKey)).toEqual(['l1', 'l2']);
    expect(due(lines, [first, second])).toBe(0);
    // "הסר" of the first: the sale with the second alone.
    expect(due(lines, [second])).toBe(6_200);
  });

  it('cover: a payment voucher marks the part of a line it covers', () => {
    const lines = [burger('l1', 2), cola()];
    const b = bookProductionVouchers(lines, [applied(meal('payment'), lines)], totalOf);
    expect(b.lines.find((l) => l.key === 'l1')!.voucherMark).toBe('כלול בשובר #12 · שובר ארוחה (1)');
    expect(b.lines.find((l) => l.key === 'l2')!.voucherMark).toBe('כלול בשובר #12 · שובר ארוחה');
    // The units it took are no other voucher's.
    expect(coveredUnitCounts(b.redemptions)).toEqual(new Map([['l1', 1], ['l2', 1]]));
  });

  it('a payment leg is never more than is owed', () => {
    const lines = [burger(), cola()];
    const a = { ...applied(meal('payment'), lines), amountAgorot: 99_999 };
    expect(bookProductionVouchers(lines, [a], totalOf).legs[0].amountAgorot).toBe(6_200);
  });
});

/* -------------------------------------------------------------- the lookup */

describe("the lookup's voucher", () => {
  it('a plain list is redeemed at once; groups, a value, a policy are held', () => {
    const plain = { kind: 'items', selection: 'items', pricing: 'cover', tillValueAgorot: null, discountBlockPolicy: { mode: 'honour' }, items: [{ productId: 'P1', remaining: 2 }] };
    expect(isPlain(plain)).toBe(true);
    expect(isHeld(plain)).toBe(false);
    expect(isHeld({ ...plain, selection: 'groups', groups: [{ key: 'g' }] })).toBe(true);
    expect(isHeld({ ...plain, tillValueAgorot: 8_000 })).toBe(true);
    expect(isHeld({ ...plain, discountBlockPolicy: { mode: 'manager' } })).toBe(true);
    expect(isHeld({ ...plain, kind: 'order_discount' })).toBe(false);
  });

  it("its terms: the groups by the cloud's resolved products (lower case), a list voucher's items as groups", () => {
    const t = termsOf({
      selection: 'groups',
      typeName: 'שובר ארוחה',
      redemptionAccounting: 'discount',
      wholeAtOnce: true,
      totalMax: 2,
      totalRemaining: 2,
      groups: [{ key: 'food', name: 'מזון', minQty: 1, maxQty: 1, remaining: 1, productIds: ['ABC'], eligibleProductIds: ['abc', 'Till-1'], excludedIds: ['beer'] }],
    });
    expect(t.accounting).toBe('discount');
    expect(t.splitAllowed).toBe(false);
    expect([...t.groups[0].productIds].sort()).toEqual(['abc', 'till-1']);
    expect(t.groups[0].excludedIds.has('beer')).toBe(true);
    const list = termsOf({ splitAllowed: true, items: [{ productId: 'P1', tillProductId: 'T1', name: 'קולה', remaining: 2 }, { productId: 'P2', remaining: 0 }] });
    expect(list.listItems).toBe(true);
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0]).toMatchObject({ key: 'item:p1', minUnits: 0, maxUnits: 2 });
    // An older cloud's word: countsAsPayment false — ₪0 lines; nothing — the tender.
    expect(termsOf({ countsAsPayment: false }).accounting).toBe('zero');
    expect(termsOf({}).accounting).toBe('payment');
  });
});

/* ------------------------------------------------------------ "מצב בדיקה" */

describe('"מצב בדיקה"', () => {
  it('the end: what would have been covered and left to pay', () => {
    expect(voucherTestEndLines({ coveredAgorot: 6_200, items: 2, toPayAgorot: 1_500 })).toEqual([
      'בדיקה הושלמה — השובר תקין. לא מומש ולא נרשם דבר',
      'היו מכוסים בשובר: 2 פריטים · ₪62.00',
      'היה נותר לתשלום: ₪15.00',
    ]);
    expect(voucherTestEndLines({ coveredAgorot: 5_000, items: 1, toPayAgorot: 0 })).toEqual([VOUCHER_TEST_TEXT.done, 'היה מכוסה בשובר: פריט אחד · ₪50.00', 'לא היה נותר דבר לתשלום']);
    expect(voucherTestEndLines({ coveredAgorot: 3_000, items: 0, toPayAgorot: 100 })[1]).toBe('היה מכוסה בשובר: ₪30.00');
  });

  it('never a test voucher with a real one, nor with real money', () => {
    const real = { voucherId: 'a', testMode: false };
    const test = { voucherId: 'b', testMode: true };
    expect(voucherTestMixRefusal([real], test)).toBe('prepaid_voucher_test_mixed');
    expect(voucherTestMixRefusal([test], real)).toBe('prepaid_voucher_test_mixed');
    expect(voucherTestMixRefusal([], test, true)).toBe('prepaid_voucher_test_mixed');
    expect(voucherTestMixRefusal([test], { voucherId: 'c', testMode: true })).toBeNull();
    expect(voucherTestMoneyRefusal(true, true)).toBe('prepaid_voucher_test_mixed');
    expect(voucherTestMoneyRefusal(false, true)).toBeNull();
  });
});

/* ----------------------------------------------------------------- the close */

describe("closing while the customer is still entitled", () => {
  const now = new Date(2026, 9, 12, 18, 0);

  it('one sale - the one confirmation; in parts - what stays, with its validity', () => {
    const c = voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: false }], now)!;
    expect(c.confirm).toBe('סגירה עכשיו — מה שלא מומש מהשובר יאבד (משקה ×1)');
    expect(c.note).toBeNull();
    expect(c.notTaken).toBe('לא נלקח: משקה ×1\nמה שלא מומש מהשובר יאבד (משקה ×1)');
    const plain = voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: true }], now)!;
    expect(plain.confirm).toBeNull();
    expect(plain.note).toBe('מה שלא מומש יישאר בשובר (משקה ×1)');
    expect(voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: true, validUntil: '2026-10-31' }], now)!.note).toBe('מה שלא מומש יישאר בשובר (משקה ×1) · בתוקף עד 31.10.2026');
    expect(voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: true, validUntil: '2026-10-12T23:59:00' }], now)!.note).toBe('מה שלא מומש יישאר בשובר (משקה ×1) · בתוקף עד היום 23:59');
    expect(voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: true, validUntil: '2026-10-12' }], now)!.note).toBe('מה שלא מומש יישאר בשובר (משקה ×1) · בתוקף עד היום');
    expect(voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: true, dayLimitReached: true }], now)!.note).toBe('מה שלא מומש יישאר בשובר (משקה ×1) · ניתן לממש שוב מחר');
    // Its last day today: no "tomorrow" for it.
    expect(voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: true, validUntil: '2026-10-12T23:59:00', dayLimitReached: true }], now)!.note).toBe('מה שלא מומש יישאר בשובר (משקה ×1) · בתוקף עד היום 23:59');
    expect(voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: true, validUntil: 'soon' }], now)!.note).toBe('מה שלא מומש יישאר בשובר (משקה ×1)');
  });

  it('several vouchers of different rules - one confirmation, what is lost and what stays', () => {
    const c = voucherCloseMessages(
      [
        { list: 'משקה ×1', splitAllowed: false },
        { list: 'קינוח ×1', splitAllowed: true, validUntil: '2026-10-31' },
      ],
      now,
    )!;
    expect(c.confirm).toBe('סגירה עכשיו — מה שלא מומש מהשובר יאבד (משקה ×1)\nמה שלא מומש יישאר בשובר (קינוח ×1) · בתוקף עד 31.10.2026');
    expect(c.notTaken).toBe('לא נלקח: משקה ×1 · קינוח ×1\nמה שלא מומש מהשובר יאבד (משקה ×1)\nמה שלא מומש יישאר בשובר (קינוח ×1) · בתוקף עד 31.10.2026');
    expect(voucherCloseMessages([{ list: 'משקה ×1', splitAllowed: false }, { list: 'קינוח ×1', splitAllowed: false }], now)!.confirm).toBe('סגירה עכשיו — מה שלא מומש מהשוברים יאבד (משקה ×1 · קינוח ×1)');
    expect(voucherCloseMessages([], now)).toBeNull();
    expect(voucherDayLimitReached(2, 3)).toBe(true);
    expect(voucherDayLimitReached(null, 1)).toBe(true);
    expect(voucherDayLimitReached(1, 3)).toBe(false);
    expect(voucherDayLimitReached(5, null)).toBe(false);
  });
});

/* -------------------------------------------------------- scanned twice */

describe('a voucher scanned twice', () => {
  it('says what is known of it, never blocks', () => {
    expect(voucherRescanText(null)).toBe('השובר כבר נסרק בעסקה זו');
    expect(voucherRescanText({ serial: 12, covers: 'נקניקייה ×2, קולה', amountAgorot: 3_200 })).toBe('השובר כבר נסרק בעסקה זו (שובר #12 · נקניקייה ×2, קולה · ₪32.00)');
  });
});

/* ------------------------------------------------------------------ the X */

describe("the X's production vouchers", () => {
  it('a deduction is out of the gross and out of the discounts; a ₪0 voucher\'s goods are no items', () => {
    const doc = (over: Partial<XDoc>): XDoc => ({
      id: 'd',
      status: 'completed',
      documentType: 320,
      transactionNumber: 1,
      grossAgorot: 7_700,
      itemsQty: 3,
      documentDiscountAgorot: 6_200,
      payments: [{ method: 'cash', amountAgorot: 1_500 }],
      paymentMethod: 'cash',
      vatAgorot: 0,
      vatRate: 0,
      tipAgorot: 0,
      tipPaymentMethod: null,
      ...over,
    });
    const x = buildXTill([doc({ prepaidDeductionAgorot: 6_200 })], 0, 0).till;
    expect(x.totalSales).toBe(15);
    expect(x.totalDiscounts).toBe(0);
    expect(x.totalCash).toBe(15);
    const zero = buildXTill([doc({ grossAgorot: 1_500, documentDiscountAgorot: 0, offVoucherUnits: 2 })], 0, 0).till;
    expect(zero.itemsCount).toBe(1);
    const leg = buildXTill([doc({ documentDiscountAgorot: 0, payments: [{ method: 'production_voucher', amountAgorot: 6_200 }, { method: 'cash', amountAgorot: 1_500 }] })], 0, 0).till;
    expect(leg.totalVouchers).toBe(62);
    expect(leg.totalCash).toBe(15);
    expect(leg.expectedCash).toBe(15);
  });

  it('the sections: how many, the items, the deductions, by type and production; the ₪0 ones apart', () => {
    const red = (over: Record<string, unknown>) => ({
      redemptionId: 'r',
      reservationId: 'res',
      legacy: false,
      voucherId: 'v1',
      batchId: 'b',
      serial: 8,
      typeName: 'שובר ארוחה',
      batchName: null,
      productionName: 'קייטרינג אלון',
      accounting: 'discount' as const,
      pricing: 'cover' as const,
      amountAgorot: 4_000,
      topUpAgorot: 0,
      approval: null,
      units: [
        { lineKey: 'l1', productId: 'p', groupId: 'g', groupName: 'מנה', name: 'המבורגר', listValueAgorot: 5_000, salePriceAgorot: 5_000, coveredAgorot: 4_000 },
        { lineKey: 'l2', productId: 'q', groupId: 'h', groupName: 'משקה', name: 'קולה', listValueAgorot: 1_200, salePriceAgorot: 0, coveredAgorot: 0 },
      ],
      ...over,
    });
    const info = voucherInfoOf([[red({})], [red({ voucherId: 'v2', accounting: 'zero', amountAgorot: 0, typeName: 'שובר ישן' })]]);
    expect(info).toMatchObject({ redeemed: 1, redeemedItems: 2, deductionAgorot: 4_000, vouchers: 1, items: 2, valueAgorot: 6_200 });
    expect(voucherInfoLines(info).map((l) => `${l.label}=${l.value}`)).toEqual([
      'שוברי הפקה=',
      'שוברים=1',
      'פריטים=2',
      'קיזוזי שוברים=40.00',
      'לפי סוג שובר=',
      '  שובר ארוחה=1',
      'לפי הפקה=',
      '  קייטרינג אלון=1',
      'שוברי הפקה (לא כלול בסה״כ)=',
      'שוברים=1',
      'פריטים=2',
      'שווי=62.00',
      'שובר ישן=1 · 2 · 62.00',
    ]);
    // Read back from the close as it was kept; a Z's answer with fields missing is none of them.
    expect(voucherInfoFromJson(voucherInfoJson(info))).toEqual(info);
    expect(voucherInfoLines(voucherInfoFromJson({ redeemed: 2 }))[1]).toEqual({ label: 'שוברים', value: '2' });
  });
});

/* -------------------------------------------------------------- refunds */

describe('a voucher product on a refund', () => {
  it('is credited from its receipt only', () => {
    expect(voucherRefundRefusal({ name: 'שובר מתנה', voucherId: 'v-1' })).toBe('שובר מתנה הוא שובר. זיכוי שובר רק מקבלה.');
    expect(voucherRefundRefusal({ name: 'קולה', voucherId: null })).toBeNull();
    expect(voucherRefundRefusal({ name: 'קולה' })).toBeNull();
  });
});
