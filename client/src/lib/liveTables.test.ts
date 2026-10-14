/**
 * Run with `npm test`. The live floor and the table card (lib/liveTables.ts; pos-server
 * app/services/table_actions.py, tests/test_table_actions.py; P:/specs/live-tables-cloud.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_GRACE_MS,
  FIT,
  NO_FILTER,
  STATE_COLOR,
  actionView,
  clampView,
  compactMoney,
  countdown,
  dimmed,
  directErrorView,
  filterActive,
  gridCells,
  gridColumns,
  groupLines,
  holderText,
  isTap,
  liveRefetchMs,
  minutesSince,
  panBy,
  seatedText,
  stillWaiting,
  tintOf,
  toggleRound,
  visualState,
  waitersOf,
  zoneCounts,
  zoomAbout,
  type ActionStatus,
} from './liveTables';

const NOW = Date.parse('2026-10-14T18:30:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('a table coloured as the till colours it', () => {
  const order = (over: Record<string, unknown> = {}) => ({ billPrintedAt: null, sendCount: 0, openedAt: ago(10), ...over });

  it('free, seated, in the kitchen', () => {
    assert.equal(visualState({ state: 'free', order: null }, NOW, 90), 'free');
    assert.equal(visualState({ state: 'occupied', order: order() }, NOW, 90), 'occupied');
    assert.equal(visualState({ state: 'sent', order: order({ sendCount: 2 }) }, NOW, 90), 'kitchen');
  });

  it('the most pressing word wins: another till, then to pay, then overdue', () => {
    assert.equal(visualState({ state: 'locked', order: order({ billPrintedAt: ago(1) }) }, NOW, 90), 'other_till');
    assert.equal(visualState({ state: 'awaiting_payment', order: order({ billPrintedAt: ago(1), openedAt: ago(200) }) }, NOW, 90), 'to_pay');
    assert.equal(visualState({ state: 'sent', order: order({ sendCount: 1, openedAt: ago(90) }) }, NOW, 90), 'overdue');
    assert.equal(visualState({ state: 'sent', order: order({ sendCount: 1, openedAt: ago(89) }) }, NOW, 90), 'kitchen');
  });

  it('paid and waiting to be cleared', () => {
    assert.equal(visualState({ state: 'free', order: null, cleaningSince: ago(3) }, NOW, 90), 'cleaning');
  });

  it("the till's colours", () => {
    assert.equal(STATE_COLOR.occupied, '#2563eb');
    assert.equal(STATE_COLOR.kitchen, '#f97316');
    assert.equal(STATE_COLOR.to_pay, '#d97706');
    assert.equal(STATE_COLOR.other_till, '#7c3aed');
    assert.equal(STATE_COLOR.overdue, '#dc2626');
    assert.equal(tintOf('#2563eb', 0), '#ffffff');
    assert.equal(tintOf('#000000', 0.5), 'rgb(128, 128, 128)');
  });

  it('a total as the floor writes it', () => {
    assert.equal(compactMoney(248), '₪248');
    assert.equal(compactMoney(1450.5), '₪1,450.50');
    assert.equal(compactMoney(null), '₪0');
  });

  it('the time seated and who is inside', () => {
    assert.equal(minutesSince(ago(25), NOW), 25);
    assert.equal(minutesSince(null, NOW), null);
    assert.equal(seatedText(45), '45 דק׳');
    assert.equal(seatedText(80), '1:20');
    assert.equal(holderText({ posNumber: '2', posUserName: 'דנה' }), '2 (דנה)');
    assert.equal(holderText({ machineName: 'בר', posUserName: null }), 'בר');
    assert.equal(holderText(null), null);
  });
});

describe('the next course', () => {
  const next = (over: Record<string, unknown> = {}) => ({ courseId: 'c', name: 'עיקריות', paused: false, dueAt: null, ...over });

  it('counts down in whole minutes, rounded up', () => {
    assert.deepEqual(countdown(next({ dueAt: new Date(NOW + 5.2 * 60_000).toISOString() }), NOW), { kind: 'in', minutes: 6 });
    assert.deepEqual(countdown(next({ dueAt: new Date(NOW + 1_000).toISOString() }), NOW), { kind: 'in', minutes: 1 });
  });

  it('due: now; paused; no time', () => {
    assert.deepEqual(countdown(next({ dueAt: ago(1) }), NOW), { kind: 'now' });
    assert.deepEqual(countdown(next({ paused: true, dueAt: ago(1) }), NOW), { kind: 'paused' });
    assert.deepEqual(countdown(next(), NOW), { kind: 'waiting' });
    assert.equal(countdown(null, NOW), null);
  });
});

describe('the filters dim the rest', () => {
  const dana = { order: { waiterName: 'דנה' } };
  const ron = { order: { waiterName: 'רון' } };
  const empty = { order: null };

  it('nothing is dimmed without a filter', () => {
    assert.equal(filterActive(NO_FILTER), false);
    assert.equal(dimmed(empty, 'free', NO_FILTER), false);
  });

  it("a waiter's tables stand out, every other is dimmed", () => {
    const f = { waiter: 'דנה', states: [] };
    assert.equal(dimmed(dana, 'kitchen', f), false);
    assert.equal(dimmed(ron, 'kitchen', f), true);
    assert.equal(dimmed(empty, 'free', f), true);
  });

  it('states, and both together', () => {
    assert.equal(dimmed(ron, 'to_pay', { waiter: null, states: ['to_pay', 'overdue'] }), false);
    assert.equal(dimmed(ron, 'kitchen', { waiter: null, states: ['to_pay'] }), true);
    assert.equal(dimmed(ron, 'to_pay', { waiter: 'דנה', states: ['to_pay'] }), true);
  });

  it('the waiters offered', () => {
    assert.deepEqual(waitersOf([ron, dana, empty, { order: { waiterName: ' דנה ' } }]), ['דנה', 'רון']);
  });
});

describe('zones and the grid', () => {
  it('counts the open tables of each zone', () => {
    assert.deepEqual(zoneCounts([
      { zoneId: 'a', order: {} }, { zoneId: 'a', order: null }, { zoneId: 'b', order: null }, { zoneId: 'a', order: {} },
    ]), { a: 2, b: 0 });
  });

  it('a grid zone by number, row after row', () => {
    const cells = gridCells([{ number: 3 }, { number: 1 }, { number: 12 }, { number: 2 }], 3);
    assert.deepEqual(cells.map((c) => [c.table.number, c.row, c.col]), [[1, 0, 0], [2, 0, 1], [3, 0, 2], [12, 1, 0]]);
    assert.equal(gridColumns(375), 2);
    assert.equal(gridColumns(1320), 10);
    assert.equal(gridColumns(0), 4);
  });
});

describe('the map on a phone: fit, pinch, drag', () => {
  it('never smaller than the fitted map, never past its edges', () => {
    assert.deepEqual(clampView({ scale: 0.5, x: 30, y: 30 }, 300, 200), FIT);
    assert.deepEqual(clampView({ scale: 2, x: -1000, y: 10 }, 300, 200), { scale: 2, x: -300, y: 0 });
  });

  it('zooms about the fingers: the point under them stays', () => {
    const v = zoomAbout(FIT, 2, 150, 100, 300, 200);
    assert.deepEqual(v, { scale: 2, x: -150, y: -100 });
    // The point (150, 100) of the box is the map's (150, 100) before and after.
    assert.equal((150 - v.x) / v.scale, 150);
    assert.equal(zoomAbout(v, 10, 0, 0, 300, 200).scale, 4);
  });

  it('drags within the map, and a small move is a tap', () => {
    const v = panBy({ scale: 2, x: -100, y: -50 }, 40, 500, 300, 200);
    assert.deepEqual(v, { scale: 2, x: -60, y: 0 });
    assert.equal(isTap(3, 4), true);
    assert.equal(isTap(12, 0), false);
  });
});

describe('refreshing', () => {
  it('every 5 s without push, or while a till holds the tables', () => {
    assert.equal(liveRefetchMs(false, false), 5_000);
    assert.equal(liveRefetchMs(true, true), 5_000);
    assert.equal(liveRefetchMs(true, false), 30_000);
  });
});

describe('an action sent to a till', () => {
  const base: ActionStatus = {
    id: 'c1', currentId: 'c1', action: 'fire', status: 'pending', outcome: 'waiting', reason: null,
    heldBy: null, retargeted: false, result: null, hostName: 'קופה 1', tableLabel: '12',
  };

  it('sends until the till answers', () => {
    const v = actionView(null, 0, 20, 1_000);
    assert.deepEqual([v.phase, v.key, stillWaiting(v)], ['sending', 'sending', true]);
    assert.equal(actionView({ ...base, retargeted: true }, 0, 20, 1_000).key, 'retargeting');
  });

  it('done, by the action, and the floor is read again', () => {
    const v = actionView({ ...base, outcome: 'done', status: 'done' }, 0, 20, 3_000);
    assert.deepEqual([v.phase, v.key, v.refresh], ['done', 'done.fire', true]);
  });

  it('a till inside the table: its name', () => {
    const v = actionView({ ...base, outcome: 'refused', reason: 'table_in_use', heldBy: 'קופה 2 (דנה)' }, 0, 20, 3_000);
    assert.deepEqual([v.key, v.values], ['refused.table_in_use', { till: 'קופה 2 (דנה)' }]);
    assert.equal(v.refresh, false);
  });

  it('a changed table is read again; an unknown refusal says its code', () => {
    assert.equal(actionView({ ...base, outcome: 'refused', reason: 'order_changed' }, 0, 20, 3_000).refresh, true);
    const v = actionView({ ...base, outcome: 'refused', reason: 'weird' }, 0, 20, 3_000);
    assert.deepEqual([v.key, v.values], ['refused.other', { reason: 'weird' }]);
  });

  it('the timeout: said by the cloud, or past it with no word', () => {
    assert.equal(actionView({ ...base, outcome: 'timeout' }, 0, 20, 3_000).phase, 'timeout');
    assert.equal(actionView(base, 0, 20, 20_000 + ACTION_GRACE_MS + 1).phase, 'timeout');
    assert.equal(actionView(base, 0, 20, 20_000 + ACTION_GRACE_MS - 1).phase, 'sending');
    assert.equal(actionView({ ...base, outcome: 'failed' }, 0, 20, 3_000).key, 'failed');
  });

  it("a direct action's 409", () => {
    assert.deepEqual(directErrorView('table_in_use', { till: '2 (דנה)' })?.values, { till: '2 (דנה)' });
    assert.equal(directErrorView('table_busy')?.key, 'refused.table_busy');
    assert.equal(directErrorView('something_else'), null);
    assert.equal(directErrorView(null), null);
  });
});

describe('the card', () => {
  it('lines by diner, then by course in the sequence', () => {
    const c = (id: string, order: number) => ({ id, name: id, order });
    const lines = [
      { id: 'a', seat: 2, seatName: 'דנה', course: c('main', 1) },
      { id: 'b', seat: null, course: null },
      { id: 'c', seat: 2, course: c('start', 0) },
      { id: 'd', seat: 1, course: c('main', 1) },
    ];
    const groups = groupLines(lines);
    assert.deepEqual(groups.map((g) => [g.seat, g.seatName, g.courses.map((x) => [x.course?.id ?? null, x.lines.map((l) => l.id)])]), [
      [null, null, [[null, ['b']]]],
      [1, null, [['main', ['d']]]],
      [2, 'דנה', [['start', ['c']], ['main', ['a']]]],
    ]);
  });

  it("a round picked whole, or dropped whole (the till's toggleRound)", () => {
    const round = { id: 'r1', lines: [{ lineId: 'a' }, { lineId: 'b' }] };
    const one = toggleRound([{ roundId: 'r1', lineId: 'a' }], round);
    assert.deepEqual(one, [{ roundId: 'r1', lineId: 'a' }, { roundId: 'r1', lineId: 'b' }]);
    assert.deepEqual(toggleRound(one, round), []);
  });
});
