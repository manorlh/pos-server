/**
 * "עמדת שובר" (core/till/voucherStation.ts, main/till/tillVoucherStation.ts, screens/VoucherStationScreen.tsx) — the Android
 * till's VoucherStation*.kt and their tests (VoucherStationTest, VoucherStationBasketTest, VoucherStationPickerTest,
 * VoucherStationSaleTest, VoucherStationDiscountTest), ported: the settings and the home, "תנאי המימוש", the stacking, the smart
 * basket (each tap to a voucher while one takes it, else paid; the bar, the catalog, the rows, the one button), back to the
 * scan, a voucher taken off, discount vouchers — then the service over the real engine with a fake cloud: a voucher scanned,
 * picked and paid THROUGH the engine (sell.add → checkout.start → checkout.voucher, closed by itself), the basket's paid items,
 * a dead voucher in red, offline, "יציאה למסך רגיל" with a manager's code — and the screen's markup.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VOUCHER_STATION_TEXT as T,
  resolveVoucherAutoClose,
  resolveVoucherCatalogSwitch,
  resolveVoucherPayOptions,
  resolveVoucherStation,
  resolveVoucherStationPaidItems,
  stationAddHint,
  stationAutoAssign,
  stationBackPlan,
  stationBar,
  stationCatalog,
  stationEstimate,
  stationPaidButton,
  stationPickerBar,
  stationPrimary,
  stationPrimaryText,
  stationPrune,
  stationRefusedText,
  stationRows,
  stationSaleBanner,
  stationSaleButtons,
  stationSaleStrip,
  stationToggle,
  stationToPay,
  stationUnits,
  stationVoucherRemoval,
  voucherConditionsLines,
  voucherConditionsOf,
  voucherDiscountCardText,
  voucherDiscountHeader,
  voucherDiscountProducts,
  voucherDiscountRoute,
  voucherDiscountUnitCap,
  voucherDiscountUses,
  voucherStationBasketOn,
  voucherStationHome,
  voucherStationMayAddAnother,
  voucherStationMenuRow,
  voucherStationPaidItems,
  voucherStationRefusal,
  voucherStationTitleOf,
  type StationLine,
  type StationProduct,
  type StationVoucher,
  type VoucherStationState,
} from '../src/core/till/voucherStation';
import { termsOf, unitsRemaining, type VoucherGroupTerms, type VoucherTerms } from '../src/core/till/vouchers';
import { TillVoucherStation } from '../src/main/till/tillVoucherStation';
import { VoucherStationScreen } from '../src/renderer/roles/till/screens/VoucherStationScreen';
import type { TillOp } from '../src/shared/till/protocol';
import { MANAGER_PIN, PIN, harness, type Harness, type HarnessOptions } from './tillEngineHarness';

const op = (name: string) => name as TillOp;
const fmt = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);

/* ------------------------------------------------------------------ the pure rules */

const product = (id: string, priceAgorot: number): StationProduct => ({ id, name: id, priceAgorot, categoryId: 'c', available: true });
const burger = product('burger', 5_000);
const chips = product('chips', 1_500);
const cola = product('cola', 1_200);
const coffee = product('coffee', 1_200);
const cake = product('cake', 2_500);

function group(key: string, name: string, ids: string[], o: { min?: number; max?: number; remaining?: number; repeat?: boolean } = {}): VoucherGroupTerms {
  const max = o.max ?? 1;
  return { key, name, minUnits: o.min ?? 1, maxUnits: max, remaining: o.remaining ?? max, productIds: new Set(ids), excludedIds: new Set(), allowRepeat: o.repeat ?? true, item: false };
}

function terms(typeName: string, groups: VoucherGroupTerms[], o: { maxUnits?: number; left?: number; split?: boolean } = {}): VoucherTerms {
  return { typeName, pricing: 'cover', tillValue: null, accounting: 'discount', groups, maxUnits: o.maxUnits ?? null, unitsLeft: o.left ?? null, splitAllowed: o.split ?? false, includeExtras: false, listItems: false };
}

/** "שובר ארוחה": מנה + תוספת + משקה, all at once. */
const meal = terms('שובר ארוחה', [group('main', 'מנה', ['burger']), group('side', 'תוספת', ['chips']), group('drink', 'משקה', ['cola'])]);
/** "כרטיסיית קפה": 50 coffees, in parts. */
const punch = (left = 50, repeat = true) => terms('כרטיסיית קפה', [group('g', 'קפה', ['coffee'], { max: 50, remaining: left, repeat })], { maxUnits: 50, left, split: true });
/** "בחר 1 מתוך": one drink. */
const choice = terms('שובר שתייה', [group('pick', 'משקה', ['cola', 'juice'])]);

function voucher(id: string, t: VoucherTerms, o: { cap?: number; left?: number; serial?: number } = {}): StationVoucher {
  const left = o.left ?? unitsRemaining(t);
  return {
    voucherId: id,
    code: `CODE${id}`,
    serial: o.serial ?? 8,
    typeName: t.typeName,
    kind: 'items',
    terms: t,
    inSale: { voucherId: id, batchId: `b-${id}`, kind: 'items', stacking: 'unlimited' },
    cap: o.cap ?? left,
    left,
    parts: [],
    testMode: false,
    discount: null,
  };
}

/** A cart that taps add: the same product's line grows. */
class Cart {
  lines: StationLine[] = [];
  private n = 0;
  add(p: StationProduct): this {
    const same = this.lines.find((l) => l.productId === p.id);
    if (same) same.qty += 1;
    else {
      this.n += 1;
      this.lines.push({ lineId: `l${this.n}`, productId: p.id, name: p.name, qty: 1, unitAgorot: p.priceAgorot, refund: false });
    }
    return this;
  }
  snapshot(): StationLine[] {
    return this.lines.map((l) => ({ ...l }));
  }
}

const tap = (...ps: StationProduct[]) => ps.reduce((c, p) => c.add(p), new Cart());
const assign = (vs: StationVoucher[], cart: Cart) => stationAutoAssign(vs, {}, cart.snapshot());
const money = (a: number) => `₪${(a / 100).toFixed(2)}`;

