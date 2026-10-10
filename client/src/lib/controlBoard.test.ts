/**
 * Run with `npm test`. The control board's rules (lib/controlBoard.ts): the days it
 * compares, the change, the scope's figures, the hours, the tenders, the best sellers
 * and which tills it raises an alert for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZERO_FIGURES,
  alertTills,
  averageTicket,
  boardDays,
  compareItems,
  deltaTone,
  mergeHourly,
  parseBoardParams,
  parseIsoDay,
  pctChange,
  peakHour,
  scopeFigures,
  shiftIsoDay,
  tenderShares,
  tillAlertKind,
  weekdayOf,
  type SalesFigures,
} from './controlBoard';

const params = (q: Record<string, string>) => parseBoardParams((k) => q[k] ?? null);

describe('days', () => {
  it('reads only real calendar days', () => {
    assert.equal(parseIsoDay('2026-10-05'), '2026-10-05');
    assert.equal(parseIsoDay('2026-02-30'), null);
    assert.equal(parseIsoDay('5/10/2026'), null);
    assert.equal(parseIsoDay(''), null);
    assert.equal(parseIsoDay(null), null);
  });

  it('moves across months and years', () => {
    assert.equal(shiftIsoDay('2026-10-01', -1), '2026-09-30');
    assert.equal(shiftIsoDay('2026-01-03', -7), '2025-12-27');
    assert.equal(shiftIsoDay('2026-03-27', 1), '2026-03-28');
  });

  it('knows the weekday', () => {
    assert.equal(weekdayOf('2026-10-04'), 0); // a Sunday
    assert.equal(weekdayOf('2026-10-10'), 6);
  });
});

describe('the URL', () => {
  it('compares with the same weekday last week when it says nothing', () => {
    const p = params({});
    assert.deepEqual(p, { date: null, cmp: 'lastWeek', cmpDate: null, area: null });
    assert.deepEqual(boardDays(p, '2026-10-05'), { dayA: '2026-10-05', dayB: '2026-09-28' });
  });

  it('can switch the comparison off, or compare with the day before', () => {
    assert.equal(boardDays(params({ cmp: 'none' }), '2026-10-05').dayB, null);
    assert.deepEqual(boardDays(params({ cmp: 'prevDay', date: '2026-10-01' }), '2026-10-05'), {
      dayA: '2026-10-01',
      dayB: '2026-09-30',
    });
  });

  it('compares with any other day, and never a day with itself', () => {
    assert.equal(boardDays(params({ cmp: 'custom', cmpDate: '2026-01-01' }), '2026-10-05').dayB, '2026-01-01');
    assert.equal(boardDays(params({ cmp: 'custom', cmpDate: '2026-10-05' }), '2026-10-05').dayB, null);
    // A custom comparison with no day is none, not a broken query.
    assert.equal(params({ cmp: 'custom' }).cmp, 'none');
  });

  it('ignores junk and a day in the future', () => {
    const p = params({ cmp: 'whenever', date: '2099-01-01', area: '  ' });
    assert.equal(p.cmp, 'lastWeek');
    assert.equal(p.area, null);
    assert.equal(boardDays(p, '2026-10-05').dayA, '2026-10-05');
    assert.equal(params({ date: 'yesterday' }).date, null);
  });
});

describe('change', () => {
  it('is a percentage of the compared day, "new" when that was nothing', () => {
    assert.equal(pctChange(110, 100), 10);
    assert.equal(pctChange(50, 100), -50);
    assert.equal(pctChange(0, 0), 0);
    assert.equal(pctChange(10, 0), null);
  });

  it('is good news up, unless less is better', () => {
    assert.deepEqual(deltaTone(110, 100), { direction: 'up', good: true });
    assert.deepEqual(deltaTone(90, 100), { direction: 'down', good: false });
    assert.deepEqual(deltaTone(110, 100, true), { direction: 'up', good: false });
    assert.deepEqual(deltaTone(100.001, 100), { direction: 'flat', good: null });
  });
});

const fig = (over: Partial<SalesFigures>): SalesFigures => ({ ...ZERO_FIGURES, ...over });

describe('the scope', () => {
  const report = {
    kpis: fig({ salesToday: 300, salesCount: 3, gross: 320, discounts: 20 }),
    companies: [
      {
        shops: [
          {
            ...fig({ salesToday: 300 }),
            id: 'shop',
            machines: [
              { ...fig({ salesToday: 200 }), id: 't1' },
              { ...fig({ salesToday: 100 }), id: 't2' },
            ],
            areas: [{ ...fig({ salesToday: 120 }), id: 'bar', machineIds: ['t1'] }],
          },
        ],
      },
    ],
  };

  it('is the report itself, a point of sale inside its shop, or one till', () => {
    assert.equal(scopeFigures(report, {}).salesToday, 300);
    assert.equal(scopeFigures(report, { shopId: 'shop', areaId: 'bar' }).salesToday, 120);
    assert.equal(scopeFigures(report, { shopId: 'shop', machineId: 't2' }).salesToday, 100);
    assert.equal(scopeFigures(report, { machineId: 'gone' }).salesToday, 0);
    assert.equal(scopeFigures(undefined, {}).salesToday, 0);
  });

  it('averages a ticket as the server does', () => {
    assert.equal(averageTicket(report.kpis), 100);
    assert.equal(averageTicket(ZERO_FIGURES), 0);
  });
});

describe('by the hour', () => {
  it('fills the quiet hours and keeps a running total', () => {
    const out = mergeHourly(
      [
        { hour: 10, net: 100 },
        { hour: 12, net: 50 },
      ],
      [{ hour: 11, net: 30 }],
    );
    assert.deepEqual(
      out.map((p) => [p.label, p.a, p.b, p.ca, p.cb]),
      [
        ['10:00', 100, 0, 100, 0],
        ['11:00', 0, 30, 100, 30],
        ['12:00', 50, 0, 150, 30],
      ],
    );
    assert.equal(peakHour(out), 10);
  });

  it('draws no line into the future of a day still running', () => {
    const out = mergeHourly([{ hour: 9, net: 10 }], [{ hour: 13, net: 40 }], 11);
    assert.deepEqual(
      out.map((p) => [p.hour, p.a, p.b]),
      [
        [9, 10, 0],
        [10, 0, 0],
        [11, 0, 0],
        [12, null, 0],
        [13, null, 40],
      ],
    );
  });

  it('is empty with nothing sold, and has no B without a comparison', () => {
    assert.deepEqual(mergeHourly([], []), []);
    assert.equal(mergeHourly([{ hour: 8, net: 5 }], null)[0].b, null);
    assert.equal(peakHour([]), null);
  });
});

describe('tenders', () => {
  it('shares add up to 100', () => {
    const out = tenderShares({ card: 19888, cash: 4972, other: 0 });
    assert.deepEqual(
      out.map((t) => [t.key, t.share]),
      [
        ['card', 80],
        ['cash', 20],
        ['other', 0],
      ],
    );
    const thirds = tenderShares({ card: 1, cash: 1, other: 1 });
    assert.equal(thirds.reduce((s, t) => s + t.share, 0), 100);
  });

  it('a day of nothing (or refunds only) has no shares', () => {
    assert.ok(tenderShares({ card: 0, cash: -10, other: 0 }).every((t) => t.share === 0));
  });
});

describe('best sellers', () => {
  it('ranks the chosen day and finds each item on the compared one', () => {
    const out = compareItems(
      [
        { productId: 'beer', name: 'Beer', qty: 10, net: 200 },
        { productId: 'wine', name: 'Wine', qty: 2, net: 300 },
        { productId: null, name: 'Open item', qty: 1, net: 15 },
      ],
      [
        { productId: 'beer', name: 'Beer', qty: 4, net: 80 },
        { productId: 'cola', name: 'Cola', qty: 9, net: 90 },
        { productId: null, name: 'Open item', qty: 2, net: 30 },
      ],
      2,
    );
    assert.deepEqual(
      out.map((i) => [i.name, i.netA, i.netB, i.qtyB]),
      [
        ['Wine', 300, 0, 0],
        ['Beer', 200, 80, 4],
      ],
    );
    assert.equal(compareItems([{ name: 'Open item', qty: 1, net: 15 }], [{ name: 'Open item', qty: 2, net: 30 }], 5)[0].netB, 30);
  });
});

describe('alerts', () => {
  it('raises unsent sales and an unreachable open shift, not a till closed for the night', () => {
    assert.equal(tillAlertKind({ status: 'offline_with_unsynced', alerts: 0 }), 'unsynced');
    assert.equal(tillAlertKind({ status: 'offline', alerts: 2 }), 'offline');
    assert.equal(tillAlertKind({ status: 'no_open_shift', alerts: 0 }), null);
    assert.equal(tillAlertKind({ status: 'online', alerts: 1 }), 'flags');
    assert.equal(tillAlertKind({ status: undefined, alerts: 0 }), null);
  });

  it('lists the loudest first, then by register number', () => {
    const out = alertTills([
      { id: 'a', status: 'online', alerts: 1, registerNumber: 1 },
      { id: 'b', status: 'offline', alerts: 0, registerNumber: 8 },
      { id: 'c', status: 'offline', alerts: 0, registerNumber: 2 },
      { id: 'd', status: 'offline_with_unsynced', alerts: 0, registerNumber: null },
      { id: 'e', status: 'no_open_shift', alerts: 0, registerNumber: 3 },
    ]);
    assert.deepEqual(
      out.map((x) => x.till.id),
      ['d', 'c', 'b', 'a'],
    );
  });
});
