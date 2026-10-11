/**
 * Run with `npm test`. "שינוי הגדרות לסדרות שנבחרו": only the ticked settings are sent, a setting says
 * which batches it is for, and "בחר הכל" picks what the filters show.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BULK_FIELDS,
  MAX_BULK_BATCHES,
  allState,
  bulkChanges,
  fieldApplies,
  notApplicableCount,
  outcomeOrder,
  selectedShown,
  toggleAll,
  toggleOne,
  willChange,
  type BulkField,
} from './prepaidBatchBulkEdit';

const goods = { kind: 'items', selection: 'items' };
const meal = { kind: 'items', selection: 'groups' };
const discount = { kind: 'order_discount', selection: 'items' };

describe('bulkChanges', () => {
  const parts: Partial<Record<BulkField, Record<string, unknown>>> = {
    validUntil: { validUntil: '2026-12-31T21:59:59.999Z' },
    stacking: { stacking: 'unlimited', maxVouchersPerSale: 3 },
    splitAllowed: { splitAllowed: true },
    shopIds: { shopIds: null },
  };

  it('sends only the ticked settings: an unticked one stays as it is', () => {
    assert.deepEqual(bulkChanges(parts, new Set<BulkField>(['validUntil'])), { validUntil: '2026-12-31T21:59:59.999Z' });
    assert.deepEqual(bulkChanges(parts, new Set<BulkField>(['stacking', 'splitAllowed'])), {
      stacking: 'unlimited', maxVouchersPerSale: 3, splitAllowed: true,
    });
  });

  it('a cleared value is sent as null (every shop, no date)', () => {
    assert.deepEqual(bulkChanges(parts, new Set<BulkField>(['shopIds'])), { shopIds: null });
  });

  it('nothing ticked: nothing at all (no extra flags alone)', () => {
    assert.deepEqual(bulkChanges(parts, new Set(), { applyToPartial: true }), {});
    assert.deepEqual(bulkChanges(parts, new Set<BulkField>(['splitAllowed']), { applyToPartial: true }), {
      splitAllowed: true, applyToPartial: true,
    });
  });

  it('never a batch identity, its goods, its count or its price', () => {
    const fields = BULK_FIELDS.map((f) => f.field as string);
    for (const f of ['name', 'customerName', 'items', 'count', 'productionPrice', 'discountValue', 'targets']) {
      assert.ok(!fields.includes(f), f);
    }
  });
});

describe('fieldApplies', () => {
  it('goods settings are not a discount batch’s; groups only a package’s', () => {
    assert.equal(fieldApplies('splitAllowed', goods), true);
    assert.equal(fieldApplies('splitAllowed', discount), false);
    assert.equal(fieldApplies('discountBlockPolicy', discount), false);
    assert.equal(fieldApplies('totalQty', meal), true);
    assert.equal(fieldApplies('totalQty', goods), false);
    assert.equal(fieldApplies('totalQty', discount), false);
    assert.equal(fieldApplies('validUntil', discount), true);
    assert.equal(fieldApplies('stacking', discount), true);
  });

  it('counts the picked batches a setting is not for', () => {
    assert.equal(notApplicableCount('splitAllowed', [goods, discount, meal, discount]), 2);
    assert.equal(notApplicableCount('showCode', [goods, discount]), 0);
  });
});

describe('selection', () => {
  const shown = ['a', 'b', 'c'];

  it('"בחר הכל" picks what is shown; again un-picks it', () => {
    const all = toggleAll(new Set(['z']), shown);
    assert.deepEqual([...all].sort(), ['a', 'b', 'c', 'z']);
    assert.deepEqual([...toggleAll(all, shown)], ['z']);
  });

  it('only the picked batches still shown count', () => {
    assert.deepEqual(selectedShown(new Set(['c', 'z', 'a']), shown), ['a', 'c']);
    assert.equal(allState(new Set(['a']), shown), 'some');
    assert.equal(allState(new Set(shown), shown), 'all');
    assert.equal(allState(new Set(['z']), shown), 'none');
    assert.deepEqual([...toggleOne(new Set(['a']), 'a', false)], []);
  });

  it('the cap is the cloud’s', () => {
    assert.equal(MAX_BULK_BATCHES, 200);
  });
});

describe('outcomes', () => {
  it('refused first, then changed, then unchanged — each in the order picked', () => {
    const items = [
      { batchId: '1', name: 'א', status: 'ok' as const },
      { batchId: '2', name: 'ב', status: 'unchanged' as const },
      { batchId: '3', name: null, status: 'refused' as const },
      { batchId: '4', name: 'ד', status: 'ok' as const },
    ];
    assert.deepEqual(outcomeOrder(items).map((i) => i.batchId), ['3', '1', '4', '2']);
    assert.equal(willChange({ items }), 2);
    assert.equal(willChange(null), 0);
  });
});
