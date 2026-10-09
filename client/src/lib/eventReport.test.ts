/**
 * Run with `npm test`. The event report's pure rules (lib/eventReport.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_THRESHOLDS,
  clockLabel,
  compareIds,
  countByLevel,
  cumulative,
  durationText,
  formDurationMinutes,
  rebucket,
  sortInsights,
  timelineRows,
  validateEventForm,
} from './eventReport';
import type { EventFormValues, EventInsight, TimelineBucket } from './eventTypes';

const bucket = (start: string, net: number, byTill: Record<string, number> = {}, count = 1): TimelineBucket => ({
  start,
  net,
  count,
  byTill,
});

// 18:00–19:00 Israel (UTC+3) in quarter hours.
const quarterHours = [
  bucket('2026-09-27T15:00:00+00:00', 10.1, { a: 10.1 }),
  bucket('2026-09-27T15:15:00+00:00', 20.2, { a: 20.2 }),
  bucket('2026-09-27T15:30:00+00:00', 0, {}, 0),
  bucket('2026-09-27T15:45:00+00:00', 0.3, { b: 0.3 }),
  bucket('2026-09-27T16:00:00+00:00', 5, { a: 2, b: 3 }, 2),
];

describe('rebucket', () => {
  it('keeps 15-minute buckets as they are', () => {
    assert.deepEqual(rebucket(quarterHours, 15), quarterHours);
  });

  it('sums quarter hours into half hours on the clock, to the agora', () => {
    const half = rebucket(quarterHours, 30);
    assert.equal(half.length, 3);
    assert.equal(half[0].start, '2026-09-27T15:00:00.000Z');
    assert.equal(half[0].net, 30.3);
    assert.equal(half[0].count, 2);
    assert.deepEqual(half[0].byTill, { a: 30.3 });
    assert.equal(half[1].net, 0.3);
    assert.deepEqual(half[2].byTill, { a: 2, b: 3 });
  });

  it('sums into hours that start on the hour', () => {
    const hours = rebucket(quarterHours, 60);
    assert.deepEqual(hours.map((h) => h.net), [30.6, 5]);
    assert.deepEqual(hours.map((h) => h.count), [3, 2]);
  });
});

describe('the chart rows', () => {
  it('carries a running total and a column per till', () => {
    assert.deepEqual(cumulative(quarterHours), [10.1, 30.3, 30.3, 30.6, 35.6]);
    const rows = timelineRows(quarterHours, ['a', 'b'], (iso) => clockLabel(iso, 'Asia/Jerusalem'));
    assert.equal(rows[0].label, '18:00');
    assert.equal(rows[3].b, 0.3);
    assert.equal(rows[2].a, 0);
    assert.equal(rows[4].cumulative, 35.6);
  });
});

describe('clockLabel', () => {
  it('writes the time in the event timezone, with the date when asked', () => {
    assert.equal(clockLabel('2026-09-27T15:00:00Z', 'Asia/Jerusalem'), '18:00');
    assert.equal(clockLabel('2026-09-27T21:30:00Z', 'Asia/Jerusalem', true), '28/09 00:30');
    assert.equal(clockLabel(null, 'Asia/Jerusalem'), '—');
  });
});

describe('durationText', () => {
  it('reads minutes and hours', () => {
    assert.equal(durationText(45), '45 דק׳');
    assert.equal(durationText(125), '2:05 שע׳');
  });
});

const form = (over: Partial<EventFormValues> = {}): EventFormValues => ({
  name: 'במה ראשית',
  startDate: '2026-09-27',
  startTime: '18:00',
  endDate: '2026-09-27',
  endTime: '23:00',
  machineIds: ['m1'],
  producerName: '',
  notes: '',
  thresholds: { ...DEFAULT_THRESHOLDS },
  ...over,
});

describe('validateEventForm', () => {
  it('accepts a complete form', () => {
    assert.deepEqual(validateEventForm(form()), []);
    assert.equal(formDurationMinutes(form()), 300);
  });

  it('requires the name, both dates and both hours, and a till', () => {
    assert.deepEqual(validateEventForm(form({ name: ' ', startTime: '', endDate: '', machineIds: [] })), [
      'nameRequired',
      'startRequired',
      'endRequired',
      'tillsRequired',
    ]);
  });

  it('wants the end after the start and at most 14 days later', () => {
    assert.deepEqual(validateEventForm(form({ endTime: '18:00' })), ['endBeforeStart']);
    assert.deepEqual(validateEventForm(form({ endDate: '2026-10-11', endTime: '18:01' })), ['tooLong']);
    // Over midnight is fine.
    assert.deepEqual(validateEventForm(form({ endDate: '2026-09-28', endTime: '02:00' })), []);
  });

  it('checks the thresholds', () => {
    assert.deepEqual(
      validateEventForm(form({ thresholds: { ...DEFAULT_THRESHOLDS, weakTillPct: 0 } })),
      ['thresholdRange'],
    );
    assert.deepEqual(validateEventForm(form({ thresholds: { ...DEFAULT_THRESHOLDS, highTipAmount: 50 } })), []);
  });
});

const insight = (id: string, level: EventInsight['level']): EventInsight => ({
  id,
  code: id,
  level,
  text: id,
  params: {},
  ref: null,
});

describe('insights', () => {
  it('orders alerts, then warnings, then information, keeping the order inside a level', () => {
    const sorted = sortInsights([insight('i1', 'info'), insight('w1', 'warning'), insight('a1', 'alert'), insight('w2', 'warning')]);
    assert.deepEqual(sorted.map((i) => i.id), ['a1', 'w1', 'w2', 'i1']);
    assert.deepEqual(countByLevel(sorted), { alert: 1, warning: 2, info: 1 });
  });
});

describe('compareIds', () => {
  it('needs two different events', () => {
    assert.equal(compareIds(['a']), null);
    assert.equal(compareIds(['a', 'a']), null);
    assert.equal(compareIds(['a', 'b']), 'a,b');
  });
});
