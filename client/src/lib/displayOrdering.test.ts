/**
 * Run with `npm test`. "סדר תצוגה" — moving ids in the editor (lib/displayOrdering.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_LEVELS,
  linkedText,
  moveItem,
  moveToPosition,
  orderingFromEditor,
  pinnedFirst,
  togglePinned,
} from './displayOrdering';

describe('levels', () => {
  it('a kiosk has no point of sale; the web has profiles', () => {
    assert.ok(!CHANNEL_LEVELS.kiosk.includes('area'));
    assert.ok(CHANNEL_LEVELS.online.includes('profile') && CHANNEL_LEVELS.menu.includes('profile'));
    assert.ok(!CHANNEL_LEVELS.pos.includes('profile'));
  });
});

describe('moving', () => {
  it('moves up / down, and leaves an out-of-range move alone', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
    assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
  });
  it('moves to a 1-based position, clamped', () => {
    assert.deepEqual(moveToPosition(['a', 'b', 'c', 'd'], 'd', 2), ['a', 'd', 'b', 'c']);
    assert.deepEqual(moveToPosition(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a']);
    assert.deepEqual(moveToPosition(['a', 'b', 'c'], 'x', 1), ['a', 'b', 'c']);
  });
});

describe('pins', () => {
  it('toggle, and pinned first in their own order', () => {
    assert.deepEqual(togglePinned(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(togglePinned(['a', 'b'], 'a'), ['b']);
    assert.deepEqual(pinnedFirst(['c', 'z', 'a'], ['a', 'b', 'c']), ['c', 'a', 'b']);
  });
});

describe('what is saved', () => {
  it('drops empty lists and keeps the pins', () => {
    assert.deepEqual(orderingFromEditor(['c1'], { c1: ['p1'], c2: [] }, { categories: [], products: { c1: ['p1'], c2: [] } }), {
      categories: ['c1'],
      products: { c1: ['p1'] },
      pinned: { categories: [], products: { c1: ['p1'] } },
      newItems: 'end',
    });
  });
  it('says what it is linked with', () => {
    assert.equal(linkedText({ linkedLabel: null, linkedWith: [] }), null);
    assert.equal(
      linkedText({ linkedLabel: null, linkedWith: [{ channel: 'kiosk', channelLabel: 'קיוסק', level: 'shop', levelLabel: 'סניף', targetId: 's', targetName: 'הרצליה' }] }),
      'מקושר לקיוסק (הרצליה)',
    );
  });
});
