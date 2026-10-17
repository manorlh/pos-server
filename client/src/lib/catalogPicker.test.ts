/**
 * Run with `npm test`. The two-pane product & category picker's rules (lib/catalogPicker.ts):
 * what a tick on a category or a product does, the partial state and the counts, shift-click
 * ranges, search and filters, reordering, sub-categories, and bulk prices.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_SELECTION,
  UNCATEGORIZED,
  buildIndex,
  bulkPrices,
  compressWhole,
  expandWhole,
  groupOf,
  isPicked,
  materialize,
  moveCategory,
  moveProduct,
  nodeCount,
  nodeProducts,
  nodeState,
  normalizeSearch,
  pickedInOrder,
  pickedSet,
  rangeIds,
  rootsOf,
  selectionOf,
  setNode,
  setProducts,
  tagsOf,
  visibleProducts,
  type PickerCategory,
  type PickerProduct,
  type PickerSelection,
} from './catalogPicker';

const cats: PickerCategory[] = [
  { id: 'drinks', name: 'שתייה', parentId: null, sortOrder: 2 },
  { id: 'soft', name: 'קלה', parentId: 'drinks', sortOrder: 1 },
  { id: 'hot', name: 'חמה', parentId: 'drinks', sortOrder: 2 },
  { id: 'food', name: 'אוכל', parentId: null, sortOrder: 1 },
  { id: 'empty', name: 'ריקה', parentId: null, sortOrder: 3 },
];

const prods: PickerProduct[] = [
  { id: 'burger', name: 'המבורגר', categoryId: 'food', price: 52, sku: 'B-1', tags: ['בשרי'] },
  { id: 'salad', name: 'סלט', categoryId: 'food', price: 40, tags: ['טבעוני'], inStock: false },
  { id: 'pasta', name: 'פסטה', categoryId: 'food', price: 46, isActive: false },
  { id: 'cola', name: 'קולה', categoryId: 'soft', price: 12 },
  { id: 'soda', name: 'סודה', categoryId: 'soft', price: 10 },
  { id: 'tea', name: 'תה', categoryId: 'hot', price: 9 },
  { id: 'general', name: 'פריט כללי', categoryId: 'food', price: 0, blocked: 'פריט כללי' },
  { id: 'loose', name: 'מוצר בודד', categoryId: null, price: 5 },
  { id: 'orphan', name: 'יתום', categoryId: 'gone', price: 7 },
];

const index = buildIndex(cats, prods);
const ids = (sel: PickerSelection) => pickedInOrder(index, sel).map((p) => p.id);

describe('the tree', () => {
  it('orders roots and children by sort order, unknown categories under "ללא קטגוריה"', () => {
    assert.deepEqual(rootsOf(index), ['food', 'drinks', 'empty']);
    assert.deepEqual(index.children.get('drinks'), ['soft', 'hot']);
    assert.equal(index.nodeOf('orphan'), UNCATEGORIZED);
    assert.equal(index.nodeOf('loose'), UNCATEGORIZED);
    assert.equal(index.path('soft'), 'שתייה › קלה');
    assert.deepEqual(index.subtree('drinks'), ['drinks', 'soft', 'hot']);
  });

  it('survives a parent loop', () => {
    const looped = buildIndex(
      [
        { id: 'a', name: 'א', parentId: 'b' },
        { id: 'b', name: 'ב', parentId: 'a' },
      ],
      [],
    );
    assert.equal(new Set(looped.subtree(rootsOf(looped)[0])).size, 2);
  });
});

describe('a tick on a category', () => {
  it('takes the whole category and its sub-categories; counts and states follow', () => {
    const sel = setNode(index, EMPTY_SELECTION, 'drinks', true);
    assert.deepEqual(sel.categories, [
      { id: 'drinks', whole: true },
      { id: 'soft', whole: true },
      { id: 'hot', whole: true },
    ]);
    assert.deepEqual(ids(sel), ['cola', 'soda', 'tea']);
    const picked = pickedSet(index, sel);
    assert.deepEqual(nodeCount(index, picked, 'drinks'), { picked: 3, total: 3 });
    assert.equal(nodeState(index, sel, picked, 'drinks'), 'all');
    assert.equal(nodeState(index, sel, picked, 'food'), 'none');
  });

  it('never counts or picks a blocked product', () => {
    const sel = setNode(index, EMPTY_SELECTION, 'food', true);
    const picked = pickedSet(index, sel);
    assert.equal(picked.has('general'), false);
    assert.deepEqual(nodeCount(index, picked, 'food'), { picked: 3, total: 3 });
    assert.deepEqual(setProducts(index, EMPTY_SELECTION, ['general'], true), EMPTY_SELECTION);
  });

  it('without whole categories lists its products one by one', () => {
    const sel = setNode(index, EMPTY_SELECTION, 'soft', true, { whole: false });
    assert.deepEqual(sel, { categories: [{ id: 'soft', whole: false }], products: ['cola', 'soda'] });
  });

  it('an untick takes the category, its sub-categories and their listed products away', () => {
    let sel = setNode(index, EMPTY_SELECTION, 'drinks', true);
    sel = setProducts(index, sel, ['burger'], true);
    sel = setNode(index, sel, 'drinks', false);
    assert.deepEqual(sel, { categories: [{ id: 'food', whole: false }], products: ['burger'] });
  });

  it('an empty category can be whole (a menu keeps it for later products)', () => {
    const sel = setNode(index, EMPTY_SELECTION, 'empty', true);
    assert.equal(nodeState(index, sel, pickedSet(index, sel), 'empty'), 'all');
  });
});

describe('a tick on a product', () => {
  it('lists it and makes its category partial', () => {
    const sel = setProducts(index, EMPTY_SELECTION, ['cola'], true);
    assert.deepEqual(sel, { categories: [{ id: 'soft', whole: false }], products: ['cola'] });
    const picked = pickedSet(index, sel);
    assert.equal(nodeState(index, sel, picked, 'soft'), 'some');
    assert.equal(nodeState(index, sel, picked, 'drinks'), 'some');
    assert.deepEqual(nodeCount(index, picked, 'drinks'), { picked: 1, total: 3 });
  });

  it('a product of no category is listed without a category', () => {
    const sel = setProducts(index, EMPTY_SELECTION, ['loose', 'orphan'], true);
    assert.deepEqual(sel, { categories: [], products: ['loose', 'orphan'] });
    assert.equal(nodeState(index, sel, pickedSet(index, sel), UNCATEGORIZED), 'all');
  });

  it('unpicking one of a whole category keeps the others, in the order shown', () => {
    let sel = setNode(index, EMPTY_SELECTION, 'food', true);
    sel = setProducts(index, sel, ['salad'], false);
    assert.deepEqual(sel.categories, [{ id: 'food', whole: false }]);
    assert.deepEqual(sel.products, ['burger', 'pasta']);
    assert.equal(isPicked(index, sel, 'salad'), false);
  });

  it('unpicking the last listed product drops its partial category', () => {
    let sel = setProducts(index, EMPTY_SELECTION, ['cola'], true);
    sel = setProducts(index, sel, ['cola'], false);
    assert.deepEqual(sel, EMPTY_SELECTION);
  });

  it('picking twice changes nothing', () => {
    const once = setProducts(index, EMPTY_SELECTION, ['cola'], true);
    assert.equal(setProducts(index, once, ['cola'], true), once);
    const whole = setNode(index, EMPTY_SELECTION, 'soft', true);
    assert.equal(setProducts(index, whole, ['cola'], true), whole);
  });
});

describe('shift-click ranges', () => {
  const visible = ['a', 'b', 'c', 'd', 'e'];
  it('both directions, inclusive', () => {
    assert.deepEqual(rangeIds(visible, 'b', 'd'), ['b', 'c', 'd']);
    assert.deepEqual(rangeIds(visible, 'd', 'b'), ['b', 'c', 'd']);
  });
  it('no anchor (or one scrolled away by a filter): just the one', () => {
    assert.deepEqual(rangeIds(visible, null, 'c'), ['c']);
    assert.deepEqual(rangeIds(visible, 'x', 'c'), ['c']);
    assert.deepEqual(rangeIds(visible, 'a', 'x'), []);
  });
});

describe('search and filters', () => {
  it('searches every product, by name or SKU, any word order, without niqqud', () => {
    assert.deepEqual(visibleProducts(index, 'soft', { search: 'b-1' }).map((p) => p.id), ['burger']);
    assert.deepEqual(visibleProducts(index, null, { search: 'קולָה' }).map((p) => p.id), ['cola']);
    assert.equal(normalizeSearch('  סָלָט  ירוק '), 'סלט ירוק');
  });

  it('the focused category shows its sub-categories too', () => {
    assert.deepEqual(visibleProducts(index, 'drinks', {}).map((p) => p.id), ['cola', 'soda', 'tea']);
    assert.deepEqual(visibleProducts(index, UNCATEGORIZED, {}).map((p) => p.id), ['loose', 'orphan']);
  });

  it('active / inactive, in stock, a tag, only the picked', () => {
    assert.deepEqual(visibleProducts(index, 'food', { status: 'inactive' }).map((p) => p.id), ['pasta']);
    assert.equal(visibleProducts(index, 'food', { status: 'active' }).some((p) => p.id === 'pasta'), false);
    assert.deepEqual(visibleProducts(index, 'food', { stock: 'out' }).map((p) => p.id), ['salad']);
    assert.deepEqual(visibleProducts(index, null, { tag: 'טבעוני' }).map((p) => p.id), ['salad']);
    const sel = setProducts(index, EMPTY_SELECTION, ['tea'], true);
    assert.deepEqual(visibleProducts(index, null, { onlyPicked: pickedSet(index, sel) }).map((p) => p.id), ['tea']);
    assert.deepEqual(tagsOf(index), ['בשרי', 'טבעוני']);
  });

  it('2,500 products: index, count and filter stay fast', () => {
    const many: PickerProduct[] = Array.from({ length: 2500 }, (_, i) => ({
      id: `p${i}`,
      name: `מוצר ${i}`,
      categoryId: i % 2 ? 'soft' : 'food',
      price: i,
    }));
    const t0 = Date.now();
    const big = buildIndex(cats, many);
    let sel = setNode(big, EMPTY_SELECTION, 'food', true);
    sel = setProducts(big, sel, ['p1', 'p3', 'p5'], true);
    const picked = pickedSet(big, sel);
    for (const id of ['food', 'drinks', 'soft']) nodeCount(big, picked, id);
    visibleProducts(big, null, { search: 'מוצר 24' });
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    assert.equal(picked.size, 1253);
  });
});

describe('the order in the menu', () => {
  it('categories move; a whole category shows its listed products first', () => {
    let sel = setNode(index, EMPTY_SELECTION, 'food', true);
    sel = setNode(index, sel, 'soft', true);
    sel = moveCategory(sel, 'soft', 0);
    assert.deepEqual(sel.categories.map((c) => c.id), ['soft', 'food']);
    sel = { ...sel, products: ['pasta'] };
    assert.deepEqual(nodeProducts(index, sel, 'food').map((p) => p.id), ['pasta', 'burger', 'salad']);
  });

  it('moving a product of a whole category lists the category and keeps the new order', () => {
    let sel = setNode(index, EMPTY_SELECTION, 'food', true);
    sel = setProducts(index, sel, ['cola'], true);
    sel = moveProduct(index, sel, 'salad', 0);
    assert.deepEqual(nodeProducts(index, sel, 'food').map((p) => p.id), ['salad', 'burger', 'pasta']);
    assert.equal(sel.categories.find((c) => c.id === 'food')?.whole, true);
    // The other category's products kept their place.
    assert.ok(sel.products.includes('cola'));
  });

  it('materialize lists the rest of a whole category after its listed ones', () => {
    const sel = materialize(index, { categories: [{ id: 'food', whole: true }], products: ['salad'] }, 'food');
    assert.deepEqual(sel.products, ['salad', 'burger', 'pasta']);
  });
});

describe('screens that store categories with their sub-categories', () => {
  it('compress drops a child of a whole parent; expand brings them back', () => {
    assert.deepEqual(compressWhole(index, ['drinks', 'soft', 'hot', 'food']), ['drinks', 'food']);
    assert.deepEqual(expandWhole(index, ['drinks', 'gone']), ['drinks', 'soft', 'hot', 'gone']);
  });

  it('a group (categories + products) round-trips through a selection', () => {
    const sel = selectionOf(index, ['soft'], ['burger', 'loose']);
    assert.deepEqual(sel.categories, [
      { id: 'soft', whole: true },
      { id: 'food', whole: false },
    ]);
    assert.deepEqual(groupOf(index, sel), { categoryIds: ['soft'], productIds: ['burger', 'loose'] });
  });
});

describe('bulk prices', () => {
  it('set one price, or a percent off / on the base price, never below zero', () => {
    const rows = [
      { id: 'a', price: 50 },
      { id: 'b', price: 9.99 },
    ];
    assert.deepEqual(bulkPrices(rows, 'set', 30), { a: '30', b: '30' });
    assert.deepEqual(bulkPrices(rows, 'percent', -10), { a: '45', b: '8.99' });
    assert.deepEqual(bulkPrices(rows, 'percent', -150), { a: '0', b: '0' });
    assert.deepEqual(bulkPrices(rows, 'set', Number.NaN), {});
  });
});
