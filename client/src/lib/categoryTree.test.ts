/**
 * Run with `npm test`. The "קטגוריית אב" select's tree (lib/categoryTree.ts): the same rule the cloud enforces
 * (pos-server tests/test_category_parent.py) — a category may sit under any category but itself and what is beneath it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { categoryPath, descendantIds, parentOptions, wouldCycle, type CategoryNode } from './categoryTree';

// אוכל > מנות > המבורגרים, אוכל > קינוחים, שתייה > יין, and a lone "מבצעים".
const tree: CategoryNode[] = [
  { id: 'food', name: 'אוכל' },
  { id: 'drinks', name: 'שתייה', parentId: null },
  { id: 'mains', name: 'מנות', parentId: 'food' },
  { id: 'burgers', name: 'המבורגרים', parentId: 'mains' },
  { id: 'desserts', name: 'קינוחים', parentId: 'food' },
  { id: 'wine', name: 'יין', parentId: 'drinks' },
  { id: 'deals', name: 'מבצעים' },
];

describe('what is beneath a category', () => {
  it('its children and theirs, not itself', () => {
    assert.deepEqual([...descendantIds(tree, 'food')].sort(), ['burgers', 'desserts', 'mains']);
    assert.deepEqual([...descendantIds(tree, 'mains')], ['burgers']);
    assert.deepEqual([...descendantIds(tree, 'burgers')], []);
    assert.deepEqual([...descendantIds(tree, 'nobody')], []);
  });

  it('a loop in the data is walked once, never for ever', () => {
    const loop: CategoryNode[] = [
      { id: 'a', name: 'א', parentId: 'b' },
      { id: 'b', name: 'ב', parentId: 'a' },
      { id: 'c', name: 'ג', parentId: 'c' },
    ];
    assert.deepEqual([...descendantIds(loop, 'a')], ['b']);
    assert.deepEqual([...descendantIds(loop, 'c')], []);
  });
});

describe('a category may not be its own ancestor', () => {
  it('itself, a child and a grandchild close a loop; a sibling, a parent and a stranger do not', () => {
    assert.equal(wouldCycle(tree, 'food', 'food'), true);
    assert.equal(wouldCycle(tree, 'food', 'mains'), true);
    assert.equal(wouldCycle(tree, 'food', 'burgers'), true);
    assert.equal(wouldCycle(tree, 'mains', 'desserts'), false);
    assert.equal(wouldCycle(tree, 'burgers', 'food'), false);
    assert.equal(wouldCycle(tree, 'wine', 'food'), false);
  });
});

describe('the parent select', () => {
  it('a new category may sit under any, as a tree: each category, then what is beneath it', () => {
    assert.deepEqual(
      parentOptions(tree).map((o) => [o.id, o.depth, o.label]),
      [
        ['food', 0, 'אוכל'],
        ['mains', 1, 'אוכל › מנות'],
        ['burgers', 2, 'אוכל › מנות › המבורגרים'],
        ['desserts', 1, 'אוכל › קינוחים'],
        ['drinks', 0, 'שתייה'],
        ['wine', 1, 'שתייה › יין'],
        ['deals', 0, 'מבצעים'],
      ],
    );
  });

  it('never offers the category itself or anything beneath it (the way a loop is made)', () => {
    assert.deepEqual(parentOptions(tree, 'mains').map((o) => o.id), ['food', 'desserts', 'drinks', 'wine', 'deals']);
    assert.deepEqual(parentOptions(tree, 'food').map((o) => o.id), ['drinks', 'wine', 'deals']);
    // A bottom category may go under every other.
    assert.equal(parentOptions(tree, 'burgers').length, 6);
    assert.ok(!parentOptions(tree, 'burgers').some((o) => o.id === 'burgers'));
  });

  it('every category it offers passes the loop check', () => {
    for (const c of tree) {
      for (const o of parentOptions(tree, c.id)) assert.equal(wouldCycle(tree, c.id, o.id), false, `${c.id} under ${o.id}`);
    }
  });

  it('a category whose parent is not in the list is a top one; a loop in the data loses nothing', () => {
    const orphan: CategoryNode[] = [{ id: 'x', name: 'יתומה', parentId: 'gone' }, ...tree];
    assert.equal(parentOptions(orphan).find((o) => o.id === 'x')?.depth, 0);
    const loop: CategoryNode[] = [
      { id: 'a', name: 'א', parentId: 'b' },
      { id: 'b', name: 'ב', parentId: 'a' },
    ];
    assert.deepEqual(parentOptions(loop).map((o) => o.id).sort(), ['a', 'b']);
  });

  it('the list order is kept: siblings stay in the order the cloud sorted them', () => {
    const sorted: CategoryNode[] = [
      { id: 'z', name: 'ת' },
      { id: 'a', name: 'א' },
      { id: 'z1', name: 'ת1', parentId: 'z' },
    ];
    assert.deepEqual(parentOptions(sorted).map((o) => o.id), ['z', 'z1', 'a']);
  });
});

describe('a category\'s path', () => {
  it('names it from the top down', () => {
    assert.equal(categoryPath(tree, 'burgers'), 'אוכל › מנות › המבורגרים');
    assert.equal(categoryPath(tree, 'deals'), 'מבצעים');
    assert.equal(categoryPath(tree, 'nobody'), '');
  });

  it('stops at a loop', () => {
    assert.equal(categoryPath([{ id: 'a', name: 'א', parentId: 'b' }, { id: 'b', name: 'ב', parentId: 'a' }], 'a'), 'ב › א');
  });
});
