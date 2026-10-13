/**
 * Run with `npm test`. "חסימה מהירה" on the phone and the full form's defaults from `quickDefaults`
 * (lib/quickBlock.ts; P:/specs/item-block-control.md §4).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { navHrefAllowed, pageAccess, sectionForPath, type DashboardAccess, type SectionId } from './dashboardAccess';
import type { QuickBlockRow, QuickDefaults, QuickItem, QuickList } from './itemBlockControl';
import {
  durationOfQuick,
  leftoverReasons,
  optimisticQuickItem,
  QUICK_BLOCK_PATH,
  quickUntilText,
  replaceQuickItem,
  scopedHref,
  sheetChannels,
  sheetLevel,
  tapOutcomeNote,
} from './quickBlock';

const QUICK: QuickDefaults = { channels: ['pos', 'kiosk', 'online', 'menu'], level: 'shop', duration: { mode: 'end_of_day' } };
const TILLS_ONLY: QuickDefaults = { channels: ['pos'], level: 'shop', duration: { mode: 'end_of_day' } };

function block(over: Partial<QuickBlockRow> = {}): QuickBlockRow {
  return {
    id: 'b1',
    kind: 'sold_out',
    level: 'shop',
    scopeName: 'תל אביב',
    channels: ['pos', 'kiosk', 'online', 'menu'],
    until: '2026-10-13T01:00:00+00:00',
    itemType: 'product',
    source: 'manual',
    ...over,
  };
}

function item(over: Partial<QuickItem> = {}): QuickItem {
  return {
    productId: 'p1',
    name: 'המבורגר',
    categoryName: 'עיקריות',
    state: 'available',
    until: null,
    scopeLevel: null,
    scopeName: null,
    blocks: [],
    ...over,
  };
}

describe('the full form takes the quick defaults', () => {
  it('maps the duration', () => {
    assert.deepEqual(durationOfQuick({ mode: 'end_of_day' }), { mode: 'end_of_day' });
    assert.deepEqual(durationOfQuick({ mode: 'none' }), { mode: 'none' });
    assert.deepEqual(durationOfQuick({ mode: 'minutes', minutes: 90 }), { mode: 'minutes', minutes: 90 });
    // Nothing usable: the form's own default.
    assert.deepEqual(durationOfQuick({ mode: 'minutes' }), { mode: 'end_of_day' });
    assert.deepEqual(durationOfQuick(undefined), { mode: 'end_of_day' });
  });

  it('takes the channels, kiosk alone for a kiosk, all four when there are none', () => {
    assert.deepEqual(sheetChannels({ channels: ['menu', 'pos'] }, false), ['pos', 'menu']);
    assert.deepEqual(sheetChannels({ channels: ['pos'] }, true), ['kiosk']);
    assert.deepEqual(sheetChannels(undefined, false), ['pos', 'kiosk', 'online', 'menu']);
    assert.deepEqual(sheetChannels({ channels: [] }, false), ['pos', 'kiosk', 'online', 'menu']);
  });

  it('takes the company level only when the form offers it', () => {
    assert.equal(sheetLevel({ level: 'company' }, true), 'company');
    assert.equal(sheetLevel({ level: 'company' }, false), 'shop');
    assert.equal(sheetLevel({ level: 'shop' }, true), 'shop');
    assert.equal(sheetLevel(undefined, true), 'shop');
  });
});

describe('a tap, before the server answers', () => {
  it('"אזל" / "חסום" shows the new state, its end left to the answer', () => {
    const out = optimisticQuickItem(item(), 'sold_out', QUICK);
    assert.equal(out.state, 'sold_out');
    assert.equal(out.until, null);
    assert.equal(optimisticQuickItem(item({ state: 'sold_out' }), 'blocked', QUICK).state, 'blocked');
  });

  it('"זמין" lifts the product\'s own blocks', () => {
    const out = optimisticQuickItem(item({ state: 'sold_out', until: 'x', scopeLevel: 'shop', blocks: [block()] }), 'available', QUICK);
    assert.equal(out.state, 'available');
    assert.deepEqual(out.blocks, []);
    assert.equal(out.until, null);
    assert.equal(out.scopeLevel, null);
  });

  it('"זמין" leaves a category\'s block, which still decides', () => {
    const cat = block({ id: 'c', kind: 'blocked', itemType: 'category', scopeName: 'סניף', until: null });
    const out = optimisticQuickItem(item({ state: 'blocked', blocks: [block(), cat] }), 'available', QUICK);
    assert.equal(out.state, 'blocked');
    assert.deepEqual(out.blocks.map((b) => b.id), ['c']);
    assert.equal(out.scopeName, 'סניף');
  });

  it('"זמין" on the tills alone leaves a block that reaches more — still "אזל" on the tills', () => {
    const wide = block({ id: 'w', channels: ['pos', 'kiosk'] });
    const out = optimisticQuickItem(item({ state: 'sold_out', blocks: [wide] }), 'available', TILLS_ONLY);
    assert.equal(out.state, 'sold_out');
  });

  it('"זמין" at the shop leaves the company\'s block', () => {
    const company = block({ id: 'co', level: 'company' });
    assert.equal(optimisticQuickItem(item({ state: 'sold_out', blocks: [company] }), 'available', QUICK).state, 'sold_out');
    assert.equal(optimisticQuickItem(item({ state: 'sold_out', blocks: [company] }), 'available', { ...QUICK, level: 'company' }).state, 'available');
  });
});

describe('the list', () => {
  const list: QuickList = { shop: { id: 's1', name: 'תל אביב' }, quickDefaults: QUICK, items: [item(), item({ productId: 'p2', name: 'צ׳יפס' })] };

  it('replaces the product\'s row', () => {
    const out = replaceQuickItem(list, item({ productId: 'p2', name: 'צ׳יפס', state: 'blocked' }), TILLS_ONLY)!;
    assert.equal(out.items[1].state, 'blocked');
    assert.equal(out.items[0], list.items[0]);
    assert.deepEqual(out.quickDefaults, TILLS_ONLY);
  });

  it('leaves another search alone, and nothing stays nothing', () => {
    assert.equal(replaceQuickItem(list, item({ productId: 'p9' })), list);
    assert.equal(replaceQuickItem(undefined, item()), undefined);
  });
});

describe('the words', () => {
  const now = Date.parse('2026-10-13T09:00:00+03:00');

  it('says until when', () => {
    assert.equal(quickUntilText(item(), now), null);
    assert.equal(quickUntilText(item({ state: 'sold_out', until: '2026-10-13T14:35:00+03:00' }), now), 'עד 14:35');
    assert.equal(quickUntilText(item({ state: 'sold_out', until: '2026-10-14T04:00:00+03:00' }), now), 'עד מחר 04:00');
    assert.equal(quickUntilText(item({ state: 'blocked', until: null }), now), 'עד ביטול');
  });

  it('names why blocks stay, each once', () => {
    const rows = [
      block({ itemType: 'category' }),
      block({ itemType: 'category', id: 'c2' }),
      block({ level: 'company' }),
      block({ channels: ['pos', 'online'] }),
    ];
    assert.deepEqual(leftoverReasons(rows, TILLS_ONLY), ['חסימת מחלקה', 'ערוצים נוספים', 'חסימת החברה']);
    assert.deepEqual(leftoverReasons([], QUICK), []);
    assert.deepEqual(leftoverReasons([block({ level: 'company' })], { ...QUICK, level: 'company' }), []);
  });

  it('notes a tap that ended elsewhere', () => {
    assert.equal(tapOutcomeNote('available', item()), null);
    assert.equal(tapOutcomeNote('available', null), null);
    assert.match(tapOutcomeNote('available', item({ state: 'sold_out' }))!, /נשארה חסימה/);
    assert.match(tapOutcomeNote('sold_out', item({ state: 'blocked' }))!, /חסימה אחרת/);
  });
});

describe('who opens the page', () => {
  const user = (sections: Partial<Record<SectionId, 'view' | 'edit'>>): DashboardAccess => ({ restricted: true, sections });

  it('the stock section, or "חסימות ואזל" without it', () => {
    assert.equal(pageAccess(user({ stock: 'view' }), QUICK_BLOCK_PATH), 'ok');
    assert.equal(pageAccess(user({ item_blocks: 'edit' }), QUICK_BLOCK_PATH), 'ok');
    assert.equal(pageAccess(user({ item_blocks: 'view' }), `${QUICK_BLOCK_PATH}/`), 'ok');
    assert.equal(navHrefAllowed(user({ item_blocks: 'view' }), `${QUICK_BLOCK_PATH}?shop=s1`), true);
    assert.equal(pageAccess(user({ reports: 'edit' }), QUICK_BLOCK_PATH), 'denied');
  });

  it('opens nothing else of the stock page', () => {
    assert.equal(pageAccess(user({ item_blocks: 'edit' }), '/dashboard/stock'), 'denied');
    assert.equal(navHrefAllowed(user({ item_blocks: 'edit' }), '/dashboard/stock'), false);
    assert.equal(sectionForPath(QUICK_BLOCK_PATH), 'stock');
  });
});

describe('the links keep the scope', () => {
  it('keeps the scope as it is', () => {
    assert.equal(scopedHref(QUICK_BLOCK_PATH, ''), '/dashboard/stock/quick-block');
    assert.equal(scopedHref(QUICK_BLOCK_PATH, '?company=c1&shop=s1'), '/dashboard/stock/quick-block?company=c1&shop=s1');
  });

  it('adds the shop a form picked when the scope names none', () => {
    assert.equal(
      scopedHref(QUICK_BLOCK_PATH, '?company=c0', { shop: { id: 's2', companyId: 'c2' } }),
      '/dashboard/stock/quick-block?company=c2&shop=s2',
    );
    // The scope's own shop wins.
    assert.equal(scopedHref(QUICK_BLOCK_PATH, '?shop=s1', { shop: { id: 's2' } }), '/dashboard/stock/quick-block?shop=s1');
  });

  it('adds the page\'s own params', () => {
    assert.equal(scopedHref('/dashboard/stock', '?shop=s1', { params: { tab: 'levels' } }), '/dashboard/stock?shop=s1&tab=levels');
  });
});
