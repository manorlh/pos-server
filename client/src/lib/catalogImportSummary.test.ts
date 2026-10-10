import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionableCount, confirmLines, firstTab, previewTabs, resultLines } from './catalogImportSummary';

const base = {
  productsNew: 0,
  productsUpdated: 0,
  categoriesNew: 0,
  categoriesUpdated: 0,
  routingChanges: 0,
  routingShops: 0,
};

test('the add-on, notes and options tabs show only when the file has such rows', () => {
  assert.deepEqual(previewTabs({ products: [1, 2], categories: [], groups: [], options: [], notes: [] }), [
    { id: 'products', count: 2 },
    { id: 'categories', count: 0 },
  ]);
  assert.deepEqual(
    previewTabs({ products: [], categories: [1], groups: [1], options: [1, 2, 3], notes: [1] }).map((t) => t.id),
    ['products', 'categories', 'groups', 'options', 'notes'],
  );
  // A preview from a server that predates the add-on layer has no such keys.
  assert.deepEqual(previewTabs({ products: [], categories: [] }).length, 2);
});

test('the first tab is the first one with rows', () => {
  assert.equal(firstTab({ products: [], categories: [], groups: [1] }), 'groups');
  assert.equal(firstTab({ products: [], categories: [1] }), 'categories');
  assert.equal(firstTab({ products: [], categories: [] }), 'products');
});

test('anything to import counts the add-on layer, pictures and menu prices too', () => {
  assert.equal(actionableCount(base), 0);
  assert.equal(actionableCount({ ...base, optionsNew: 2 }), 2);
  assert.equal(actionableCount({ ...base, imageChanges: 1, menuPriceChanges: 3, linkChanges: 1 }), 5);
  assert.equal(actionableCount({ ...base, productsNew: 1, notesUpdated: 1, routingChanges: 1 }), 3);
});

test('the confirm lines, in order, with the routing shops and the skipped rows', () => {
  const lines = confirmLines({ ...base, productsNew: 3, groupsNew: 1, optionsNew: 4, notesNew: 2, imageChanges: 5,
    routingChanges: 2, routingShops: 3 }, 1);
  assert.deepEqual(lines.map((l) => l.key), ['confirmCreate', 'confirmGroups', 'confirmOptions', 'confirmNotes',
    'confirmImages', 'confirmRouting', 'confirmSkip']);
  assert.deepEqual(lines.find((l) => l.key === 'confirmRouting'), { key: 'confirmRouting', count: 2, values: { shops: 3 } });
  assert.deepEqual(confirmLines(base), []);
});

test('the result lines skip what did not happen', () => {
  const lines = resultLines({ productsCreated: 2, productsUpdated: 0, categoriesCreated: 0, categoriesUpdated: 0,
    routingChanges: 0, costsUpdated: 0, skippedErrorRows: 0, groupsCreated: 1, linksChanged: 4, imagesStored: 2 });
  assert.deepEqual(lines, [
    { key: 'productsCreated', count: 2 },
    { key: 'groupsCreated', count: 1 },
    { key: 'linksChanged', count: 4 },
    { key: 'imagesStored', count: 2 },
  ]);
});