describe('the station (VoucherStationTest)', () => {
  it('auto close is on and the station off unless the cloud says otherwise; the switch to the catalog; the title', () => {
    expect(resolveVoucherAutoClose({})).toBe(true);
    expect(resolveVoucherAutoClose({ voucherAutoClose: 'off' })).toBe(false);
    expect(resolveVoucherAutoClose({ voucherAutoClose: 'sometimes' })).toBe(true);
    expect(resolveVoucherStation({})).toBe(false);
    expect(resolveVoucherStation({ voucherStation: 'on' })).toBe(true);
    expect(resolveVoucherStation({ voucherStation: 'maybe' })).toBe(false);
    expect(resolveVoucherCatalogSwitch({})).toBe('manager');
    expect(resolveVoucherCatalogSwitch({ voucherStationCatalogSwitch: 'free' })).toBe('free');
    expect(resolveVoucherCatalogSwitch({ voucherStationCatalogSwitch: 'off' })).toBe('off');
    expect(voucherStationTitleOf(null)).toBe('עמדת מימוש שוברים');
    expect(voucherStationTitleOf('  עמדת   שוברים  ')).toBe('עמדת שוברים');
    // The menu's row: the way out (unless off), and back whenever it was left.
    expect(voucherStationMenuRow({ station: true, left: false, catalogSwitch: 'manager' })).toEqual({ label: 'יציאה למסך רגיל' });
    expect(voucherStationMenuRow({ station: true, left: true, catalogSwitch: 'off' })).toEqual({ label: 'חזרה לעמדת שובר' });
    expect(voucherStationMenuRow({ station: true, left: false, catalogSwitch: 'off' })).toBeNull();
    expect(voucherStationMenuRow({ station: false, left: false, catalogSwitch: 'free' })).toBeNull();
  });

  it("the station's home offers the scan and the typing as their switches say", () => {
    expect(voucherStationHome({ scan: true, manual: true })).toEqual({ scan: true, manual: true, nothing: false });
    expect(voucherStationHome({ scan: true, manual: false }).manual).toBe(false);
    expect(voucherStationHome({ scan: false, manual: false }).nothing).toBe(true);
    expect(resolveVoucherPayOptions({})).toEqual({ scan: true, manual: true });
    expect(resolveVoucherPayOptions({ payVoucherManualEnabled: 'false' })).toEqual({ scan: true, manual: false });
  });

  it('a station takes a second voucher when the stacking allows it, and says why not when it does not', () => {
    const held = (id: string, batch: string, stacking: 'single' | 'distinct_batches' | 'unlimited', max: number | null = null) => ({ voucherId: id, batchId: batch, kind: 'items' as const, stacking, maxPerSale: max });
    const a = held('A', 'B1', 'unlimited');
    expect(voucherStationMayAddAnother([a])).toBe(true);
    expect(voucherStationRefusal([a], held('A2', 'B1', 'unlimited'))).toBeNull();
    expect(voucherStationRefusal([a], held('C', 'B2', 'unlimited'))).toBeNull();
    expect(voucherStationMayAddAnother([held('S', 'B1', 'single')])).toBe(false);
    expect(voucherStationRefusal([held('S', 'B1', 'single')])).toBe('ניתן לממש שובר אחד בלבד בעסקה');
    expect(voucherStationRefusal([a], held('S', 'B2', 'single'))).toBe('ניתן לממש שובר אחד בלבד בעסקה');
    expect(voucherStationRefusal([held('D', 'B1', 'distinct_batches')], held('D2', 'B1', 'distinct_batches'))).toBe('בעסקה כבר יש שובר מאותה סדרה, והסדרה אינה מאפשרת שילוב — ממשו אותו בעסקה נפרדת');
    const two = [held('M1', 'B1', 'unlimited', 2), held('M2', 'B2', 'unlimited', 3)];
    expect(voucherStationMayAddAnother(two)).toBe(false);
    expect(voucherStationRefusal(two)).toBe('הגעת למספר השוברים המקסימלי בעסקה (2)');
    expect(voucherStationMayAddAnother(two.slice(0, 1))).toBe(true);
    // The same voucher again is not another.
    expect(voucherStationRefusal([held('S', 'B1', 'single')], held('S', 'B1', 'single'))).toBeNull();
  });

  it("the conditions panel reads the lookup's answer and hides what it does not say", () => {
    const mealDto = {
      id: 'v',
      validFrom: '2026-10-11T00:00:00Z',
      validUntil: '2026-10-12T23:59:00Z',
      selection: 'groups',
      groups: [
        { key: 'main', name: 'מנה', minQty: 1, maxQty: 1 },
        { key: 'drink', name: 'משקה', minQty: 1, maxQty: 1 },
      ],
      totalMax: 2,
      totalRemaining: 2,
      wholeAtOnce: true,
      includeExtras: false,
      stacking: 'unlimited',
      maxVouchersPerSale: 2,
      maxUnitsPerSale: 1,
      validShops: ['סניף מרכז', { name: 'סניף צפון' }],
      tillValueAgorot: 8000,
      pricing: 'fixed',
    };
    const c = voucherConditionsOf(mealDto, termsOf(mealDto));
    expect(voucherConditionsLines(c, true, fmt)).toEqual([
      'תוקף: מ־2026-10-11 עד 2026-10-12',
      'מכסה 2 | מומשו 0 | נותרו 2',
      'עד פריט אחד בעסקה',
      'מנה 1 + משקה 1',
      'מימוש בעסקה אחת — מה שלא ימומש עכשיו יאבד',
      'תוספות בתשלום אינן כלולות',
      'שילוב שוברים: עד 2 שוברים בעסקה',
      'תקף בסניפים: סניף מרכז, סניף צפון',
      'שווי קבוע ₪80',
    ]);
    expect(voucherConditionsLines(c, false, fmt).some((l) => l.includes('₪'))).toBe(false);
    const listDto = { id: 'v', splitAllowed: true, includeExtras: true, stacking: 'single', items: [{ productId: 'p', name: 'נקניקייה', quantity: 2, remaining: 1 }] };
    expect(voucherConditionsLines(voucherConditionsOf(listDto, termsOf(listDto)), true, fmt)).toEqual(['נקניקייה 1', 'מימוש בחלקים — היתרה נשמרת בשובר', 'כולל תוספות', 'שילוב שוברים: שובר אחד בעסקה']);
  });
});

