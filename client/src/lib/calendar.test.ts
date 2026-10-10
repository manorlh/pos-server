/**
 * Run with `npm test`. The Hebrew date picker's model (lib/calendar.ts): Sunday-first
 * month grids, the quick ranges, and the min/max rule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inRange, matchingPreset, monthGrid, monthOf, outOfBounds, presetRange, shiftMonth } from './calendar';

describe('monthGrid', () => {
  it('starts every week on Sunday', () => {
    // 1 October 2026 is a Thursday.
    const weeks = monthGrid({ year: 2026, month: 10 });
    assert.equal(weeks.length, 6);
    assert.equal(weeks[0][0].iso, '2026-09-27');
    assert.equal(weeks[0][4].iso, '2026-10-01');
    assert.equal(weeks[0][4].inMonth, true);
    assert.equal(weeks[0][3].inMonth, false);
    for (const week of weeks) {
      assert.equal(week.length, 7);
      assert.equal(new Date(`${week[0].iso}T00:00:00Z`).getUTCDay(), 0);
    }
  });

  it('holds every day of the month once', () => {
    const days = monthGrid({ year: 2028, month: 2 }).flat().filter((d) => d.inMonth);
    assert.equal(days.length, 29);
    assert.equal(days[0].iso, '2028-02-01');
    assert.equal(days[28].iso, '2028-02-29');
  });

  it('runs straight through the October clock change', () => {
    const days = monthGrid({ year: 2026, month: 10 }).flat().map((d) => d.iso);
    assert.ok(days.includes('2026-10-25'));
    assert.ok(days.includes('2026-10-26'));
    assert.equal(new Set(days).size, 42);
  });
});

describe('months', () => {
  it('moves over year ends', () => {
    assert.deepEqual(shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 10 }, -12), { year: 2025, month: 10 });
    assert.deepEqual(monthOf('2026-10-07'), { year: 2026, month: 10 });
    assert.equal(monthOf('07/10/2026'), null);
  });
});

describe('bounds and ranges', () => {
  it('refuses days outside min/max', () => {
    assert.equal(outOfBounds('2026-10-07', '2026-10-01', '2026-10-31'), false);
    assert.equal(outOfBounds('2026-09-30', '2026-10-01'), true);
    assert.equal(outOfBounds('2026-11-01', undefined, '2026-10-31'), true);
    assert.equal(outOfBounds('2026-11-01'), false);
  });

  it('shades from..to inclusive', () => {
    const r = { from: '2026-10-01', to: '2026-10-07' };
    assert.equal(inRange('2026-10-01', r), true);
    assert.equal(inRange('2026-10-07', r), true);
    assert.equal(inRange('2026-10-08', r), false);
    assert.equal(inRange('2026-10-03', { from: '2026-10-01', to: '' }), false);
  });
});

describe('quick ranges', () => {
  const today = '2026-10-07'; // a Wednesday

  it('gives the Israeli week, Sunday to Saturday', () => {
    assert.deepEqual(presetRange('thisWeek', today), { from: '2026-10-04', to: today });
    assert.deepEqual(presetRange('lastWeek', today), { from: '2026-09-27', to: '2026-10-03' });
    // On a Sunday "this week" is just today.
    assert.deepEqual(presetRange('thisWeek', '2026-10-04'), { from: '2026-10-04', to: '2026-10-04' });
  });

  it('gives days and months', () => {
    assert.deepEqual(presetRange('today', today), { from: today, to: today });
    assert.deepEqual(presetRange('yesterday', today), { from: '2026-10-06', to: '2026-10-06' });
    assert.deepEqual(presetRange('last7', today), { from: '2026-10-01', to: today });
    assert.deepEqual(presetRange('last30', today), { from: '2026-09-08', to: today });
    assert.deepEqual(presetRange('thisMonth', today), { from: '2026-10-01', to: today });
    assert.deepEqual(presetRange('lastMonth', today), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(presetRange('lastMonth', '2026-03-31'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(presetRange('lastMonth', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
    assert.deepEqual(presetRange('thisYear', today), { from: '2026-01-01', to: today });
    assert.deepEqual(presetRange('yesterday', '2026-01-01'), { from: '2025-12-31', to: '2025-12-31' });
  });

  it('keeps inside the field bounds', () => {
    assert.deepEqual(presetRange('last30', today, '2026-10-01'), { from: '2026-10-01', to: today });
    assert.deepEqual(presetRange('thisMonth', today, undefined, '2026-10-05'), { from: '2026-10-01', to: '2026-10-05' });
  });

  it('recognises a range that is a quick range', () => {
    assert.equal(matchingPreset({ from: '2026-10-01', to: today }, today), 'last7');
    assert.equal(matchingPreset({ from: '2026-09-01', to: '2026-09-30' }, today), 'lastMonth');
    assert.equal(matchingPreset({ from: '2026-09-02', to: '2026-09-30' }, today), null);
    assert.equal(matchingPreset({ from: '', to: '' }, today), null);
  });
});
