/**
 * Run with `npm test`. "ערוך סדרה": the form sends only what changed, says whether the contents
 * changed (the "partly redeemed too" box), and words each side of a change for the confirmation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_FIELDS,
  changedFields,
  changesByCategory,
  editValueText,
  sameSetting,
  touchesContents,
  type EditValueFormat,
} from './prepaidBatchEdit';

const f: EditValueFormat = {
  money: (v) => `₪${v.toFixed(2)}`,
  date: (iso) => iso.slice(0, 10),
  yes: 'כן',
  no: 'לא',
  none: (field) => (field === 'shopIds' ? 'כל הסניפים' : '—'),
  choice: (field, value) => (field === 'redemptionAccounting' && value === 'discount' ? 'קיזוז מהחשבונית' : null),
  shopName: (id) => ({ s1: 'מרכז', s2: 'צפון' })[id] ?? id,
};

describe('changedFields', () => {
  it('only what changed: nothing when nothing did', () => {
    const base: Record<string, unknown> = { name: 'פסטיבל', validUntil: null, shopIds: ['s1'], items: [{ productId: 'p', quantity: 1 }] };
    assert.deepEqual(changedFields(base, { ...base }), {});
    assert.deepEqual(changedFields(base, { ...base, name: 'חורף', validUntil: '2026-12-31T21:59:59.999Z' }), {
      name: 'חורף', validUntil: '2026-12-31T21:59:59.999Z',
    });
  });

  it('a cleared value is a change; key order and undefined never are', () => {
    assert.deepEqual(changedFields({ freeText: 'שורה' }, { freeText: null }), { freeText: null });
    assert.equal(sameSetting({ mode: 'auto', maxAmount: 5 }, { maxAmount: 5, mode: 'auto' }), true);
    assert.equal(sameSetting({ a: 1, b: undefined }, { a: 1 }), true);
    assert.equal(sameSetting([{ productId: 'p', quantity: 1 }], [{ productId: 'p', quantity: 2 }]), false);
  });
});

describe('touchesContents', () => {
  it('goods, groups and a discount\'s terms are contents; texts, dates and prices are not', () => {
    assert.equal(touchesContents({ items: [] }), true);
    assert.equal(touchesContents({ usesPerVoucher: 3 }), true);
    assert.equal(touchesContents({ name: 'x', validUntil: null, productionPrice: 4 }), false);
    assert.ok(CONTENT_FIELDS.includes('groups') && !CONTENT_FIELDS.includes('count'));
  });
});

describe('changesByCategory', () => {
  it('in the confirmation\'s order, empty categories left out', () => {
    const plan = {
      changes: [
        { field: 'count', category: 'quantity' as const, before: 3, after: 5 },
        { field: 'name', category: 'free' as const, before: 'a', after: 'b' },
        { field: 'validUntil', category: 'validity' as const, before: null, after: '2026-12-31' },
      ],
    };
    assert.deepEqual(changesByCategory(plan).map((g) => g.category), ['free', 'validity', 'quantity']);
  });
});

describe('editValueText', () => {
  it('money, dates, yes / no, empty values', () => {
    assert.equal(editValueText('tillValue', 40, f), '₪40.00');
    assert.equal(editValueText('validUntil', '2026-12-31T21:59:00+00:00', f), '2026-12-31');
    assert.equal(editValueText('showItems', false, f), 'לא');
    assert.equal(editValueText('validFrom', null, f), '—');
    assert.equal(editValueText('shopIds', null, f), 'כל הסניפים');
  });

  it('goods as printed, shops by name, a choice by its label', () => {
    assert.equal(editValueText('items', [{ name: 'נקניקייה', quantity: 2 }, { name: 'זיתים', quantity: 0.5, unitLabel: 'ק"ג' }], f),
      '2× נקניקייה, 0.5 ק"ג זיתים');
    assert.equal(editValueText('shopIds', ['s1', 's2'], f), 'מרכז, צפון');
    assert.equal(editValueText('redemptionAccounting', 'discount', f), 'קיזוז מהחשבונית');
    assert.equal(editValueText('stacking', 'single', f), 'single');
    assert.equal(editValueText('targets', { productIds: ['p'], categoryIds: [], names: ['קפה'] }, f), 'קפה');
    assert.equal(editValueText('groups', [{ name: 'מנה', minQty: 1, maxQty: 2 }], f), 'מנה (1–2)');
    assert.equal(editValueText('count', 5, f), '5');
    assert.equal(editValueText('productionId', { id: 'p1', name: 'הפקות כהן' }, f), 'הפקות כהן');
    assert.equal(editValueText('reportEventId', null, f), '—');
  });
});
