/**
 * Run with `npm test`. "הגדלות מכירה" (lib/upsellFilters.ts): the rules list's filters and
 * their URL query, a rule's places, and the "מעבר בין מסכים" steps of the chosen places.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_UPSELL_FILTER,
  filterUpsells,
  groupStepCodes,
  isEmptyUpsellFilter,
  joinStepCodes,
  normalizeSearch,
  parseUpsellFilter,
  placesOf,
  serializeUpsellFilter,
  splitStepCodes,
  stepOrder,
  stepPlaces,
  validSteps,
  withUpsellFilter,
  type FilterableUpsell,
  type UpsellFilter,
  type UpsellSteps,
} from './upsellFilters';

/** The server's steps today (GET /menu/upsells → steps). */
const STEPS: UpsellSteps = {
  quick: ['order_start', 'enter_category', 'to_pay'],
  tables: ['table_open', 'enter_category', 'before_send', 'bill_request', 'to_pay'],
  kiosk: ['order_start', 'to_catalog', 'enter_category', 'to_cart', 'to_pay'],
};

interface Rule extends FilterableUpsell {
  id: string;
}

function rule(id: string, over: Partial<Rule> = {}): Rule {
  return {
    id,
    name: id,
    triggerType: 'product',
    triggerNames: [],
    options: [],
    productName: null,
    places: ['quick', 'tables', 'kiosk'],
    isActive: true,
    ...over,
  };
}

const ids = (rules: Rule[]) => rules.map((r) => r.id);
const f = (over: Partial<UpsellFilter>): UpsellFilter => ({ ...EMPTY_UPSELL_FILTER, ...over });

describe('the filters in the URL query', () => {
  it('parses the example and writes it back the same', () => {
    const query = `place=quick,kiosk&trigger=transition&active=1&q=${encodeURIComponent('קפה')}`;
    const parsed = parseUpsellFilter(new URLSearchParams(query));
    assert.deepEqual(parsed, { places: ['quick', 'kiosk'], triggers: ['transition'], activeOnly: true, q: 'קפה' });
    assert.equal(serializeUpsellFilter(parsed), query);
    assert.deepEqual(parseUpsellFilter(serializeUpsellFilter(parsed)), parsed);
    assert.deepEqual(parseUpsellFilter(`?${query}`), parsed);
  });

  it('round-trips every filter, and no filter is an empty query', () => {
    const all: UpsellFilter[] = [
      EMPTY_UPSELL_FILTER,
      f({ places: ['tables'] }),
      f({ triggers: ['product', 'category', 'transition', 'order'] }),
      f({ activeOnly: true }),
      f({ q: 'צ׳יפס & קולה' }),
      f({ places: ['quick', 'tables', 'kiosk'], triggers: ['order'], activeOnly: true, q: 'a+b, c' }),
    ];
    for (const x of all) assert.deepEqual(parseUpsellFilter(serializeUpsellFilter(x)), x);
    assert.equal(serializeUpsellFilter(EMPTY_UPSELL_FILTER), '');
    assert.equal(isEmptyUpsellFilter(EMPTY_UPSELL_FILTER), true);
    assert.equal(isEmptyUpsellFilter(f({ q: '  ' })), true);
    assert.equal(isEmptyUpsellFilter(f({ activeOnly: true })), false);
  });

  it('writes a stable order and leaves the defaults out', () => {
    assert.equal(serializeUpsellFilter(f({ places: ['kiosk', 'quick'], triggers: ['order', 'product'] })), 'place=quick,kiosk&trigger=product,order');
    assert.equal(serializeUpsellFilter(f({ activeOnly: false, q: '   ' })), '');
    assert.equal(serializeUpsellFilter(f({ q: '  קפה  ' })), `q=${encodeURIComponent('קפה')}`);
  });

  it('drops unknown and repeated values, and reads active=true', () => {
    assert.deepEqual(parseUpsellFilter('place=kiosk,mars,kiosk, quick&trigger=nope&active=true'), {
      places: ['quick', 'kiosk'],
      triggers: [],
      activeOnly: true,
      q: '',
    });
    assert.deepEqual(parseUpsellFilter('active=0&place='), EMPTY_UPSELL_FILTER);
    assert.deepEqual(parseUpsellFilter(''), EMPTY_UPSELL_FILTER);
  });

  it('keeps the other keys of the page (the scope) when the filters change', () => {
    const next = withUpsellFilter('?shop=s1&place=tables&q=old', f({ places: ['kiosk'], activeOnly: true }));
    const params = new URLSearchParams(next);
    assert.equal(params.get('shop'), 's1');
    assert.equal(params.get('place'), 'kiosk');
    assert.equal(params.get('active'), '1');
    assert.equal(params.get('q'), null);
    assert.equal(withUpsellFilter('place=tables', EMPTY_UPSELL_FILTER), '');
    assert.equal(withUpsellFilter('shop=s1', EMPTY_UPSELL_FILTER), 'shop=s1');
  });
});