describe('the smart basket (VoucherStationBasketTest)', () => {
  it('the setting is off unless the cloud says on, and needs a cash or card way to pay', () => {
    expect(resolveVoucherStationPaidItems({})).toBe(false);
    expect(resolveVoucherStationPaidItems({ voucherStationPaidItems: 'off' })).toBe(false);
    expect(resolveVoucherStationPaidItems({ voucherStationPaidItems: 'maybe' })).toBe(false);
    expect(resolveVoucherStationPaidItems({ voucherStationPaidItems: 'on' })).toBe(true);
    expect(resolveVoucherStationPaidItems({ voucherStationPaidItems: 'true' })).toBe(true);
    expect(voucherStationBasketOn(true, false, true)).toBe(false);
    expect(voucherStationBasketOn(true, true, false)).toBe(false);
    expect(voucherStationBasketOn(true, true, true)).toBe(true);
    expect(voucherStationBasketOn(false, true, true)).toBe(false);
  });

  it('a meal - each tap fills its group, a second burger and a cake are paid, and the bar says so', () => {
    const cart = new Cart();
    let vouchers = [voucher('m', meal)];
    let seen: Record<string, number> = {};
    const add = (p: StationProduct) => {
      cart.add(p);
      const lines = cart.snapshot();
      const r = stationAutoAssign(stationPrune(vouchers, lines), seen, lines);
      vouchers = r.vouchers;
      seen = r.seen;
      return r.last!;
    };
    expect(add(burger).outcome).toBe('covered');
    let bar = stationBar(vouchers, 0);
    expect(bar.usage).toEqual(['בשובר: 1 מתוך 3']);
    expect(bar.missing).toBe('חסר תוספת ומשקה להשלמת שובר ארוחה');
    expect(bar.full).toBe(false);
    const catalog = stationCatalog([cake, burger, chips, cola], vouchers, cart.snapshot());
    expect(catalog.map((i) => i.product.id)).toEqual(['chips', 'cola', 'cake', 'burger']);
    expect(catalog.map((i) => i.tag)).toEqual(['completes', 'completes', 'paid', 'paid']);
    expect(add(cola).outcome).toBe('covered');
    // A second burger: the "מנה" group is full — paid, and said beside it by its group.
    const second = add(burger);
    expect(second.outcome).toBe('group_full');
    expect(stationAddHint(second.outcome, 5_000, second.group)).toBe(`הקבוצה "מנה" בשובר מלאה — נוסף בתשלום ${money(5_000)}`);
    expect(add(chips).outcome).toBe('covered');
    expect(add(cake).outcome).toBe('not_eligible');
    expect(stationAddHint('not_eligible', 2_500)).toBe(`לא כלול בשובר — בתשלום ${money(2_500)}`);
    expect(stationAddHint('covered', 2_500)).toBeNull();
    bar = stationBar(vouchers, 7_500);
    expect(bar.usage).toEqual(['בשובר: 3 מתוך 3']);
    expect(bar.full).toBe(true);
    expect(bar.fullText).toBe(T.full);
    expect(bar.missing).toBeNull();
    expect(bar.paid).toBe(`בתשלום: ${money(7_500)}`);
    const rows = stationRows(cart.snapshot(), vouchers);
    const burgerRows = rows.filter((r) => r.name === 'burger');
    expect(burgerRows.map((r) => [r.covered, r.quantity])).toEqual([
      [true, 1],
      [false, 1],
    ]);
    expect(burgerRows[1].amountAgorot).toBe(5_000);
    expect(rows.filter((r) => r.name === 'cake').map((r) => r.covered)).toEqual([false]);
  });

  it('a punch card - the bar counts the uses, and a moved unit is never taken back by itself', () => {
    const cart = tap(coffee, coffee);
    let r = assign([voucher('p', punch(), { cap: 50, left: 50 })], cart);
    expect(stationBar(r.vouchers, 0).usage).toEqual(['מומשו 2 · נותרו 48']);
    const line = cart.lines[0].lineId;
    const moved = stationToggle(r.vouchers, line, false, cart.snapshot());
    expect(moved.outcome).toBe('paid');
    expect(stationUnits(moved.vouchers[0])).toBe(1);
    cart.add(coffee);
    r = stationAutoAssign(stationPrune(moved.vouchers, cart.snapshot()), r.seen, cart.snapshot());
    expect(stationUnits(r.vouchers[0])).toBe(2);
    expect(stationRows(cart.snapshot(), r.vouchers).map((x) => [x.covered, x.quantity])).toEqual([
      [true, 2],
      [false, 1],
    ]);
    const back = stationToggle(r.vouchers, line, true, cart.snapshot());
    expect(back.outcome).toBe('covered');
    expect(stationUnits(back.vouchers[0])).toBe(3);
  });

  it('the toggle respects the rules - no room, a product once, a per-sale limit', () => {
    const cart = tap(coffee, coffee, coffee);
    const r = assign([voucher('p', punch(2), { cap: 2, left: 2 })], cart);
    expect(stationUnits(r.vouchers[0])).toBe(2);
    expect(r.last!.outcome).toBe('no_room');
    const refused = stationToggle(r.vouchers, cart.lines[0].lineId, true, cart.snapshot());
    expect(refused.outcome).toBe('no_room');
    expect(refused.vouchers).toEqual(r.vouchers);
    expect(stationBar(r.vouchers, 1_200).fullText).toBe(T.full);
    expect(stationUnits(assign([voucher('o', punch(50, false))], tap(coffee, coffee)).vouchers[0])).toBe(1);
    const perSale = assign([voucher('s', punch(10), { cap: 2, left: 10 })], cart);
    expect(stationBar(perSale.vouchers, 1_200).fullText).toBe(T.fullPerSale);
  });

  it('two vouchers - each unit to the first that takes it, in the order scanned', () => {
    const r = assign([voucher('a', punch(1), { cap: 1, left: 1, serial: 8 }), voucher('b', punch(5), { cap: 5, left: 5, serial: 9 })], tap(coffee, coffee, coffee));
    expect(r.vouchers.map(stationUnits)).toEqual([1, 2]);
    expect(stationBar(r.vouchers, 0).usage).toEqual(['שובר מס׳ 0008: מומשו 1 · נותרו 0', 'שובר מס׳ 0009: מומשו 2 · נותרו 3']);
    expect(stationBar(r.vouchers, 0).full).toBe(false);
  });

  it('covered and paid apart, what is left to pay, and the primary button', () => {
    const cart = tap(coffee, coffee, cake);
    const lines = cart.snapshot();
    const r = assign([voucher('p', punch(), { cap: 50, left: 50 })], cart);
    const toPay = stationToPay(4_900, r.vouchers.map((v) => stationEstimate(v, lines).effectAgorot));
    expect(toPay).toBe(2_500);
    const pay = stationPrimary(lines.length, 2, r.vouchers.map((v) => stationEstimate(v, lines).refusal), toPay);
    expect(pay).toEqual({ kind: 'pay', amountAgorot: 2_500 });
    expect(stationPrimaryText(pay)).toBe(`לתשלום ${money(2_500)}`);
    const coffees = tap(coffee, coffee);
    const all = assign([voucher('p', punch(), { cap: 50, left: 50 })], coffees).vouchers;
    const close = stationPrimary(1, 2, [null], stationToPay(2_400, all.map((v) => stationEstimate(v, coffees.snapshot()).effectAgorot)));
    expect(close).toEqual({ kind: 'close_all' });
    expect(stationPrimaryText(close)).toBe('סגור — הכל בשובר');
    expect(stationPrimaryText(stationPrimary(1, 2, [null], 0, false))).toBe('סגור עסקה וממש שובר');
    expect(stationPrimary(0, 0, [], 0)).toEqual({ kind: 'empty' });
    const half = tap(burger);
    const m = assign([voucher('m', meal)], half).vouchers;
    const est = m.map((v) => stationEstimate(v, half.snapshot()));
    expect(stationPrimary(1, 1, est.map((e) => e.refusal), stationToPay(5_000, est.map((e) => e.effectAgorot)))).toEqual({ kind: 'blocked', why: 'חסר תוספת להשלמת שובר ארוחה' });
  });

  it("a cancelled sale takes the paid lines and the voucher's units with it", () => {
    const cart = tap(coffee, coffee, cake);
    const r = assign([voucher('p', punch(), { cap: 50, left: 50 })], cart);
    expect(stationUnits(r.vouchers[0])).toBe(2);
    const pruned = stationPrune(r.vouchers, []);
    expect(stationUnits(pruned[0])).toBe(0);
    expect(stationRows([], pruned)).toEqual([]);
    expect(stationPrune(r.vouchers, cart.snapshot().filter((l) => l.productId !== 'coffee')).map(stationUnits)).toEqual([0]);
  });
});

