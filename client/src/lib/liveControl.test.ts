/**
 * "שליטה חיה" — the sheets' pure parts: durations, countdowns, the block's line, the commands'
 * status words and the attention feed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  blockSummary,
  commandStatusLabel,
  durationValid,
  formatLeft,
  formatUntil,
  liveItemsFrom,
  parseHhmm,
  parseMinutes,
  presetLabel,
  secondsLeft,
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
    const b = { kind: 'sold_out' as const, scope: 'area' as const, scopeName: 'בר', until: '2026-10-09T09:47:00Z' };
    assert.equal(blockSummary(b, NOW), 'אזל · נקודת מכירה · בר · עד 12:47 (עוד 47 דק׳)');
    assert.equal(blockSummary({ ...b, kind: 'blocked', until: null }, NOW), 'חסום · נקודת מכירה · בר · עד שאבטל');
  });
});

describe('commands', () => {
  it('says what the till did', () => {
    assert.equal(commandStatusLabel('pending'), 'נשלח');
    assert.equal(commandStatusLabel('done'), 'בוצע בקופה');
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
    it('an open-ended block cannot be extended, an ended one is gone', () => {
    const items = liveItemsFrom([{ ...block, until: null }, { ...block, id: 'b2', inForce: false }], [], NOW);
    assert.deepEqual(items.map((i) => i.actions.map((a) => a.actionId)), [['block.clear']]);
  });
});