describe('a rule\'s places', () => {
  it('reads places, in the canonical order', () => {
    assert.deepEqual(placesOf({ places: ['kiosk', 'quick'] }), ['quick', 'kiosk']);
  });
  it('reads the legacy where of an older server (the kiosk was reached by quick and both)', () => {
    assert.deepEqual(placesOf({ where: 'both' }), ['quick', 'tables', 'kiosk']);
    assert.deepEqual(placesOf({ where: 'quick' }), ['quick', 'kiosk']);
    assert.deepEqual(placesOf({ where: 'tables' }), ['tables']);
    assert.deepEqual(placesOf({ where: null }), ['kiosk']);
    assert.deepEqual(placesOf({}), ['quick', 'tables', 'kiosk']);
    assert.deepEqual(placesOf({ places: [], where: 'tables' }), ['tables']);
  });
});

describe('filterUpsells', () => {
  const rules: Rule[] = [
    rule('quick-only', { places: ['quick'] }),
    rule('tables-only', { places: ['tables'] }),
    rule('kiosk-only', { places: ['kiosk'] }),
    rule('quick-tables', { places: ['quick', 'tables'] }),
  ];

  it('no filter: every rule', () => {
    assert.deepEqual(ids(filterUpsells(rules, EMPTY_UPSELL_FILTER)), ids(rules));
  });

  it('places: a rule matches when any of its places is chosen', () => {
    assert.deepEqual(ids(filterUpsells(rules, f({ places: ['quick'] }))), ['quick-only', 'quick-tables']);
    assert.deepEqual(ids(filterUpsells(rules, f({ places: ['kiosk'] }))), ['kiosk-only']);
    assert.deepEqual(ids(filterUpsells(rules, f({ places: ['tables', 'kiosk'] }))), ['tables-only', 'kiosk-only', 'quick-tables']);
    assert.deepEqual(ids(filterUpsells(rules, f({ places: ['quick', 'tables', 'kiosk'] }))), ids(rules));
    // An older server's where.
    assert.deepEqual(ids(filterUpsells([rule('legacy', { places: undefined, where: 'quick' })], f({ places: ['kiosk'] }))), ['legacy']);
  });

  it('each trigger type, and several at once', () => {
    const byType: Rule[] = [
      rule('p', { triggerType: 'product' }),
      rule('c', { triggerType: 'category' }),
      rule('t', { triggerType: 'transition' }),
      rule('o', { triggerType: 'order' }),
    ];
    assert.deepEqual(ids(filterUpsells(byType, f({ triggers: ['product'] }))), ['p']);
    assert.deepEqual(ids(filterUpsells(byType, f({ triggers: ['category'] }))), ['c']);
    assert.deepEqual(ids(filterUpsells(byType, f({ triggers: ['transition'] }))), ['t']);
    assert.deepEqual(ids(filterUpsells(byType, f({ triggers: ['order'] }))), ['o']);
    assert.deepEqual(ids(filterUpsells(byType, f({ triggers: ['order', 'product'] }))), ['p', 'o']);
  });

  it('active only', () => {
    const mixed = [rule('on'), rule('off', { isActive: false })];
    assert.deepEqual(ids(filterUpsells(mixed, f({ activeOnly: true }))), ['on']);
    assert.deepEqual(ids(filterUpsells(mixed, f({ activeOnly: false }))), ['on', 'off']);
  });

  it('search: by rule name, trigger name, option name and the one product', () => {
    const items: Rule[] = [
      rule('a', { name: 'שתייה ליד נקניקיה', triggerNames: ['נקניקיה'], options: [{ name: 'קולה' }, { name: 'ספרייט' }] }),
      rule('b', { name: 'להפוך לארוחה', triggerNames: ['המבורגר', null], options: [{ name: 'ארוחת המבורגר' }] }),
      rule('c', { name: 'Coffee upsell', triggerNames: ['Espresso'], options: [{ name: null }], productName: 'Croissant' }),
    ];
    const search = (q: string) => ids(filterUpsells(items, f({ q })));
    assert.deepEqual(search('ליד'), ['a']); // rule name
    assert.deepEqual(search('נקניק'), ['a']); // trigger name (and name)
    assert.deepEqual(search('ספרייט'), ['a']); // option name
    assert.deepEqual(search('המבורגר'), ['b']);
    assert.deepEqual(search('croissant'), ['c']); // the one product
    assert.deepEqual(search('ESPRESSO'), ['c']); // case-insensitive
    assert.deepEqual(search('coffee'), ['c']);
    assert.deepEqual(search('פיצה'), []);
    // Every word, each anywhere in the rule.
    assert.deepEqual(search('נקניקיה קולה'), ['a']);
    assert.deepEqual(search('נקניקיה המבורגר'), []);
  });

  it('search is Hebrew-safe: points, geresh and curly quotes', () => {
    const items: Rule[] = [rule('fries', { name: 'צ׳יפס ליד המבורגר' }), rule('coffee', { name: 'קפה הפוך' })];
    const search = (q: string) => ids(filterUpsells(items, f({ q })));
    assert.deepEqual(search("צ'יפס"), ['fries']);
    assert.deepEqual(search('צ’יפס'), ['fries']);
    assert.deepEqual(search('קָפֶה'), ['coffee']);
    assert.deepEqual(search('  קפה   הפוך '), ['coffee']);
    assert.equal(normalizeSearch('צ׳יפס'), normalizeSearch("צ'יפס"));
    assert.equal(normalizeSearch('ש״ח'), 'ש"ח');
  });

  it('combines the filters', () => {
    const items: Rule[] = [
      rule('x', { places: ['kiosk'], triggerType: 'transition', name: 'קפה בקיוסק' }),
      rule('y', { places: ['kiosk'], triggerType: 'transition', name: 'קפה כבוי', isActive: false }),
      rule('z', { places: ['quick'], triggerType: 'transition', name: 'קפה מהיר' }),
    ];
    assert.deepEqual(ids(filterUpsells(items, parseUpsellFilter(`place=quick,kiosk&trigger=transition&active=1&q=${encodeURIComponent('קפה')}`))), ['x', 'z']);
    assert.deepEqual(ids(filterUpsells(items, f({ places: ['kiosk'], activeOnly: true, q: 'קפה' }))), ['x']);
  });
});

