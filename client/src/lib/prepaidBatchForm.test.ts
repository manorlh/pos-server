/**
 * Run with `npm test`. The batch form's "what is still missing", the run's totals before issue
 * (the spec's "100 שוברים … זכאות ל-300 יחידות") and the batch list's filters.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NO_BATCH_FILTERS, batchFormProblems, filterBatches, issueTotals, type BatchFormDraft } from './prepaidBatchForm';

const ok: BatchFormDraft = {
  name: 'הפקה', companyId: 'c1', discount: false, itemCount: 2, termErrors: 0, count: 50, groupOk: true,
  validFrom: '', validUntil: '',
};

describe('batchFormProblems', () => {
  it('nothing missing on a complete form', () => {
    assert.deepEqual(batchFormProblems(ok), []);
  });

  it('says what is missing, in the form order', () => {
    assert.deepEqual(batchFormProblems({ ...ok, name: ' ', companyId: '', itemCount: 0 }), ['name', 'company', 'items']);
    assert.deepEqual(batchFormProblems({ ...ok, discount: true, itemCount: 0, termErrors: 1 }), ['terms']);
    assert.deepEqual(batchFormProblems({ ...ok, discount: true, itemCount: 0 }), []);
    assert.deepEqual(batchFormProblems({ ...ok, count: 0 }), ['count']);
    assert.deepEqual(batchFormProblems({ ...ok, count: 5001, groupOk: false }), ['count', 'groupSize']);
    assert.deepEqual(batchFormProblems({ ...ok, count: Number.NaN }), ['count']);
    assert.deepEqual(batchFormProblems({ ...ok, validFrom: '2026-08-14', validUntil: '2026-08-12' }), ['dates']);
    assert.deepEqual(batchFormProblems({ ...ok, validFrom: '2026-08-12', validUntil: '2026-08-12' }), []);
    assert.deepEqual(batchFormProblems({ ...ok, stackingOk: false }), ['maxVouchers']);
    assert.deepEqual(batchFormProblems({ ...ok, stackingOk: true }), []);
  });
});

describe('issueTotals', () => {
  it('counts units by the piece and weights per unit', () => {
    const t = issueTotals(100, [{ quantity: 1 }, { quantity: 2 }, { quantity: 0.5, weighed: true }], 'ק"ג');
    assert.deepEqual(t, { units: 300, weights: [{ unit: 'ק"ג', quantity: 50 }] });
    assert.deepEqual(issueTotals(3, [{ quantity: 0.25, weighed: true, unitLabel: 'ליטר' }], 'ק"ג').weights, [{ unit: 'ליטר', quantity: 0.75 }]);
    assert.deepEqual(issueTotals(Number.NaN, [{ quantity: 1 }], 'ק"ג'), { units: 0, weights: [] });
  });
});

describe('filterBatches', () => {
  const rows = [
    { id: 1, name: 'הפקה — מזון', eventName: 'פסטיבל הקיץ', customerName: 'קייטרינג אלון', orderRef: 'PO-9', status: 'active', kind: 'items', companyId: 'c1' },
    { id: 2, name: 'הנחה', eventName: null, customerName: null, orderRef: null, status: 'cancelled', kind: 'order_discount', companyId: 'c2' },
  ];

  it('all by default; by status, kind, company and words', () => {
    assert.equal(filterBatches(rows, NO_BATCH_FILTERS).length, 2);
    assert.deepEqual(filterBatches(rows, { ...NO_BATCH_FILTERS, status: 'active' }).map((r) => r.id), [1]);
    assert.deepEqual(filterBatches(rows, { ...NO_BATCH_FILTERS, kind: 'discount' }).map((r) => r.id), [2]);
    assert.deepEqual(filterBatches(rows, { ...NO_BATCH_FILTERS, companyId: 'c2' }).map((r) => r.id), [2]);
    assert.deepEqual(filterBatches(rows, { ...NO_BATCH_FILTERS, search: 'קיץ אלון' }).map((r) => r.id), [1]);
    assert.deepEqual(filterBatches(rows, { ...NO_BATCH_FILTERS, search: 'po-9' }).map((r) => r.id), [1]);
    assert.deepEqual(filterBatches(rows, { ...NO_BATCH_FILTERS, search: 'אין כזה' }), []);
  });
});
