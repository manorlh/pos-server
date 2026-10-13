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
  dateFieldValue,
  editValidity,
  editValueText,
  sameSetting,
  touchesContents,
  type EditValueFormat,
} from './prepaidBatchEdit';
import { dayBoundIso } from './prepaidBatchDuplicate';

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

describe('dateFieldValue: the validity as the form\'s date fields read it', () => {
  it('a day as the dashboard writes it, day first', () => {
    assert.equal(dateFieldValue('07/10/2026'), '2026-10-07');
    assert.equal(dateFieldValue('13/10/2026'), '2026-10-13');
    assert.equal(dateFieldValue('7.1.2027'), '2027-01-07');
  });

  it('a stored moment: the day it falls on in Israel, not UTC\'s', () => {
    // 01/10/2026 00:00 Israel (UTC+3) is still 30/09 in UTC.
    assert.equal(dateFieldValue('2026-09-30T21:00:00+00:00'), '2026-10-01');
    // 31/12/2026 23:59:59 Israel (UTC+2).
    assert.equal(dateFieldValue('2026-12-31T21:59:59+00:00'), '2026-12-31');
    assert.equal(dateFieldValue('2026-12-31T22:00:00.000Z'), '2027-01-01');
    assert.equal(dateFieldValue('2026-10-01T00:00:00+03:00'), '2026-10-01');
    assert.equal(dateFieldValue('2026-09-30T21:00:00+00:00', 'UTC'), '2026-09-30');
    // A plain day is that day.
    assert.equal(dateFieldValue('2026-10-07'), '2026-10-07');
  });

  it('none: empty', () => {
    assert.equal(dateFieldValue(null), '');
    assert.equal(dateFieldValue(undefined), '');
    assert.equal(dateFieldValue(''), '');
    assert.equal(dateFieldValue('   '), '');
  });

  it('not a real day: empty (never a guessed one)', () => {
    assert.equal(dateFieldValue('31/02/2026'), '');
    assert.equal(dateFieldValue('10/13/2026'), ''); // not read month first
    assert.equal(dateFieldValue('2026-02-30'), '');
    assert.equal(dateFieldValue('2026-10-07Tlater'), '');
    assert.equal(dateFieldValue('next week'), '');
    assert.equal(dateFieldValue('Oct 7 2026'), '');
  });
});

describe('editValidity: a day left as it opened is not a change', () => {
  const batch = { validFrom: '2026-09-30T21:00:00+00:00', validUntil: '2026-12-31T21:59:59+00:00' };
  const from = dateFieldValue(batch.validFrom);
  const until = dateFieldValue(batch.validUntil);
  const opened: Record<string, unknown> = { name: 'פסטיבל', ...editValidity(from, until) };

  it('the form opens with the batch\'s days, not empty ones', () => {
    assert.equal(from, '2026-10-01');
    assert.equal(until, '2026-12-31');
    assert.deepEqual(editValidity(from, until), { validFrom: dayBoundIso('2026-10-01', false), validUntil: dayBoundIso('2026-12-31', true) });
  });

  it('untouched days are never sent, also when something else changed', () => {
    assert.deepEqual(changedFields(opened, { name: 'פסטיבל', ...editValidity(from, until) }), {});
    assert.deepEqual(changedFields(opened, { name: 'חורף', ...editValidity(from, until) }), { name: 'חורף' });
  });

  it('a day changed is sent alone (the end of the new last day); changed back, nothing', () => {
    assert.deepEqual(changedFields(opened, { name: 'פסטיבל', ...editValidity(from, '2027-01-15') }), {
      validUntil: dayBoundIso('2027-01-15', true),
    });
    assert.deepEqual(changedFields(opened, { name: 'פסטיבל', ...editValidity('2026-10-05', until) }), {
      validFrom: dayBoundIso('2026-10-05', false),
    });
    assert.deepEqual(changedFields(opened, { name: 'פסטיבל', ...editValidity('2026-10-01', '2026-12-31') }), {});
  });

  it('a day cleared is sent as none; a batch without dates sends none while untouched', () => {
    assert.deepEqual(changedFields(opened, { name: 'פסטיבל', ...editValidity('', until) }), { validFrom: null });
    const bare: Record<string, unknown> = editValidity(dateFieldValue(null), dateFieldValue(null));
    assert.deepEqual(bare, { validFrom: null, validUntil: null });
    assert.deepEqual(changedFields(bare, editValidity('', '')), {});
  });
});