describe('the picker and the sale (VoucherStationPickerTest, VoucherStationSaleTest)', () => {
  it('"הוסף פריט בתשלום": on, or off with why — never a button that does nothing', () => {
    expect(stationPaidButton(voucherStationPaidItems(false, true))).toEqual({ enabled: false, why: "רכישה בתשלום כבויה בעמדה (פרמטר 'רכישה נוספת בתשלום בעמדת שובר')", text: 'הוסף פריט בתשלום' });
    expect(stationPaidButton(voucherStationPaidItems(true, false)).why).toBe('אין אמצעי תשלום בקופה — הגדירו מזומן או אשראי');
    expect(stationPaidButton(voucherStationPaidItems(true, true))).toEqual({ enabled: true, why: null, text: 'הוסף פריט בתשלום' });
    expect(stationPaidButton(voucherStationPaidItems(true, true, true)).why).toBe('לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו');
  });

  it('the sale so far, and the bar once it has voucher items', () => {
    const a = 'שובר מס׳ 0008';
    const b = 'שובר מס׳ 0012';
    expect(stationSaleStrip([a, b], 3)).toBe(`בעסקה: ${a} · ${b} · 3 פריטים`);
    expect(stationSaleStrip([a], 1)).toBe(`בעסקה: ${a} · פריט אחד`);
    expect(stationSaleStrip([], 2)).toBe('בעסקה: 2 פריטים');
    expect(stationSaleStrip([a], 0)).toBe(`בעסקה: ${a}`);
    expect(stationSaleStrip([], 0)).toBeNull();
    expect(stationPickerBar(0, 0)).toBeNull();
    const all = stationPickerBar(3, 0)!;
    expect(all.text).toBe('בשובר: 3 פריטים');
    expect(all.button).toBe('סגור — הכל בשובר');
    expect(stationPickerBar(1, 0)!.text).toBe('בשובר: פריט אחד');
    expect(stationPickerBar(1, 1_200)!.button).toBe(`לתשלום ${money(1_200)}`);
  });

  it('the banner - the voucher, its items, and what to do', () => {
    const r = assign([voucher('m', meal)], tap(burger, chips));
    const banner = stationSaleBanner(r.vouchers, stationBar(r.vouchers, 0));
    expect(banner.title).toBe('שובר מס׳ 0008 · 2 פריטים בשובר · הוסיפו פריטים בתשלום');
    expect(banner.tone).toBe('missing');
    expect(banner.status).toBe('חסר משקה להשלמת שובר ארוחה');
    const one = assign([voucher('c', choice)], tap(cola)).vouchers;
    const full = stationSaleBanner(one, stationBar(one, 0));
    expect(full.title).toBe('שובר מס׳ 0008 · פריט אחד בשובר · הוסיפו פריטים בתשלום');
    expect(full.tone).toBe('full');
    expect(full.status).toBe(T.full);
    const both = assign([voucher('c', choice, { serial: 8 }), voucher('p', punch(), { cap: 50, left: 50, serial: 12 })], tap(cola, coffee, coffee)).vouchers;
    expect(stationSaleBanner(both, stationBar(both, 0)).title).toBe('2 שוברים · 3 פריטים בשובר · הוסיפו פריטים בתשלום');
    expect(stationSaleBanner([], stationBar([], 0)).title).toBe(T.noVoucher);
    const orange = stationSaleBanner(one, { usage: [], full: false, fullText: null, missing: null, paid: null, alert: 'זכאי', closeConfirm: null, closeNote: 'נשאר' });
    expect([orange.tone, orange.status, orange.note]).toEqual(['alert', 'זכאי', 'נשאר']);
  });

  it('the bar - the big button, another voucher while the stacking allows it', () => {
    const pay = stationSaleButtons({ kind: 'pay', amountAgorot: 2_500 }, true, true, true);
    expect(pay).toEqual({ text: `לתשלום ${money(2_500)}`, enabled: true, green: false, scanAnother: true, typeCode: true });
    const close = stationSaleButtons({ kind: 'close_all' }, true, false, false);
    expect(close).toEqual({ text: 'סגור — הכל בשובר', enabled: true, green: true, scanAnother: false, typeCode: false });
    const empty = stationSaleButtons({ kind: 'empty' }, true, true, true);
    expect([empty.enabled, empty.text]).toEqual([false, T.empty]);
    const blocked = stationSaleButtons({ kind: 'blocked', why: 'חסר משקה להשלמת שובר ארוחה' }, true, true, true);
    expect([blocked.enabled, blocked.text]).toEqual([false, 'חסר משקה להשלמת שובר ארוחה']);
    expect(stationSaleButtons({ kind: 'pay', amountAgorot: 100 }, false, true, true).scanAnother).toBe(false);
  });

  it("back drops the paid items - asked - and keeps the voucher's", () => {
    const cart = tap(burger, burger, chips, cola, cake);
    const r = assign([voucher('m', meal)], cart);
    const plan = stationBackPlan(cart.snapshot(), r.vouchers);
    expect(plan.asks).toBe(true);
    const burgerLine = cart.lines.find((l) => l.productId === 'burger')!.lineId;
    const cakeLine = cart.lines.find((l) => l.productId === 'cake')!.lineId;
    expect(plan.cuts).toEqual({ [burgerLine]: 1, [cakeLine]: 0 });
    expect(plan.text).toBe('הפריטים בתשלום יוסרו מהעסקה: burger ×1, cake ×1. הפריטים שבשובר נשארים בעסקה.');
    const after = cart
      .snapshot()
      .map((l) => (plan.cuts[l.lineId] === undefined ? l : { ...l, qty: plan.cuts[l.lineId] }))
      .filter((l) => l.qty > 0);
    expect(stationUnits(stationPrune(r.vouchers, after)[0])).toBe(3);
    expect(stationBackPlan(after, r.vouchers)).toEqual({ cuts: {}, text: null, asks: false });
  });

  it('a voucher taken off - its items stay paid, or go with it', () => {
    const cart = tap(coffee, coffee, coffee);
    const r = assign([voucher('a', punch(1), { cap: 1, left: 1, serial: 8 }), voucher('b', punch(1), { cap: 1, left: 1, serial: 9 })], cart);
    const removal = stationVoucherRemoval(cart.snapshot(), r.vouchers, 'a')!;
    expect(removal.hasItems).toBe(true);
    expect(removal.title).toBe('להסיר את שובר מס׳ 0008 מהעסקה?');
    expect(removal.text).toBe('בשובר: coffee ×1 — להשאיר את הפריטים בעסקה בתשלום, או להסיר אותם?');
    expect(removal.cuts).toEqual({ [cart.lines[0].lineId]: 2 });
    const empty = stationVoucherRemoval(cart.snapshot(), [voucher('e', choice)], 'e')!;
    expect(empty.hasItems).toBe(false);
    expect(empty.text).toBe(T.removeEmpty);
    expect(empty.cuts).toEqual({});
    expect(stationVoucherRemoval(cart.snapshot(), r.vouchers, 'nope')).toBeNull();
  });

  it("another voucher refused by the sale's stacking is said in red", () => {
    expect(stationRefusedText('ניתן לממש שובר אחד בלבד בעסקה')).toBe('השובר לא נוסף לעסקה — ניתן לממש שובר אחד בלבד בעסקה');
  });
});

