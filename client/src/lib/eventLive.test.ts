/**
 * Run with `npm test`. "מצב אירוע חי" — the live screen's pure rules (lib/eventLive.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ablySseUrl,
  autoOpenEvent,
  bigMoney,
  chartRows,
  compactMoney,
  kdsTone,
  liveRefetchMs,
  minutesText,
  orderTills,
  paceTone,
  parseTargetInput,
  progressFill,
  type CurrentLiveEvent,
  type LiveTill,
} from './eventLive';

describe('refreshing', () => {
  it('polls fast while live, slower with push, slow otherwise', () => {
    assert.equal(liveRefetchMs('live', false), 15_000);
    assert.equal(liveRefetchMs('live', true), 60_000);
    assert.equal(liveRefetchMs('upcoming', false), 60_000);
    assert.equal(liveRefetchMs('ended', false), 300_000);
    assert.equal(liveRefetchMs(undefined, false), 300_000);
  });

  it('builds the Ably SSE url with the token and the channel', () => {
    const url = new URL(ablySseUrl('dash:t:event:e', 'tok'));
    assert.equal(url.host, 'realtime.ably.io');
    assert.equal(url.searchParams.get('channels'), 'dash:t:event:e');
    assert.equal(url.searchParams.get('accessToken'), 'tok');
  });
});

describe('words', () => {
  it('says minutes, hours and days', () => {
    assert.equal(minutesText(45.4), '45 דק׳');
    assert.equal(minutesText(125), '2:05 שע׳');
    assert.equal(minutesText(3 * 24 * 60), '3 ימים');
    assert.equal(minutesText(-3), '0 דק׳');
    assert.equal(minutesText(null), '—');
  });

  it('formats money for the big screen and the axes', () => {
    assert.equal(bigMoney(12480.6), '₪12,481');
    assert.equal(bigMoney(-40), '−₪40');
    assert.equal(bigMoney(null), '—');
    assert.equal(compactMoney(950), '₪950');
    assert.equal(compactMoney(12_500), '₪12.5K');
    assert.equal(compactMoney(1_250_000), '₪1.3M');
  });
});

describe('the chart', () => {
  it('labels by the event clock and keeps a running total', () => {
    const rows = chartRows(
      [
        { at: '2026-09-27T15:00:00+00:00', net: 100, docs: 2 },
        { at: '2026-09-27T15:05:00+00:00', net: -40, docs: 1 },
        { at: '2026-09-27T15:10:00+00:00', net: 0, docs: 0 },
      ],
      'Asia/Jerusalem',
    );
    assert.deepEqual(rows.map((r) => r.label), ['18:00', '18:05', '18:10']);
    assert.deepEqual(rows.map((r) => r.cumulative), [100, 60, 60]);
  });

  it('fills the bar from 0 to 100 only', () => {
    assert.equal(progressFill(42.5), 42.5);
    assert.equal(progressFill(140), 100);
    assert.equal(progressFill(-3), 0);
    assert.equal(progressFill(null), 0);
  });
});

describe('tones', () => {
  const target = { amount: 1000, source: 'event' as const, progressPct: 50, remaining: 500, reached: false, etaMinutes: 10, etaAt: null, onPace: true };
  const pace = (projected: number | null) => ({ projected, low: null, high: null, ratePerHour: null, recentRatePerHour: null, averageRatePerHour: null });

  it('judges the pace against the target', () => {
    assert.equal(paceTone({ phase: 'live', target, pace: pace(1200) }), 'good');
    assert.equal(paceTone({ phase: 'live', target, pace: pace(950) }), 'warn');
    assert.equal(paceTone({ phase: 'live', target, pace: pace(500) }), 'bad');
    assert.equal(paceTone({ phase: 'live', target: { ...target, reached: true }, pace: pace(10) }), 'good');
    assert.equal(paceTone({ phase: 'live', target: null, pace: pace(10) }), 'neutral');
    assert.equal(paceTone({ phase: 'upcoming', target, pace: pace(null) }), 'neutral');
  });

  it('judges the kitchen', () => {
    const kds = { openOrders: 3, avgWaitMinutes: 5, oldestWaitMinutes: 6, lateOrders: 0, lateMinutes: 20, readyLastHour: 4, avgPrepMinutesLastHour: 8, maxPrepMinutesLastHour: 12 };
    assert.equal(kdsTone(kds), 'good');
    assert.equal(kdsTone({ ...kds, oldestWaitMinutes: 11 }), 'warn');
    assert.equal(kdsTone({ ...kds, lateOrders: 1 }), 'bad');
    assert.equal(kdsTone(null), 'neutral');
  });
});

describe('tills and events', () => {
  const till = (name: string, online: boolean, net: number): LiveTill => ({
    machineId: name, name, posNumber: null, online, lastSeenAt: null, net, sales: 0, docs: 0, lastSaleAt: null,
    pendingDocuments: null, pendingAsOf: null,
  });

  it('puts offline tills first, then the busiest', () => {
    const out = orderTills([till('a', true, 10), till('b', false, 1), till('c', true, 50)]);
    assert.deepEqual(out.map((t) => t.name), ['b', 'c', 'a']);
  });

  it('opens the only live event straight away', () => {
    const ev = (id: string, phase: CurrentLiveEvent['phase']) => ({ id, phase }) as CurrentLiveEvent;
    assert.equal(autoOpenEvent([ev('a', 'live'), ev('b', 'upcoming')]), 'a');
    assert.equal(autoOpenEvent([ev('a', 'live'), ev('b', 'live')]), null);
    assert.equal(autoOpenEvent([ev('b', 'ended')]), null);
  });
});

describe('the typed target', () => {
  it('reads shekels with commas and a sign, refuses the rest', () => {
    assert.equal(parseTargetInput('12,500'), 12500);
    assert.equal(parseTargetInput('₪ 1500.5'), 1500.5);
    assert.equal(parseTargetInput(''), null);
    assert.equal(parseTargetInput('0'), undefined);
    assert.equal(parseTargetInput('-5'), undefined);
    assert.equal(parseTargetInput('12a'), undefined);
    assert.equal(parseTargetInput('1.234'), undefined);
  });
});
