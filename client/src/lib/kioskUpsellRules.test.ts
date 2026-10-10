/**
 * Run with `npm test`. The kiosk's upsell rules (lib/kioskUpsellRules.ts — the Android kiosk's
 * MenuCodec upsells + kioskUpsells, UpsellRule.isActiveAt, UpsellMatch, UpsellChoices, UpsellPrompts)
 * and the customer's details (lib/kioskCustomer.ts — KioskCustomer.phoneValid / nameValid).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { kioskBasketUpsells, kioskUpsellOffer, upsellActiveAt, upsellChoices, upsellMayOffer, upsellRulesOf, upsellTriggers, type UpsellProduct } from './kioskUpsellRules';
import { nameValid, phoneValid } from './kioskCustomer';
import { menuGroupIdsFor, menuGroupOf, menuNotesFor, parentOfCategories } from './kioskMoney';
import { kioskOfflineBlocks, tsKioskPayMethods, voucherCanFinish } from './kioskConfig';

const catalog: UpsellProduct[] = [
  { id: 'burger', categoryId: 'burgers', soldOut: false },
  { id: 'fries', categoryId: 'sides', soldOut: false },
  { id: 'rings', categoryId: 'sides', soldOut: true },
  { id: 'salad', categoryId: 'greens', soldOut: false },
  { id: 'cola', categoryId: 'drinks', soldOut: false },
  { id: 'water', categoryId: 'drinks', soldOut: false },
  { id: 'cake', categoryId: 'desserts', soldOut: false },
];

const menu = {
  upsells: [
    { id: 'u-sides', name: 'תוספת', triggerType: 'product', triggerIds: ['burger'], action: 'add', productId: null, options: [{ type: 'category', id: 'sides', categoryIds: ['greens'] }], places: ['quick', 'kiosk'], priority: 1 },
    { id: 'u-drink', name: 'שתייה', triggerType: 'category', triggerIds: ['burgers'], action: 'add', productId: 'cola', options: [], where: 'both', priority: 5 },
    { id: 'u-tables', name: 'שולחנות בלבד', triggerType: 'product', triggerIds: ['burger'], action: 'add', productId: 'cake', options: [], places: ['tables'], priority: 9 },
    { id: 'u-old-quick', name: 'ישן', triggerType: 'product', triggerIds: ['burger'], action: 'add', productId: 'water', options: [], where: 'quick' },
    { id: 'u-meal', name: 'ארוחה', triggerType: 'product', triggerIds: ['burger'], action: 'upgrade', productId: 'meal', options: [] },
    { name: 'no id', triggerType: 'product', triggerIds: ['burger'], productId: 'cola' },
  ],
  kioskUpsells: [
    { id: 'k-dessert', name: 'קינוח', triggerType: 'order', triggerIds: [], action: 'add', productId: null, options: [{ type: 'product', id: 'cake' }], places: ['kiosk'], priority: 0 },
    { id: 'k-night', name: 'לילה', triggerType: 'transition', triggerIds: ['to_cart'], action: 'add', productId: null, options: [{ type: 'product', id: 'water' }], startTime: '22:00', endTime: '02:00', weekdays: [4], places: ['kiosk'], priority: 0 },
  ],
};

describe('the kiosk upsell rules (the Android kiosk’s)', () => {
  const rules = upsellRulesOf(menu);
  const rule = (id: string) => rules.find((r) => r.id === id)!;

  it('reads both lists; a rule with no id, or naming nothing, is left out; kiosk-only rules are the kiosk’s alone', () => {
    assert.deepEqual(rules.map((r) => r.id), ['u-sides', 'u-drink', 'u-tables', 'u-old-quick', 'u-meal', 'k-dessert', 'k-night']);
    assert.deepEqual(rule('k-dessert').places, ['kiosk']);
    assert.deepEqual(rule('u-drink').places, ['quick', 'tables', 'kiosk']);
    assert.deepEqual(rule('u-old-quick').places, ['quick', 'kiosk']);
    assert.deepEqual(rule('u-tables').places, ['tables']);
    assert.deepEqual(rule('u-sides').choices, [{ type: 'category', id: 'sides', categoryIds: ['greens', 'sides'] }]);
  });

  it('triggers: a product, a category, never on another channel; every order at to_pay; a step it names', () => {
    const burger = { kind: 'line', productId: 'burger', categoryId: 'burgers' } as const;
    assert.equal(upsellTriggers(rule('u-sides'), burger), true);
    assert.equal(upsellTriggers(rule('u-drink'), burger), true);
    assert.equal(upsellTriggers(rule('u-tables'), burger), false);
    assert.equal(upsellTriggers(rule('k-dessert'), burger), false);
    assert.equal(upsellTriggers(rule('k-dessert'), { kind: 'step', code: 'to_pay' }), true);
    assert.equal(upsellTriggers(rule('k-dessert'), { kind: 'step', code: 'to_cart' }), false);
    assert.equal(upsellTriggers(rule('k-night'), { kind: 'step', code: 'to_cart' }), true);
  });

  it('days and hours: the hours after midnight belong to the evening that began the day before', () => {
    const night = rule('k-night');
    assert.equal(upsellActiveAt(night, { weekday: 4, minute: 23 * 60 }), true);
    assert.equal(upsellActiveAt(night, { weekday: 5, minute: 60 }), true);
    assert.equal(upsellActiveAt(night, { weekday: 5, minute: 23 * 60 }), false);
    assert.equal(upsellActiveAt(night, { weekday: 4, minute: 12 * 60 }), false);
    // An equal start and end is no window at all (LocalTime start <= end, time >= start && time < end).
    assert.equal(upsellActiveAt({ startTime: '10:00', endTime: '10:00', weekdays: [] }, { weekday: 1, minute: 600 }), false);
  });

  it('choices: a category with its sub-categories in the catalog’s order, never sold out, never excluded', () => {
    assert.deepEqual(upsellChoices(rule('u-sides'), catalog, new Set()), ['fries', 'salad']);
    assert.deepEqual(upsellChoices(rule('u-sides'), catalog, new Set(['fries'])), ['salad']);
  });

  it('the offer for a line: the highest priority first, never what the order holds', () => {
    const offer = kioskUpsellOffer({ rules, moment: { kind: 'line', productId: 'burger', categoryId: 'burgers' }, now: { weekday: 2, minute: 720 }, inCart: new Set(['burger']), catalog, asked: new Set(), maxShown: 0 });
    assert.equal(offer?.rule.id, 'u-drink');
    const held = kioskUpsellOffer({ rules, moment: { kind: 'line', productId: 'burger', categoryId: 'burgers' }, now: { weekday: 2, minute: 720 }, inCart: new Set(['burger', 'cola']), catalog, asked: new Set(), maxShown: 0 });
    assert.equal(held?.rule.id, 'u-sides');
  });

  it('the cap: no more rules in an order than upsell.maxShown (0: none)', () => {
    assert.equal(upsellMayOffer(2, 2), false);
    assert.equal(upsellMayOffer(1, 2), true);
    assert.equal(upsellMayOffer(9, 0), true);
  });

  it('the basket strip: the lines’ rules, then every order’s; each product once', () => {
    const offers = kioskBasketUpsells({ rules, lines: [{ productId: 'burger', categoryId: 'burgers' }], now: { weekday: 2, minute: 720 }, catalog, maxShown: 0, limit: 4 });
    assert.deepEqual(offers.map((o) => o.rule.id), ['u-drink', 'k-dessert']);
    assert.deepEqual(offers.flatMap((o) => o.productIds), ['cola', 'cake']);
    const capped = kioskBasketUpsells({ rules, lines: [{ productId: 'burger', categoryId: 'burgers' }], now: { weekday: 2, minute: 720 }, catalog, maxShown: 1, limit: 4 });
    assert.deepEqual(capped.map((o) => o.rule.id), ['u-drink']);
    assert.deepEqual(kioskBasketUpsells({ rules, lines: [], now: { weekday: 2, minute: 720 }, catalog, maxShown: 0, limit: 4 }), []);
  });
});

describe('the customer’s details (KioskCustomer)', () => {
  it('a phone: 0 and 9–10 digits, or +972 and 11–12', () => {
    for (const ok of ['0501234567', '050-123-4567', '031234567', '+972501234567', '+972 3 123 4567']) assert.equal(phoneValid(ok), true, ok);
    for (const bad of ['501234567', '05012345678', '+97250', '+1 202 555 0100', '']) assert.equal(phoneValid(bad), false, bad);
  });
  it('a name: 1–30 characters once trimmed', () => {
    assert.equal(nameValid('  '), false);
    assert.equal(nameValid('רן'), true);
    assert.equal(nameValid('א'.repeat(30)), true);
    assert.equal(nameValid('א'.repeat(31)), false);
  });
});

describe('the menu as the Android till reads it (Menu.groupsFor / notesFor, MenuCodec)', () => {
  const parentOf = parentOfCategories([{ id: 'drinks' }, { id: 'craft', parentId: 'drinks' }, { id: 'hot', parentId: 'drinks' }, { id: 'loop', parentId: 'loop' }]);
  const links = { products: { cola: ['g-size'], tea: [] }, categories: { drinks: ['g-lemon'], hot: [] } };
  it('groups: the product’s own list, [] is none, else the nearest category up the tree', () => {
    assert.deepEqual(menuGroupIdsFor(links, ['cola'], 'drinks', parentOf), ['g-size']);
    assert.deepEqual(menuGroupIdsFor(links, ['tea'], 'hot', parentOf), []);
    assert.deepEqual(menuGroupIdsFor(links, ['ipa'], 'craft', parentOf), ['g-lemon']);
    assert.deepEqual(menuGroupIdsFor(links, ['latte'], 'hot', parentOf), []);
    assert.deepEqual(menuGroupIdsFor(links, ['x'], 'loop', parentOf), []);
  });
  it('notes: its own, else the nearest category’s; then the shop’s, each once', () => {
    const notes = { all: [{ text: 'בלי מלח' }, { text: 'חם' }], categories: { drinks: [{ text: 'בלי קרח' }, { text: 'חם' }] }, products: { cola: [{ text: 'עם לימון' }] } };
    assert.deepEqual(menuNotesFor(notes, ['cola'], 'drinks', parentOf), ['עם לימון', 'בלי מלח', 'חם']);
    assert.deepEqual(menuNotesFor(notes, ['ipa'], 'craft', parentOf), ['בלי קרח', 'חם', 'בלי מלח']);
    assert.deepEqual(menuNotesFor(notes, ['bread'], null, parentOf), ['בלי מלח', 'חם']);
  });
  it('a group with no maximum takes any number, whatever its kind (MenuCodec; the cloud’s validate_picks)', () => {
    assert.equal(menuGroupOf({ id: 'g', kind: 'choice', minSelect: 1, maxSelect: null, options: [] })?.maxSelect, null);
    assert.equal(menuGroupOf({ id: 'g', kind: 'choice', maxSelect: 1, options: [{ id: 'o', price: 1, maxQty: 0.5 }] })?.options[0].maxQty, null);
    assert.equal(menuGroupOf({ id: '', kind: 'addon' }), null);
  });
});

describe('a voucher only where its order can be finished (no dead end on the TS kiosks)', () => {
  it('with the till to pay at, the voucher stays; with the card and vouchers alone it is not offered', () => {
    assert.deepEqual(tsKioskPayMethods(['card', 'voucher', 'cash_at_till']), ['card', 'voucher', 'cash_at_till']);
    assert.deepEqual(tsKioskPayMethods(['card', 'voucher']), ['card']);
    assert.deepEqual(tsKioskPayMethods(['voucher', 'cash_at_till']), ['voucher', 'cash_at_till']);
    assert.deepEqual(tsKioskPayMethods(['card', 'split_card', 'voucher', 'cash_at_till']), ['card', 'voucher', 'cash_at_till']);
    assert.equal(voucherCanFinish(['card', 'voucher']), false);
  });
});

describe('"חסימת הזמנות כשאין אינטרנט" (KioskPayBlock.OFFLINE)', () => {
  it('offline with it on: no orders; off, or online: never', () => {
    assert.equal(kioskOfflineBlocks({ blockWhenOffline: true }, true), true);
    assert.equal(kioskOfflineBlocks({ blockWhenOffline: true }, false), false);
    assert.equal(kioskOfflineBlocks({ blockWhenOffline: false }, true), false);
    assert.equal(kioskOfflineBlocks(null, true), false);
  });
});
