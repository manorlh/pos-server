/**
 * "שליטה חיה" — the sheets' pure parts: durations, countdowns, the block's line, the commands'
 * status words and the attention feed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BLOCK_CHANNELS,
  blockSummary,
  CHANNEL_LABELS,
  channelsLabel,
  channelsOf,
  commandStatusLabel,
  durationValid,
  formatLeft,
  formatUntil,
  itemLabel,
  KIOSK_DISPLAY_LABELS,
  kioskDisplayLabel,
  levelLabel,
  levelOf,
  liveItemsFrom,
  ORIGIN_LABELS,
  originLabel,
  parseHhmm,
  parseMinutes,
  presetLabel,
  secondsLeft,
  TARGET_LABELS,
  targetForChannels,
  targetOf,
  type DeviceRow,
  type ItemBlock,
} from './liveControl';

const NOW = Date.parse('2026-10-09T09:00:00Z'); // 12:00 in Israel

describe('durations', () => {
  it('names the presets', () => {
    assert.deepEqual([15, 30, 60, 120, 240].map(presetLabel), ['15 דק׳', '30 דק׳', 'שעה', 'שעתיים', '4 שעות']);
  });
  it('reads custom minutes and an until time', () => {
    assert.equal(parseMinutes('45'), 45);
    assert.equal(parseMinutes('0'), null);
    assert.equal(parseMinutes('abc'), null);
    assert.equal(parseMinutes('20000'), null);
    assert.equal(parseHhmm('9:05'), '09:05');
    assert.equal(parseHhmm('24:00'), null);
    assert.equal(durationValid({ mode: 'time', at: '14:35' }), true);
    assert.equal(durationValid({ mode: 'time', at: '14:3' }), false);
    assert.equal(durationValid({ mode: 'minutes', minutes: 0 }), false);
    assert.equal(durationValid({ mode: 'none' }), true);
  });
});

describe('countdown', () => {
  it('counts down in minutes and hours', () => {
    assert.equal(formatLeft(secondsLeft('2026-10-09T09:47:00Z', NOW)), 'עוד 47 דק׳');
    assert.equal(formatLeft(secondsLeft('2026-10-09T11:05:00Z', NOW)), 'עוד 2 ש׳ 5 דק׳');
    assert.equal(formatLeft(secondsLeft('2026-10-09T09:00:30Z', NOW)), 'עוד פחות מדקה');
    assert.equal(formatLeft(secondsLeft('2026-10-09T08:00:00Z', NOW)), 'הסתיים');
    assert.equal(formatLeft(secondsLeft(null, NOW)), null);
  });
  it('shows the end in the shop zone, tomorrow said so', () => {
    assert.equal(formatUntil('2026-10-09T11:35:00Z', NOW), '14:35');
    assert.equal(formatUntil('2026-10-10T02:00:00Z', NOW), 'מחר 05:00');
  });
  it('one line per block', () => {
    const b = { kind: 'sold_out' as const, scope: 'area' as const, scopeName: 'בר', until: '2026-10-09T09:47:00Z', channels: [...BLOCK_CHANNELS] };
    assert.equal(blockSummary(b, NOW), 'אזל · נקודת מכירה · בר · עד 12:47 (עוד 47 דק׳)');
    assert.equal(blockSummary({ ...b, kind: 'blocked', until: null }, NOW), 'חסום · נקודת מכירה · בר · עד ביטול');
  });
  it('says the channels when they are not all four', () => {
    const b = { kind: 'sold_out' as const, scope: 'area' as const, scopeName: 'בר', until: '2026-10-09T09:47:00Z' };
    assert.equal(blockSummary({ ...b, channels: ['kiosk'] }, NOW), 'אזל · נקודת מכירה · בר · רק קיוסק · עד 12:47 (עוד 47 דק׳)');
    assert.equal(
      blockSummary({ ...b, channels: ['menu', 'kiosk'], until: null }, NOW),
      'אזל · נקודת מכירה · בר · רק קיוסק ותפריט דיגיטלי · עד ביטול',
    );
    assert.equal(
      blockSummary({ ...b, channels: ['pos', 'kiosk', 'online'], until: null }, NOW),
      'אזל · נקודת מכירה · בר · רק קופה, קיוסק והזמנות אונליין · עד ביטול',
    );
    // Written before channels: its target — "all" is the tills and the kiosks, not online nor the menu.
    assert.equal(blockSummary({ ...b, target: 'tills', until: null }, NOW), 'אזל · נקודת מכירה · בר · רק קופה · עד ביטול');
    assert.equal(blockSummary({ ...b, target: 'all' }, NOW), 'אזל · נקודת מכירה · בר · רק קופה וקיוסק · עד 12:47 (עוד 47 דק׳)');
    assert.equal(blockSummary(b, NOW), 'אזל · נקודת מכירה · בר · רק קופה וקיוסק · עד 12:47 (עוד 47 דק׳)');
    // An older "כל הקיוסקים בסניף": the shop, kiosks only.
    assert.equal(
      blockSummary({ kind: 'blocked', scope: 'kiosks', scopeName: 'הרצליה', until: null }, NOW),
      'חסום · סניף · הרצליה · רק קיוסק · עד ביטול',
    );
  });
});

describe('channels', () => {
  it('are the four, in order, with their words', () => {
    assert.deepEqual([...BLOCK_CHANNELS], ['pos', 'kiosk', 'online', 'menu']);
    assert.deepEqual(CHANNEL_LABELS, { pos: 'קופה', kiosk: 'קיוסק', online: 'הזמנות אונליין', menu: 'תפריט דיגיטלי' });
  });
  it('reads the block\'s own channels, in order, unknown ones dropped', () => {
    assert.deepEqual(channelsOf({ scope: 'shop', channels: ['menu', 'pos'] }), ['pos', 'menu']);
    assert.deepEqual(channelsOf({ scope: 'shop', channels: ['online', 'web', 'online'] }), ['online']);
    assert.deepEqual(channelsOf({ scope: 'shop', channels: [] }), []);
    // The channels win over the derived target.
    assert.deepEqual(channelsOf({ scope: 'area', target: 'none', channels: ['online', 'menu'] }), ['online', 'menu']);
    assert.deepEqual(channelsOf({ scope: 'area', target: 'all', channels: [...BLOCK_CHANNELS] }), ['pos', 'kiosk', 'online', 'menu']);
  });
  it('reads a block without channels by its target: all = קופה + קיוסק, never online nor the menu', () => {
    assert.deepEqual(channelsOf({ scope: 'shop' }), ['pos', 'kiosk']);
    assert.deepEqual(channelsOf({ scope: 'shop', target: 'all' }), ['pos', 'kiosk']);
    assert.deepEqual(channelsOf({ scope: 'area', target: 'kiosks' }), ['kiosk']);
    assert.deepEqual(channelsOf({ scope: 'machine', target: 'tills' }), ['pos']);
    assert.deepEqual(channelsOf({ scope: 'shop', target: 'none', channels: null }), []);
  });
  it('reads the older kiosks / kiosk scopes as the kiosks only', () => {
    assert.deepEqual(channelsOf({ scope: 'kiosks' }), ['kiosk']);
    assert.deepEqual(channelsOf({ scope: 'kiosk', target: 'all' }), ['kiosk']);
    assert.deepEqual(channelsOf({ scope: 'kiosks', target: 'tills' }), []);
    assert.deepEqual(channelsOf({ scope: 'kiosk', channels: ['pos', 'kiosk', 'menu'] }), ['kiosk']);
  });
  it('derives the devices\' target from the channels', () => {
    assert.equal(targetForChannels(['pos', 'kiosk', 'online', 'menu']), 'all');
    assert.equal(targetForChannels(['kiosk', 'menu']), 'kiosks');
    assert.equal(targetForChannels(['pos']), 'tills');
    assert.equal(targetForChannels(['online', 'menu']), 'none');
    assert.equal(targetOf({ scope: 'shop', channels: ['online'] }), 'none');
    assert.equal(targetOf({ scope: 'shop', target: 'tills', channels: ['kiosk'] }), 'kiosks');
  });
  it('names them: all four, some, none', () => {
    assert.equal(channelsLabel(['pos', 'kiosk', 'online', 'menu']), 'כל הערוצים');
    assert.equal(channelsLabel(['menu', 'kiosk']), 'קיוסק · תפריט דיגיטלי');
    assert.equal(channelsLabel(['pos', 'kiosk']), 'קופה · קיוסק');
    assert.equal(channelsLabel(['online']), 'הזמנות אונליין');
    assert.equal(channelsLabel([]), 'אף ערוץ');
  });
});

describe('targets and levels', () => {
  it('reads the older kiosk scopes as kiosks only, at shop / machine', () => {
    assert.equal(targetOf({ scope: 'kiosks' }), 'kiosks');
    assert.equal(targetOf({ scope: 'kiosk', target: 'all' }), 'kiosks');
    assert.equal(targetOf({ scope: 'shop' }), 'all');
    assert.equal(targetOf({ scope: 'area', target: 'tills' }), 'tills');
    assert.equal(targetOf({ scope: 'machine', target: 'kiosks' }), 'kiosks');
    assert.equal(levelOf({ scope: 'kiosks' }), 'shop');
    assert.equal(levelOf({ scope: 'kiosk' }), 'machine');
    assert.equal(levelOf({ scope: 'area' }), 'area');
    assert.equal(levelOf({ scope: 'kiosks', level: 'shop' }), 'shop');
  });
  it('names the level and its place', () => {
    assert.equal(levelLabel({ scope: 'machine', scopeName: 'קופה 3' }), 'מכשיר · קופה 3');
    assert.equal(levelLabel({ scope: 'kiosk', scopeName: 'קיוסק 2' }), 'קיוסק · קיוסק 2');
    assert.equal(levelLabel({ scope: 'company', scopeName: null }), 'חברה');
  });
  it('labels the targets, the kiosk look and the origin', () => {
    assert.deepEqual(TARGET_LABELS, { all: 'קופות וקיוסקים', kiosks: 'קיוסקים בלבד', tills: 'קופות בלבד', none: 'אונליין ותפריט בלבד' });
    assert.equal(kioskDisplayLabel(null), 'לפי הגדרת הקיוסק');
    assert.equal(kioskDisplayLabel('hide'), 'הסתר');
    assert.equal(kioskDisplayLabel('grey'), 'הצג כאזל');
    assert.equal(KIOSK_DISPLAY_LABELS.null, 'לפי הגדרת הקיוסק');
    assert.equal(originLabel('dashboard'), 'דשבורד');
    assert.equal(originLabel('controller'), 'קופה שולטת');
    assert.equal(originLabel('kiosk_hide'), 'מוסתר בקיוסקים');
    assert.equal(originLabel(null), null);
    assert.equal(ORIGIN_LABELS.stock, 'מלאי');
  });
  it('names the item: a product, or a whole category', () => {
    assert.equal(itemLabel({ productId: 'p', productName: 'קולה', itemType: 'product', itemName: 'קולה' }), 'קולה');
    assert.equal(itemLabel({ productId: null, productName: null, itemType: 'category', itemName: 'שתייה' }), 'מחלקה · שתייה');
    // From an older server: no itemType, no product → a category.
    assert.equal(itemLabel({ productId: null, productName: null, categoryName: 'גריל' }), 'מחלקה · גריל');
    assert.equal(itemLabel({ productId: 'p', productName: 'קולה' }), 'קולה');
  });
});

describe('commands', () => {
  it('says what the till did', () => {
    assert.equal(commandStatusLabel('pending'), 'נשלח');
    assert.equal(commandStatusLabel('done'), 'בוצע בקופה');
    assert.equal(commandStatusLabel('expired', 'not_answered'), 'נמסר ולא נענה (פג תוקף)');
    assert.equal(commandStatusLabel('refused', 'sale_in_progress'), 'נדחה: באמצע מכירה');
    assert.equal(commandStatusLabel('refused', 'no_update'), 'נדחה: אין עדכון מוכן');
  });
});

describe('the attention feed', () => {
  const block: ItemBlock = {
    id: 'b1', scope: 'shop', scopeId: 's', kind: 'sold_out', source: 'manual', until: '2026-10-09T09:30:00Z',
    createdAt: null, by: 'דנה', note: null, productId: 'p', productName: 'קולה', shopId: 's', scopeName: 'הרצליה',
    secondsLeft: 1800, inForce: true,
  };
  const device: DeviceRow = {
    machineId: 'm', name: 'קופה 1', isKiosk: false, online: true,
    state: { locked: true, message: 'פנו למנהל', lockedAt: null, lockedBy: null },
    open: [],
    recent: [{ id: 'c1', machineId: 'm', action: 'restart_app', status: 'refused', detail: 'sale_in_progress', createdAt: null }],
  };
  it('lists blocks with extend and clear, locks and refused commands', () => {
    const items = liveItemsFrom([block], [device], NOW);
    assert.deepEqual(items.map((i) => i.id), ['block:b1', 'lock:m', 'cmd:c1']);
    assert.deepEqual(items[0].actions.map((a) => a.actionId), ['block.extend', 'block.extend', 'block.extend', 'block.clear']);
    assert.equal(items[2].body, 'נדחה: באמצע מכירה');
  });
  it('every action names a label the messages have', () => {
    const he = JSON.parse(readFileSync('src/messages/he.json', 'utf8')) as Record<string, Record<string, string>>;
    const keys = liveItemsFrom([block], [device], NOW).flatMap((i) => i.actions.map((a) => a.labelKey));
    for (const k of keys) {
      const [ns, key] = k.split('.');
      assert.ok(he[ns]?.[key], k);
    }
  });
  it('a category block is titled by its category, a kiosk-only one says so', () => {
    const [item] = liveItemsFrom(
      [{ ...block, kind: 'blocked', productId: null, productName: null, itemType: 'category', itemName: 'גריל', categoryId: 'c', target: 'kiosks', channels: ['kiosk'], until: null }],
      [],
      NOW,
    );
    assert.equal(item.title, 'חסום · מחלקה · גריל');
    assert.equal(item.body, 'חסום · סניף · הרצליה · רק קיוסק · עד ביטול');
  });
    it('an open-ended block cannot be extended, an ended one is gone', () => {
    const items = liveItemsFrom([{ ...block, until: null }, { ...block, id: 'b2', inForce: false }], [], NOW);
    assert.deepEqual(items.map((i) => i.actions.map((a) => a.actionId)), [['block.clear']]);
  });
});