describe('"מעבר בין מסכים": the steps of the chosen places', () => {
  it('merges the channels into one order that keeps each channel\'s own', () => {
    const order = stepOrder(STEPS);
    assert.deepEqual(order, ['order_start', 'to_catalog', 'table_open', 'enter_category', 'to_cart', 'before_send', 'bill_request', 'to_pay']);
    for (const list of Object.values(STEPS)) {
      const positions = list!.map((c) => order.indexOf(c));
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    }
  });

  it('the union of the chosen places, each once', () => {
    assert.deepEqual(validSteps(STEPS, ['quick']), ['order_start', 'enter_category', 'to_pay']);
    assert.deepEqual(validSteps(STEPS, ['tables']), ['table_open', 'enter_category', 'before_send', 'bill_request', 'to_pay']);
    assert.deepEqual(validSteps(STEPS, ['kiosk']), ['order_start', 'to_catalog', 'enter_category', 'to_cart', 'to_pay']);
    assert.deepEqual(validSteps(STEPS, ['quick', 'tables']), ['order_start', 'table_open', 'enter_category', 'before_send', 'bill_request', 'to_pay']);
    assert.deepEqual(validSteps(STEPS, ['quick', 'tables', 'kiosk']), stepOrder(STEPS));
    assert.deepEqual(validSteps(STEPS, []), []);
  });

  it('a stable order: the same whatever the order or subset of places', () => {
    const full = stepOrder(STEPS);
    assert.deepEqual(validSteps(STEPS, ['kiosk', 'tables']), validSteps(STEPS, ['tables', 'kiosk']));
    for (const places of [['quick'], ['tables', 'kiosk'], ['kiosk', 'quick'], ['tables']]) {
      const got = validSteps(STEPS, places);
      assert.deepEqual(got, full.filter((c) => got.includes(c)));
    }
  });

  it('takes the steps from the server: a missing channel, an unknown place, a new code', () => {
    assert.deepEqual(validSteps({ quick: ['to_pay'] }, ['tables', 'kiosk']), []);
    assert.deepEqual(validSteps(STEPS, ['mars']), []);
    const more: UpsellSteps = { ...STEPS, kiosk: [...STEPS.kiosk!.slice(0, 4), 'to_tip', 'to_pay'] };
    assert.deepEqual(validSteps(more, ['kiosk']), ['order_start', 'to_catalog', 'enter_category', 'to_cart', 'to_tip', 'to_pay']);
  });

  it('which of the chosen places have a step', () => {
    assert.deepEqual(stepPlaces(STEPS, 'order_start'), ['quick', 'kiosk']);
    assert.deepEqual(stepPlaces(STEPS, 'to_pay', ['kiosk', 'tables']), ['tables', 'kiosk']);
    assert.deepEqual(stepPlaces(STEPS, 'bill_request', ['quick', 'kiosk']), []);
  });

  it('the codes of a transition rule: split for the form, joined back for the server', () => {
    const codes = ['to_pay', 'enter_category:c1', 'order_start', 'enter_category:c2', 'enter_category:c1'];
    const { steps, categories } = splitStepCodes(codes);
    assert.deepEqual(steps, ['to_pay', 'enter_category', 'order_start']);
    assert.deepEqual(categories, ['c1', 'c2']);
    const order = validSteps(STEPS, ['quick']);
    assert.deepEqual(joinStepCodes(steps, categories, order), ['order_start', 'enter_category:c1', 'enter_category:c2', 'to_pay']);
    // A step no chosen place has is dropped; "כניסה למחלקה" without categories sends nothing.
    assert.deepEqual(joinStepCodes(['bill_request', 'to_pay'], [], order), ['to_pay']);
    assert.deepEqual(joinStepCodes(['enter_category'], [], order), []);
  });

  it('groups the codes for the list, with the category names', () => {
    assert.deepEqual(groupStepCodes(['order_start', 'enter_category:c1', 'enter_category:c2', 'to_pay'], [null, 'שתייה', null, null]), [
      { step: 'order_start', names: [] },
      { step: 'enter_category', names: ['שתייה', '—'] },
      { step: 'to_pay', names: [] },
    ]);
  });
});