describe('discount vouchers at the station (VoucherStationDiscountTest)', () => {
  it('where a scan goes, the uses, the units, the words', () => {
    expect(voucherDiscountRoute('items', false, false)).toBe('goods');
    expect(voucherDiscountRoute('order_discount', true, false)).toBe('till_discount');
    expect(voucherDiscountRoute('item_discount', false, false)).toBe('item_discount_picker');
    expect(voucherDiscountRoute('order_discount', false, true)).toBe('order_discount_basket');
    expect(voucherDiscountRoute('order_discount', false, false)).toBe('order_discount_refused');
    expect(voucherDiscountUses(null, null, null)).toBe(1);
    expect(voucherDiscountUses(2, 5, null)).toBe(2);
    expect(voucherDiscountUses(3, 0, null)).toBe(0);
    expect(voucherDiscountUnitCap({ maxUnits: 2 }, 3)).toBe(6);
    expect(voucherDiscountUnitCap({ maxUnits: null }, 0)).toBe(0);
    const pct = { discountType: 'percent' as const, value: 10_000, text: null };
    expect(voucherDiscountHeader(pct, 1, 0)).toBe('הנחה 100% · שימוש אחד · נבחרו 0');
    expect(voucherDiscountHeader({ discountType: 'percent', value: 1_250 }, 3, 2)).toBe('הנחה 12.5% · 3 שימושים · נבחרו 2');
    expect(voucherDiscountCardText(pct, 1, ['פיצה', 'פופקורן', 'פיצה', 'שתייה', 'גלידה'])).toBe('100% הנחה על: פיצה, פופקורן, שתייה… · שימוש אחד');
    expect(voucherDiscountCardText({ discountType: 'fixed', value: 1_000, text: '₪10 הנחה' }, 2, [])).toBe('₪10 הנחה · 2 שימושים');
    const products = [product('pizza', 3_000), { ...product('popcorn', 1_500), categoryId: 'snacks' }, cola];
    expect(voucherDiscountProducts({ kind: 'item_discount', productIds: ['PIZZA'], categoryIds: ['snacks'] }, products).map((p) => p.id)).toEqual(['pizza', 'popcorn']);
    expect(voucherDiscountProducts({ kind: 'order_discount', productIds: ['pizza'], categoryIds: [] }, products)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the service */

const CODE = 'ABCD-EFGH-2345-6789';
const P = 'POST sync/m/prepaid-vouchers';

/** "פריט אחד מכל קבוצה": food (the burger) and drink (the cola) — the payment's own test voucher. */
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

/** The cloud's hold of the units sent, priced by cover (production_voucher_reserve.value_units). */
const holdOf = (body: Record<string, unknown> | null) => {
  const units = (body!.units as Array<Record<string, unknown>>).map((u) => ({
    ref: u.ref,
    productId: u.productId,
    productName: u.productName,
    groupKey: u.groupKey ?? null,
    quantity: 1,
    valueAgorot: u.listPriceAgorot,
    coveredAgorot: u.listPriceAgorot,
    listValueAgorot: u.listValueAgorot,
    forced: false,
    reductionAgorot: 0,
  }));
  return {
    ok: true,
    reservationId: 'res-g',
    status: 'held',
    redemptionAccounting: 'discount',
    pricing: 'cover',
    units,
    coveredAgorot: units.reduce((s, u) => s + (u.coveredAgorot as number), 0),
    topUpAgorot: 0,
    tender: null,
    deduction: { kind: 'production_voucher' },
    serial: 8,
    typeName: 'שובר ארוחה',
    productionName: 'קייטרינג אלון',
    needsApproval: false,
  };
};

async function until<T>(fn: () => T | null | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The engine's cart and payment as the station reads them (what the engine's own `sale` dep gives). */
function saleOf(hh: Harness) {
  const e = hh.engine as unknown as {
    cart: Array<{ lineId: string; productId: string; qty: number; refund?: boolean }>;
    checkout: { phase: string; totalAgorot: number; legs: Array<{ amountAgorot: number; status: string }> };
    basketId: string;
  };
  return () => ({
    ref: e.basketId,
    lines: e.cart.map((l) => ({ lineId: l.lineId, productId: l.productId, qty: l.qty, refund: l.refund === true })),
    phase: e.checkout.phase,
    dueAgorot: e.checkout.phase === 'tender' ? Math.max(0, e.checkout.totalAgorot - e.checkout.legs.filter((x) => x.status === 'approved').reduce((s, x) => s + x.amountAgorot, 0)) : 0,
  });
}

let h: Harness | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});

async function station(answers: HarnessOptions['answers'], parameters: Record<string, unknown> = {}, login = PIN) {
  h = harness({ answers: { [`${P}/reservations/*`]: () => ({ ok: true }), ...answers }, parameters: { voucherStation: 'on', ...parameters } });
  const hh = h;
  const f = hh.engine.register(new TillVoucherStation(hh.engine.ctx, { sale: saleOf(hh), scanDone: () => hh.engine.vouchers.lastScan, format: fmt }));
  await hh.ok('session.login', { pin: login });
  await hh.ok('shift.open', { openingCashAgorot: 20_000 });
  const view = () => (hh.state() as unknown as { voucherStation?: VoucherStationState }).voucherStation;
  return { hh, f, view };
}

describe('the station over the engine', () => {
  it('off: nothing; on: the sell screen is the station — "סרקו שובר", the menu\'s way out', async () => {
    h = harness({ parameters: {} });
    const hh = h;
    hh.engine.register(new TillVoucherStation(hh.engine.ctx, { sale: saleOf(hh), scanDone: () => null }));
    await hh.ok('session.login', { pin: PIN });
    expect((hh.state() as unknown as { voucherStation?: unknown }).voucherStation).toBeUndefined();
    hh.stop();
    const { view } = await station({});
    const v = view()!;
    expect(v.active).toBe(true);
    expect(v.menu).toEqual({ label: 'יציאה למסך רגיל' });
    expect(v.phase).toBe('home');
    expect(v.header).toBe('עמדת מימוש שוברים');
    expect(v.home.scanText).toBe('סרקו שובר');
    expect(v.home.strip).toBeNull();
  });

  it('a voucher scanned: its picker with "תנאי המימוש"; picked, added — then paid THROUGH the engine and closed by itself', async () => {
    const { hh, f, view } = await station({ [`${P}/lookup`]: () => groupsDto(), [`${P}/reserve`]: holdOf });
    await hh.ok(op('voucherStation.scan'), { code: `PV:${CODE}`, typed: false });
    expect(view()!.phase).toBe('checking');
    await f.last;
    const v = view()!;
    expect(v.phase).toBe('picker');
    const p = v.picker!;
    expect(p.title).toBe('שובר מס׳ 8');
    expect(p.typeName).toBe('שובר ארוחה');
    expect(p.production).toBe('הפקה: קייטרינג אלון');
    expect(p.conditions).toContain('מכסה 2 | מומשו 0 | נותרו 2');
    expect(p.conditions).toContain('מימוש בחלקים — היתרה נשמרת בשובר');
    expect(p.groups.map((g) => g.counter)).toEqual(['מזון: 0 מתוך 1', 'שתייה: 0 מתוך 1']);
    expect(p.groups[0].items.map((i) => i.name)).toEqual(['המבורגר']);
    expect(p.groups[1].items.map((i) => i.name)).toEqual(['קולה']);
    expect(p.paidButton.enabled).toBe(false);
    expect(p.canAdd).toBe(false);
    await hh.ok(op('voucherStation.pick'), { productId: 'p-burger', groupKey: 'food', delta: 1 });
    // The group takes one: a second is refused with why.
    expect((await hh.fail(op('voucherStation.pick'), { productId: 'p-burger', groupKey: 'food', delta: 1 })).message).toBe('כבר נבחר פריט מקבוצה זו');
    await hh.ok(op('voucherStation.pick'), { productId: 'p-cola', groupKey: 'drink', delta: 1 });
    expect(view()!.picker!.selected).toBe(2);
    expect(view()!.picker!.bar).toEqual({ text: 'בשובר: 2 פריטים', button: 'סגור — הכל בשובר', green: true });
    // Nothing went to the cloud but the lookup; nothing in the cart yet.
    expect(hh.sent.filter((c) => c.path.includes('prepaid-vouchers')).map((c) => c.path)).toEqual(['sync/m/prepaid-vouchers/lookup']);
    expect(hh.state().sell.lines).toEqual([]);
    await hh.ok(op('voucherStation.commit'));
    expect(view()!.phase).toBe('home');
    expect(hh.state().sell.lines.map((l) => [l.productId, l.qty])).toEqual([
      ['p-burger', 1],
      ['p-cola', 1],
    ]);
    expect(view()!.home.strip).toBe('בעסקה: שובר מס׳ 0008 · 2 פריטים');
    expect(view()!.home.finish).toBe(true);
    expect(view()!.home.vouchers).toEqual([{ voucherId: 'v-g', title: 'שובר מס׳ 0008', covers: 'המבורגר ×1 · קולה ×1' }]);
    // "סיום וסגירת העסקה": the engine's payment, the voucher by its own flow, closed by itself (voucherAutoClose).
    await hh.ok(op('voucherStation.pay'));
    await until(() => hh.state().checkout.phase === 'done');
    await f.last;
    const doc = hh.svc.ledger.doc(hh.state().checkout.documentId!)!;
    expect(doc.totals.totalAgorot).toBe(0);
    expect(hh.sent.filter((c) => c.path.includes('prepaid-vouchers/reserve'))).toHaveLength(1);
    await hh.ok('checkout.finish');
    // A new order: the station at home again, nothing in its sale.
    expect(view()!.phase).toBe('home');
    expect(view()!.home.strip).toBeNull();
  });

  it('the smart basket: each tap to the voucher while it takes it, else paid; the row moves; the payment takes the rest', async () => {
    const { hh, f, view } = await station({ [`${P}/lookup`]: () => groupsDto(), [`${P}/reserve`]: holdOf }, { voucherStationPaidItems: 'on' });
    await hh.ok(op('voucherStation.scan'), { code: CODE, typed: true });
    await f.last;
    expect(view()!.picker!.paidButton).toEqual({ enabled: true, why: null, text: 'הוסף פריט בתשלום' });
    await hh.ok(op('voucherStation.basket'));
    let b = view()!.basket!;
    expect(view()!.phase).toBe('basket');
    expect(b.banner.title).toBe('שובר מס׳ 0008 · 0 פריטים בשובר · הוסיפו פריטים בתשלום');
    expect(b.items.slice(0, 2).map((i) => [i.productId, i.tagText])).toEqual([
      ['p-burger', 'בשובר'],
      ['p-cola', 'בשובר'],
    ]);
    await hh.ok(op('voucherStation.add'), { productId: 'p-burger' });
    expect(view()!.basket!.hint).toEqual({ text: 'נוסף בשובר מס׳ 0008', covered: true });
    await hh.ok(op('voucherStation.add'), { productId: 'p-burger' });
    expect(view()!.basket!.hint).toEqual({ text: `הקבוצה "מזון" בשובר מלאה — נוסף בתשלום ${money(4_200)}`, covered: false });
    await hh.ok(op('voucherStation.add'), { productId: 'p-cola' });
    b = view()!.basket!;
    expect(b.rows.map((r) => [r.name, r.quantity, r.tagText])).toEqual([
      ['המבורגר', 1, 'בשובר'],
      ['המבורגר', 1, 'בתשלום'],
      ['קולה', 1, 'בשובר'],
    ]);
    expect(b.banner.tone).toBe('full');
    expect(b.primary).toEqual({ text: `לתשלום ${money(4_200)}`, enabled: true, green: false });
    expect(b.totals).toEqual({ order: money(9_650), vouchers: money(5_450), toPay: money(4_200) });
    // The cola moved to "בתשלום", and back.
    const colaLine = hh.state().sell.lines.find((l) => l.productId === 'p-cola')!.lineId;
    await hh.ok(op('voucherStation.toggle'), { lineId: colaLine, toVoucher: false });
    expect(view()!.basket!.totals.toPay).toBe(money(5_450));
    await hh.ok(op('voucherStation.toggle'), { lineId: colaLine, toVoucher: true });
    expect(view()!.basket!.totals.toPay).toBe(money(4_200));
    // The burger's paid unit cannot move to the voucher: its group is full.
    const burgerLine = hh.state().sell.lines.find((l) => l.productId === 'p-burger')!.lineId;
    expect((await hh.fail(op('voucherStation.toggle'), { lineId: burgerLine, toVoucher: true })).message).toBe(`הקבוצה "מזון" בשובר מלאה — נוסף בתשלום ${money(4_200)}`);
    await hh.ok(op('voucherStation.pay'));
    await until(() => (hh.state().checkout.vouchers?.items.length ?? 0) > 0 && !hh.state().checkout.vouchers!.busy);
    await f.last;
    expect(hh.state().checkout.phase).toBe('tender');
    expect(hh.state().checkout.dueAgorot).toBe(4_200);
    await hh.ok('checkout.cash', { amountAgorot: 4_200 });
    expect(hh.state().checkout.phase).toBe('done');
  });

  it('a dead voucher in red (Android\'s words, the cloud\'s details under them); dismissed; offline said', async () => {
    let up = true;
    const { hh, f, view } = await station({
      [`${P}/lookup`]: () => {
        if (!up) throw new Error('down');
        return groupsDto({ redeemable: false, reason: 'prepaid_voucher_used', message: 'מומש בקופה 3' });
      },
    });
    await hh.ok(op('voucherStation.scan'), { code: CODE, typed: true });
    await f.last;
    expect(view()!.phase).toBe('refused');
    expect(view()!.notice).toEqual({ text: 'השובר כבר מומש במלואו — אין יתרה', detail: 'מומש בקופה 3', tone: 'red' });
    await hh.ok(op('voucherStation.dismiss'));
    expect(view()!.phase).toBe('home');
    up = false;
    await hh.ok(op('voucherStation.scan'), { code: CODE, typed: true });
    await f.last;
    expect(view()!.notice!.text).toBe('אין חיבור לענן — השובר לא נבדק ולא מומש, כי מימוש נבדק בענן בלבד. בדקו את החיבור ונסו שוב.');
    // Not a voucher: a product's barcode, a short code.
    await hh.ok(op('voucherStation.scan'), { code: '7290000000011', typed: false });
    expect(view()!.notice!.text).toBe('זה ברקוד של מוצר, לא של שובר. סרקו את הברקוד שעל השובר.');
    await hh.ok(op('voucherStation.scan'), { code: 'ABC', typed: true });
    expect(view()!.notice!.text).toBe('הקוד אינו תקין — 16 תווים, כפי שמודפס על השובר.');
  });

  it('an order discount with an empty order: said; a test voucher: the orange bar, no paid items', async () => {
    let dto: Record<string, unknown> = { id: 'v-d', voucherId: 'v-d', batchId: 'b-d', serial: 7, kind: 'order_discount', stacking: 'unlimited', redeemable: true, usesAvailable: 1, benefit: { kind: 'order_discount', discountType: 'fixed', value: 1_000, text: '₪10 הנחה' } };
    const { hh, f, view } = await station({ [`${P}/lookup`]: () => dto }, { voucherStationPaidItems: 'on' });
    // With the basket on: the basket, to add paid items first.
    await hh.ok(op('voucherStation.scan'), { code: CODE, typed: true });
    await f.last;
    expect(view()!.phase).toBe('basket');
    expect(view()!.basket!.refused).toBe('שובר הנחה על כל ההזמנה — הוסיפו פריטים בתשלום וסרקו את השובר שוב');
    await hh.ok(op('voucherStation.back'));
    dto = groupsDto({ testMode: true });
    await hh.ok(op('voucherStation.scan'), { code: CODE, typed: true });
    await f.last;
    expect(view()!.testBar).toBe('מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם');
    expect(view()!.picker!.paidButton.enabled).toBe(false);
    expect(view()!.picker!.paidButton.why).toBe('לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו');
    expect((await hh.fail(op('voucherStation.basket'))).message).toBe('לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו');
  });

  it('"יציאה למסך רגיל": a manager\'s code (KIOSK_TILL_MODE) for a cashier, free when the cloud says so, "חזרה לעמדת שובר"', async () => {
    const { hh, view } = await station({});
    const r = await hh.ok<{ dialogId: string }>(op('voucherStation.leave'));
    expect(hh.state().dialog).toMatchObject({ kind: 'manager_approval', body: 'יציאה מעמדת שובר למסך רגיל — נדרש קוד מנהל' });
    await hh.ok('dialog.answer', { dialogId: r.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(view()!.active).toBe(false);
    expect(view()!.menu).toEqual({ label: 'חזרה לעמדת שובר' });
    await hh.ok(op('voucherStation.return'));
    expect(view()!.active).toBe(true);
    hh.svc.cloud.setParameters({ voucherStation: 'on', voucherStationCatalogSwitch: 'free' }, null);
    await hh.ok(op('voucherStation.leave'));
    expect(view()!.active).toBe(false);
    hh.svc.cloud.setParameters({ voucherStation: 'on', voucherStationCatalogSwitch: 'off' }, null);
    await hh.ok(op('voucherStation.return'));
    expect(view()!.menu).toBeNull();
    expect((await hh.fail(op('voucherStation.leave'))).code).toBe('invalid_args');
  });
});

/* ------------------------------------------------------------------ the screen */

const noop = () => undefined;
const actions = {
  scan: noop,
  dismiss: noop,
  pick: noop,
  commit: noop,
  closePicker: noop,
  basket: noop,
  add: noop,
  toggle: noop,
  category: noop,
  backToScan: noop,
  removeVoucher: noop,
  pay: noop,
  payOpen: noop,
  clear: noop,
};

const base = (over: Partial<VoucherStationState> = {}): VoucherStationState => ({
  active: true,
  menu: { label: 'יציאה למסך רגיל' },
  phase: 'home',
  header: 'עמדת מימוש שוברים',
  home: { scan: true, manual: true, nothing: null, scanText: 'סרקו שובר', hint: 'הסורק פעיל תמיד', strip: null, vouchers: [], finish: false, openOrder: null, basket: false },
  notice: null,
  picker: null,
  basket: null,
  testBar: null,
  busy: false,
  ...over,
});

describe('the screen', () => {
  it('home, an open order, the sale so far; checking; a refusal', () => {
    const home = renderToStaticMarkup(createElement(VoucherStationScreen, { view: base(), actions, back: noop }));
    for (const w of ['עמדת מימוש שוברים', 'סרקו שובר', 'הסורק פעיל תמיד', 'קוד השובר', 'בדוק שובר']) expect(home).toContain(w);
    const sale = renderToStaticMarkup(
      createElement(VoucherStationScreen, {
        view: base({ home: { ...base().home, scanText: 'סרקו שובר נוסף', strip: 'בעסקה: שובר מס׳ 0008 · 2 פריטים', vouchers: [{ voucherId: 'v', title: 'שובר מס׳ 0008', covers: 'המבורגר ×1' }], finish: true, basket: true } }),
        actions,
        back: noop,
      }),
    );
    for (const w of ['בעסקה: שובר מס׳ 0008 · 2 פריטים', 'סיום וסגירת העסקה', 'הסר שובר', 'הוסף פריט בתשלום', 'סרקו שובר נוסף']) expect(sale).toContain(w);
    const open = renderToStaticMarkup(createElement(VoucherStationScreen, { view: base({ home: { ...base().home, openOrder: 'הזמנה פתוחה: קולה ×1' } }), actions, back: noop }));
    for (const w of ['הזמנה פתוחה: קולה ×1', 'המשך לתשלום', 'ביטול ההזמנה']) expect(open).toContain(w);
    expect(renderToStaticMarkup(createElement(VoucherStationScreen, { view: base({ phase: 'checking' }), actions, back: noop }))).toContain('בודק…');
    const red = renderToStaticMarkup(createElement(VoucherStationScreen, { view: base({ phase: 'refused', notice: { text: 'השובר כבר מומש במלואו — אין יתרה', detail: 'מומש בקופה 3', tone: 'red' } }), actions, back: noop }));
    for (const w of ['השובר כבר מומש במלואו — אין יתרה', 'מומש בקופה 3', 'סרקו את השובר הבא']) expect(red).toContain(w);
  });

  it('the picker and the basket', () => {
    const picker = renderToStaticMarkup(
      createElement(VoucherStationScreen, {
        view: base({
          phase: 'picker',
          testBar: 'מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם',
          picker: {
            voucherId: 'v',
            title: 'שובר מס׳ 8',
            typeName: 'שובר ארוחה',
            event: 'פסטיבל',
            production: 'הפקה: קייטרינג אלון',
            validUntil: null,
            testBar: 'מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם',
            conditions: ['מכסה 2 | מומשו 0 | נותרו 2'],
            discount: null,
            groups: [{ key: 'food', counter: 'מזון: 1 מתוך 1', full: true, items: [{ productId: 'p', groupKey: 'food', name: 'המבורגר', price: '₪42.00', tag: null, tagText: null, count: 1, why: 'כבר נבחר פריט מקבוצה זו', available: true }] }],
            limitNote: 'אפשר לבחור עוד פריט אחד',
            selected: 1,
            refusal: null,
            entitlement: null,
            canAdd: true,
            paidButton: { enabled: false, why: 'לא ניתן לשלב שובר בבדיקה עם מכירה אמיתית — סיימו את הבדיקה או בטלו', text: 'הוסף פריט בתשלום' },
            scanAnother: true,
            bar: { text: 'בשובר: פריט אחד', button: 'סגור — הכל בשובר', green: true },
            more: 0,
          },
        }),
        actions,
        back: noop,
      }),
    );
    for (const w of ['תנאי המימוש', 'מזון: 1 מתוך 1', 'המבורגר', 'כבר נבחר פריט מקבוצה זו', 'הוסף למימוש', 'הוסף פריט בתשלום', 'בשובר: פריט אחד', 'סגור — הכל בשובר', 'מצב בדיקה', 'vst-green']) expect(picker).toContain(w);
    const basket = renderToStaticMarkup(
      createElement(VoucherStationScreen, {
        view: base({
          phase: 'basket',
          basket: {
            banner: { title: 'שובר מס׳ 0008 · 2 פריטים בשובר · הוסיפו פריטים בתשלום', status: 'השובר מומש במלואו — כל פריט נוסף בתשלום', note: null, tone: 'full' },
            bar: { usage: ['בשובר: 2 מתוך 2'], full: true, fullText: null, missing: null, paid: null, alert: null, closeConfirm: null, closeNote: null },
            categories: [{ id: null, name: 'הכל', on: true }],
            items: [{ productId: 'p-cake', groupKey: null, name: 'עוגה', price: '₪25.00', tag: 'paid', tagText: 'בתשלום ₪25.00', count: 0, why: null, available: true }],
            more: 0,
            rows: [{ lineId: 'l1', name: 'המבורגר', quantity: 1, covered: true, amountAgorot: 4_200, amount: '₪42.00', tagText: 'בשובר', mayMove: true }],
            hint: { text: 'נוסף בשובר מס׳ 0008', covered: true },
            refused: null,
            totals: { order: '₪42.00', vouchers: '₪42.00', toPay: '₪0.00' },
            primary: { text: 'סגור — הכל בשובר', enabled: true, green: true },
            scanAnother: true,
            typeCode: true,
            vouchers: [],
          },
        }),
        actions,
        back: noop,
      }),
    );
    for (const w of ['vst-banner-full', 'השובר מומש במלואו', 'בתשלום ₪25.00', 'חזרה לסריקה', 'סה״כ הזמנה', 'נוסף בשובר מס׳ 0008', 'הכל']) expect(basket).toContain(w);
  });
});
