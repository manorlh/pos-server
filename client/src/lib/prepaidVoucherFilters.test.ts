/**
 * Run with `npm test`. The prepaid vouchers' filter model (lib/prepaidVoucherFilters.ts): the URL
 * and the API's query are the same names; unreadable values are dropped; the page's view and sort.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_FILTERS,
  activeFilterCount,
  agorotText,
  filtersFromQuery,
  filtersToQuery,
  pageStateFromQuery,
  pageStateToQuery,
  rateText,
  searchGroups,
  voucherFilterLines,
  withFilter,
  type VoucherFilterWords,
  type VoucherFilters,
} from './prepaidVoucherFilters';

describe('filtersFromQuery / filtersToQuery', () => {
  it('a round trip keeps every filter, lists repeated', () => {
    const f: VoucherFilters = {
      ...EMPTY_FILTERS,
      customer: ['קייטרינג אלון', 'הפקות דנה'],
      event: ['פסטיבל הקיץ'],
      kind: 'items',
      accounting: 'payment',
      pricing: 'fixed',
      override: 'yes',
      offline: 'no',
      testMode: 'yes',
      valueMin: '10',
      valueMax: '80.5',
      issuedFrom: '2026-10-01',
      to: '2026-10-08',
      machineId: ['m1'],
      employee: ['דנה'],
      batchStatus: 'has_open',
      state: 'partial',
      group: '3',
      q: '#12',
    };
    const q = filtersToQuery(f);
    assert.deepEqual(q.getAll('customer'), ['קייטרינג אלון', 'הפקות דנה']);
    assert.equal(q.get('typeId'), null);
    assert.deepEqual(filtersFromQuery(q), f);
    assert.deepEqual(filtersFromQuery(q.toString()), f);
    assert.deepEqual(filtersFromQuery(`?${q.toString()}`), f);
  });

  it('drops what it cannot read, never guesses', () => {
    const f = filtersFromQuery({
      accounting: 'exempt', batchStatus: 'lost', state: 'gone', from: '2026-13-40', valueMin: '-5', valueMax: 'abc',
      group: '0', kind: 'other', override: 'maybe', testMode: 'perhaps',
    });
    assert.deepEqual(f, EMPTY_FILTERS);
  });

  it('a list may come comma-separated, without repeats', () => {
    assert.deepEqual(filtersFromQuery({ customer: ['א, ב', 'א'] }).customer, ['א', 'ב']);
  });

  it('a decimal comma is a point', () => {
    assert.equal(filtersFromQuery({ valueMin: '12,5' }).valueMin, '12.5');
  });

  it('leaves out what a view does not send', () => {
    const f = { ...EMPTY_FILTERS, state: 'open' as const, group: '2', event: ['א'] };
    assert.equal(filtersToQuery(f, ['state', 'group']).toString(), `event=${encodeURIComponent('א')}`);
  });
});

describe('activeFilterCount / withFilter', () => {
  it('counts each set filter once', () => {
    assert.equal(activeFilterCount(EMPTY_FILTERS), 0);
    const f = withFilter(withFilter(EMPTY_FILTERS, 'customer', ['א', 'ב']), 'from', '2026-10-01');
    assert.equal(activeFilterCount(f), 2);
    assert.equal(activeFilterCount(withFilter(f, 'state', 'open'), ['state']), 2);
    assert.deepEqual(EMPTY_FILTERS.customer, []);
  });
});

describe('the page state in the URL', () => {
  it('defaults are left out of the URL', () => {
    assert.equal(pageStateToQuery({ view: 'batches', sort: 'newest', filters: EMPTY_FILTERS }), '');
    const s = { view: 'tills' as const, sort: 'redeemed' as const, filters: { ...EMPTY_FILTERS, event: ['קיץ'] } };
    const q = pageStateToQuery(s);
    assert.ok(q.startsWith('view=tills&sort=redeemed&event='));
    assert.deepEqual(pageStateFromQuery(q), s);
  });

  it('an unknown view or sort reads as the default', () => {
    const s = pageStateFromQuery('view=charts&sort=cheapest');
    assert.equal(s.view, 'batches');
    assert.equal(s.sort, 'newest');
  });
});

describe('texts', () => {
  it('a rate, and nothing to divide by', () => {
    assert.equal(rateText(0.625), '63%');
    assert.equal(rateText(0), '0%');
    assert.equal(rateText(null), '—');
  });

  it('agorot as shekels', () => {
    assert.equal(agorotText(150000), '₪1,500');
    assert.equal(agorotText(1250), '₪12.50');
    assert.equal(agorotText(null), '—');
  });

  it('the search groups that found something, in order', () => {
    assert.deepEqual(searchGroups({ batches: [1], vouchers: [], tills: [2], employees: [] }, ['vouchers', 'batches', 'tills', 'employees']), [
      'batches',
      'tills',
    ]);
  });
});

describe('voucherFilterLines (the export header in words)', () => {
  const words: VoucherFilterWords = {
    label: (k) => `L:${k}`,
    option: (k, v) => `${k}=${v}`,
    name: (k, id) => ({ s1: 'מרכז', s2: 'צפון', m1: 'קופה 1', u1: 'דנה' } as Record<string, string>)[id] ?? null,
    day: (iso) => iso.split('-').reverse().join('/'),
    min: 'מ-',
    max: 'עד',
  };

  it('nothing set: no lines', () => {
    assert.deepEqual(voucherFilterLines(EMPTY_FILTERS, words), []);
  });

  it('every kind of filter, in the bar order; unknown ids as they are', () => {
    const f: VoucherFilters = {
      ...EMPTY_FILTERS,
      customer: ['קייטרינג אלון', 'הפקות דנה'],
      shopId: ['s1', 's2', 'zz'],
      accounting: 'payment',
      valueMin: '10',
      priceMax: '50',
      createdBy: 'u1',
      issuedFrom: '2026-10-01',
      issuedTo: '2026-10-05',
      validOn: '2026-10-03',
      from: '2026-10-02',
      machineId: ['m1'],
      state: 'open',
      group: '3',
      q: ' 123 ',
    };
    assert.deepEqual(voucherFilterLines(f, words), [
      { label: 'L:customer', value: 'קייטרינג אלון, הפקות דנה' },
      { label: 'L:shopId', value: 'מרכז, צפון, zz' },
      { label: 'L:accounting', value: 'accounting=payment' },
      { label: 'L:value', value: 'מ-10' },
      { label: 'L:price', value: 'עד 50' },
      { label: 'L:createdBy', value: 'דנה' },
      { label: 'L:issued', value: 'מ-01/10/2026 עד 05/10/2026' },
      { label: 'L:validOn', value: '03/10/2026' },
      { label: 'L:redeemed', value: 'מ-02/10/2026' },
      { label: 'L:machineId', value: 'קופה 1' },
      { label: 'L:state', value: 'state=open' },
      { label: 'L:group', value: '3' },
      { label: 'L:q', value: '123' },
    ]);
  });

  it('omitted filters stay out (the redemption days in the range line); one day once', () => {
    const f: VoucherFilters = { ...EMPTY_FILTERS, from: '2026-10-02', to: '2026-10-04', issuedFrom: '2026-10-01', issuedTo: '2026-10-01', testMode: 'yes' };
    assert.deepEqual(voucherFilterLines(f, words, ['from', 'to']), [
      { label: 'L:testMode', value: 'testMode=yes' },
      { label: 'L:issued', value: '01/10/2026' },
    ]);
  });
});
