/**
 * Run with `npm test`. "מחייב אישור מנהל במכירה" (lib/restrictedItems.ts): the tree, the
 * dashboard's own / inherited marks, and a kiosk's catalog without restricted items.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  categoryRestrictionOf,
  isRestrictedProduct,
  restrictedCategoryIds,
  restrictionOf,
  withoutRestricted,
} from './restrictedItems';

const TREE = [
  { id: 'drinks', parentId: null, requiresManagerApproval: false },
  { id: 'alcohol', parentId: 'drinks', requiresManagerApproval: true },
  { id: 'wine', parentId: 'alcohol' },
  { id: 'red', parentId: 'wine', requiresManagerApproval: null },
  { id: 'soft', parentId: 'drinks' },
];

describe('the tree', () => {
  it('restricts a flagged category and everything beneath it', () => {
    assert.deepEqual([...restrictedCategoryIds(TREE)].sort(), ['alcohol', 'red', 'wine']);
  });

  it('restricts nothing when nothing is flagged, and survives a cycle', () => {
    assert.equal(restrictedCategoryIds([{ id: 'a' }, { id: 'b', parentId: 'a' }]).size, 0);
    assert.equal(restrictedCategoryIds([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }]).size, 0);
    assert.deepEqual(
      [...restrictedCategoryIds([{ id: 'a', parentId: 'b', requiresManagerApproval: true }, { id: 'b', parentId: 'a' }])].sort(),
      ['a', 'b'],
    );
  });
});

describe('a product', () => {
  const cats = restrictedCategoryIds(TREE);

  it('is restricted by its own flag, its category or an ancestor', () => {
    assert.equal(isRestrictedProduct({ categoryId: 'soft', requiresManagerApproval: true }, cats), true);
    assert.equal(isRestrictedProduct({ categoryId: 'alcohol' }, cats), true);
    assert.equal(isRestrictedProduct({ categoryId: 'red' }, cats), true);
    assert.equal(isRestrictedProduct({ categoryId: 'soft' }, cats), false);
    assert.equal(isRestrictedProduct({}, cats), false);
  });

  it('says whether the restriction is its own or inherited', () => {
    assert.equal(restrictionOf({ categoryId: 'red', requiresManagerApproval: true }, cats), 'own');
    assert.equal(restrictionOf({ categoryId: 'red' }, cats), 'inherited');
    assert.equal(restrictionOf({ categoryId: 'soft' }, cats), null);
    assert.equal(categoryRestrictionOf(TREE[1], cats), 'own');
    assert.equal(categoryRestrictionOf(TREE[2], cats), 'inherited');
    assert.equal(categoryRestrictionOf(TREE[4], cats), null);
  });
});

describe('a kiosk', () => {
  it('never shows a restricted product or category', () => {
    const products = [
      { id: 'cola', categoryId: 'soft' },
      { id: 'beer', categoryId: 'alcohol' },
      { id: 'merlot', categoryId: 'red' },
      { id: 'cigars', categoryId: 'drinks', requiresManagerApproval: true },
    ];
    const out = withoutRestricted(products, TREE);
    assert.deepEqual(out.products.map((p) => p.id), ['cola']);
    assert.deepEqual(out.categories.map((c) => c.id), ['drinks', 'soft']);
  });

  it('completes the tree from rows it does not keep', () => {
    const out = withoutRestricted([{ id: 'merlot', categoryId: 'red' }], [{ id: 'red', parentId: 'wine' }], TREE);
    assert.deepEqual(out.products, []);
    assert.deepEqual(out.categories, []);
  });
});
