/**
 * Run with `npm test`. "תחזית ואיוש" — the forecast card's pure rules (lib/staffing.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hourLabel, openingSpan, peakRanges, pickShop, shekels, staffingNotes, type StaffingHour, type StaffingReport, type StaffingShop } from './staffing';

const hour = (h: number, tills: number, docs = 5): StaffingHour => ({ hour: h, net: docs * 1000, docs, tills, short: false });

const shop = (id: string, net: number | null, over: Partial<StaffingShop['tomorrow']> = {}, capacitySource: 'history' | 'default' = 'history'): StaffingShop => ({
  shopId: id,
  shopName: id,
  availableTills: 3,
  capacityPerTill: 20,
  capacitySource,
  cashierShare: 1,
  trendFactor: 1,
  historyStart: null,
  today: { date: '2026-09-27', pacePct: null, factor: 1, factorSource: 'none', actual: 0, nextHours: [], nextHoursNet: 0 },
  tomorrow: {
    date: '2026-09-28', weekday: 1, net, docs: null, low: null, high: null, confidence: 'high', holiday: null,
    hourly: [], peakTills: 0, short: false, ...over,
  },
});

describe('money and hours', () => {
  it('turns agorot into shekels and hours into labels', () => {
    assert.equal(shekels(12345), 123.45);
    assert.equal(shekels(null), null);
    assert.equal(hourLabel(9), '09:00');
    assert.equal(hourLabel(24), '00:00');
  });
});

describe('which shop', () => {
  it('shows the asked shop, else the busiest tomorrow', () => {
    const report = { shops: [shop('a', 100), shop('b', 500), shop('c', null)] } as StaffingReport;
    assert.equal(pickShop(report, 'a')?.shopId, 'a');
    assert.equal(pickShop(report)?.shopId, 'b');
    assert.equal(pickShop(report, 'zzz')?.shopId, 'a');
    assert.equal(pickShop({ shops: [] } as unknown as StaffingReport), null);
  });
});

describe('the peaks and the span', () => {
  it('merges the busiest hours into ranges', () => {
    const hours = [hour(10, 1), hour(11, 3), hour(12, 3), hour(13, 2), hour(18, 3)];
    assert.deepEqual(peakRanges(hours), ['11:00–13:00', '18:00–19:00']);
    assert.deepEqual(peakRanges([hour(10, 0, 0)]), []);
  });

  it('opens at the first busy hour and closes after the last', () => {
    assert.deepEqual(openingSpan([hour(8, 0, 0), hour(9, 1), hour(22, 1)]), { from: '09:00', to: '23:00' });
    assert.equal(openingSpan([]), null);
  });
});

describe('the notes', () => {
  it('warns about short tills, missing history, a guessed capacity and a holiday', () => {
    assert.deepEqual(staffingNotes(shop('a', null)), ['noHistory']);
    assert.deepEqual(staffingNotes(shop('a', 100, { short: true }, 'default')), ['defaultCapacity', 'short']);
    assert.deepEqual(staffingNotes(shop('a', 100, { holiday: { name: 'חג', factor: 0.3 } })), ['holiday']);
  });
});
