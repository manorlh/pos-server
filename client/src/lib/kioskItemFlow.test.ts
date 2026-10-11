/**
 * Run with `npm test`. "תהליך פריט עם תוספות והערות" (lib/kioskItemFlow.ts, kiosk config `motion.itemFlow`): which
 * pages a dish gets page after page, where "הבא" / "הקודם" go, and the pictures an option and a note chip carry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  backFromPage,
  firstLackingPage,
  itemFlowOf,
  itemFlowPages,
  nextFromPage,
  noteImagesOf,
  optionImagesOf,
  usesItemPages,
} from './kioskItemFlow';
import { KIOSK_DEFAULTS, MOTION_ITEM_FLOWS, validateKioskConfig } from './kioskConfig';

const opt = (id: string) => ({ id });

describe('the config (motion.itemFlow)', () => {
  it('one window by default and for anything unknown; pages only when asked', () => {
    assert.equal(KIOSK_DEFAULTS.motion.itemFlow, 'sheet');
    assert.deepEqual(MOTION_ITEM_FLOWS, ['sheet', 'pages']);
    assert.equal(itemFlowOf(KIOSK_DEFAULTS), 'sheet');
    assert.equal(itemFlowOf({ motion: { itemFlow: 'pages' } }), 'pages');
    for (const v of [undefined, null, 'carousel', 1]) assert.equal(itemFlowOf({ motion: { itemFlow: v } }), 'sheet');
    assert.equal(itemFlowOf(null), 'sheet');
    assert.equal(itemFlowOf({}), 'sheet');
  });

  it('validation: the two codes pass, anything else is refused at motion.itemFlow; absent is fine (a config from before)', () => {
    const ok = (itemFlow: unknown) => validateKioskConfig({ ...KIOSK_DEFAULTS, motion: { ...KIOSK_DEFAULTS.motion, itemFlow } } as never);
    assert.equal(ok('pages').some((e) => e.path === 'motion.itemFlow'), false);
    assert.equal(ok('sheet').some((e) => e.path === 'motion.itemFlow'), false);
    assert.equal(ok(undefined).some((e) => e.path === 'motion.itemFlow'), false);
    assert.equal(ok('carousel').some((e) => e.path === 'motion.itemFlow'), true);
  });
});

describe('the pages of a dish (itemFlowPages)', () => {
  it('a page per group that has options, in the group order, then the notes page', () => {
    const groups = [{ id: 'doneness', options: [opt('r'), opt('m')] }, { id: 'empty', options: [] }, { id: 'extras', options: [opt('c')] }];
    assert.deepEqual(itemFlowPages(groups, ['בלי בצל']), [
      { kind: 'group', groupId: 'doneness', groupIndex: 0 },
      { kind: 'group', groupId: 'extras', groupIndex: 2 },
      { kind: 'notes' },
    ]);
  });

  it('no notes: no notes page; notes only: the notes page alone; neither: nothing (today\'s window)', () => {
    assert.deepEqual(itemFlowPages([{ id: 'g', options: [opt('a')] }], []), [{ kind: 'group', groupId: 'g', groupIndex: 0 }]);
    assert.deepEqual(itemFlowPages([{ id: 'g', options: [opt('a')] }], null), [{ kind: 'group', groupId: 'g', groupIndex: 0 }]);
    assert.deepEqual(itemFlowPages([], ['חריף']), [{ kind: 'notes' }]);
    assert.deepEqual(itemFlowPages([], []), []);
    assert.equal(usesItemPages('pages', []), false);
    assert.equal(usesItemPages('sheet', [{ kind: 'notes' }]), false);
    assert.equal(usesItemPages('pages', [{ kind: 'notes' }]), true);
  });
});

describe('moving through the pages', () => {
  const pages = itemFlowPages([{ id: 'req', options: [opt('a')] }, { id: 'opt', options: [opt('b')] }], ['x']);

  it('"הבא": a required group not answered stays; otherwise the next page, and the last one adds', () => {
    const lacking = (id: string) => id === 'req';
    assert.equal(nextFromPage(pages, 0, lacking), 'stay');
    assert.equal(nextFromPage(pages, 0, () => false), 1);
    assert.equal(nextFromPage(pages, 1, lacking), 2);
    assert.equal(nextFromPage(pages, 2, lacking), 'add');
    assert.equal(firstLackingPage(pages, lacking), 0);
    assert.equal(firstLackingPage(pages, () => false), null);
  });

  it('"הקודם": the previous page; from the first, back to the menu', () => {
    assert.equal(backFromPage(2), 1);
    assert.equal(backFromPage(0), 'close');
  });
});

describe('the pictures', () => {
  it('an option\'s picture by its id (its own, else its linked product\'s — as the cloud sends it)', () => {
    const groups = [
      { id: 'g', options: [{ id: 'a', imageUrl: 'https://x/a.png' }, { id: 'b', imageUrl: null }, { id: 'c' }] },
      { id: 'h', options: [{ id: 'd', imageUrl: 'https://x/d.png' }] },
    ];
    assert.deepEqual(optionImagesOf(groups), { a: 'https://x/a.png', d: 'https://x/d.png' });
    assert.deepEqual(optionImagesOf(null), {});
  });

  it('a note chip\'s picture by its text, from every dish\'s, the categories\' and the products\' chips', () => {
    const notes = {
      all: [{ text: 'אלרגיה', important: true, imageUrl: 'https://x/all.png' }, { text: 'חריף', important: false, imageUrl: null }],
      categories: { c1: [{ text: 'בלי רוטב', imageUrl: 'https://x/sauce.png' }] },
      products: { p1: [{ text: 'בלי בצל', imageUrl: 'https://x/onion.png' }] },
    };
    assert.deepEqual(noteImagesOf(notes), {
      'בלי בצל': 'https://x/onion.png',
      'בלי רוטב': 'https://x/sauce.png',
      'אלרגיה': 'https://x/all.png',
    });
    assert.deepEqual(noteImagesOf(undefined), {});
  });
});
