/**
 * Run with `npm test`. The kitchen screen's layouts (docs/SPEC_KDS.md §14, lib/kdsLayouts.ts):
 * the lanes by station and by course (and the Expo's "לאיסוף"), a lane's "הכול מוכן", the rail's
 * time order, the list row's items, the big cards and their queue.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bigCapacity, bigSplit, inPickupLane, itemsSummary, laneButton, lanesOf, railOrder } from './kdsLayouts';
import type { KdsOrder, KdsTask } from './kdsScreenTypes';

const T0 = Date.UTC(2026, 9, 7, 10, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function task(id: string, extra: Partial<KdsTask> = {}): KdsTask {
  return {
    id, orderId: 'o', roundNo: 1, stationId: 'grill', stationName: 'גריל', targetKind: 'prep', required: true, lineKey: id,
    name: 'המבורגר', mods: [], removals: [], notes: null, allergies: [], important: false, seat: null, course: null, mealName: null,
    orderedQty: 1, cancelledQty: 0, preparedQty: 0, activeQty: 1, release: 'released', state: 'queued', version: 1,
    releasedAt: at(0), startedAt: null, readyAt: null, ...extra,
  };
}

function order(id: string, tasks: KdsTask[], extra: Partial<KdsOrder> = {}): KdsOrder {
  return {
    id, source: 'kiosk', displayRef: id, tableRef: null, zoneName: null, serviceType: 'take_away', guests: null, waiterName: null,
    pickupName: null, orderNote: null, pickupNumber: null, workflowMode: 'ORDER_PROCESS', paid: true, status: 'open', priority: 0,
    groupState: 'waiting', readyAt: null, allReady: false, requireExpo: true, requireStart: false, trackHandover: true, viewOnly: false,
    firstReleasedAt: at(0), createdAt: at(0), version: 1, tasks: tasks.map((t) => ({ ...t, orderId: id })), changes: [], ...extra,
  };
}

const fry = { stationId: 'fry', stationName: 'טיגון' };

describe('lanes', () => {
  it('by station: the device’s stations first, then the others, "ללא תחנה" last; the Expo’s "לאיסוף"', () => {
    const cards = [
      order('a', [task('a1'), task('a2', fry), task('a3', { stationId: null, stationName: null })]),
      order('b', [task('b1', fry)]),
      order('c', [task('c1', { state: 'ready', preparedQty: 1 }), task('c2', { ...fry, state: 'ready', preparedQty: 1 })]),
    ];
    const lanes = lanesOf(cards, 'station', 'expo', [{ id: 'fry', name: 'טיגון' }]);
    assert.deepEqual(lanes.map((l) => l.title), ['טיגון', 'גריל', 'ללא תחנה', 'לאיסוף']);
    assert.deepEqual(lanes[0].entries.map((e) => e.order.id), ['a', 'b']);
    assert.equal(lanes[0].open, 2);
    // Every item ready: waiting for the Expo — in "לאיסוף", not in the work lanes.
    assert.deepEqual(lanes[3].entries.map((e) => e.order.id), ['c']);
    assert.ok(inPickupLane(cards[2]));
    assert.ok(!inPickupLane(cards[0]));
  });

  it('a station with one station splits by course; by course in the order they appear', () => {
    const cards = [
      order('a', [task('a1', { course: 'עיקריות' }), task('a2', { course: 'ראשונות' })]),
      order('b', [task('b1', { course: 'ראשונות' }), task('b2')]),
    ];
    const lanes = lanesOf(cards, 'station', 'station', [{ id: 'grill', name: 'גריל' }]);
    assert.deepEqual(lanes.map((l) => [l.kind, l.title]), [['course', 'עיקריות'], ['course', 'ראשונות'], ['course', 'כללי']]);
    assert.ok(lanes.every((l) => l.kind !== 'pickup'));
  });

  it('a lane’s finished orders go to its end', () => {
    const cards = [order('a', [task('a1', { state: 'ready', preparedQty: 1 })]), order('b', [task('b1')])];
    const [lane] = lanesOf(cards, 'course', 'station');
    assert.deepEqual(lane.entries.map((e) => e.order.id), ['b', 'a']);
  });

  it('"הכול מוכן" of a lane: the station’s, or every open item of the course; a start first', () => {
    const o = order('a', [task('a1', { course: 'עיקריות' }), task('a2', { course: 'עיקריות', state: 'ready', preparedQty: 1 }), task('a3', { course: 'עיקריות' })]);
    const station = laneButton(o, { kind: 'station', stationId: 'grill', key: 's:grill' }, o.tasks);
    assert.deepEqual(station?.actions, [{ type: 'station_ready', orderId: 'a', stationId: 'grill' }]);
    const course = laneButton(o, { kind: 'course', stationId: null, key: 'c:עיקריות' }, o.tasks);
    assert.deepEqual(course?.actions.map((a) => [a.type, a.taskId]), [['item_ready', 'a1'], ['item_ready', 'a3']]);
    const start = laneButton({ ...o, requireStart: true }, { kind: 'course', stationId: null, key: 'c:x' }, o.tasks);
    assert.equal(start?.label, 'התחל הכול');
    assert.equal(laneButton(o, { kind: 'course', stationId: null, key: 'c:x' }, [o.tasks[1]]), null);
  });
});

describe('rail, list, big', () => {
  it('the rail is time order only; a station’s finished cards at the end', () => {
    const cards = [
      order('urgent-new', [task('u1')], { priority: 1, firstReleasedAt: at(9) }),
      order('old', [task('o1')], { firstReleasedAt: at(1) }),
      order('done', [task('d1', { state: 'ready', preparedQty: 1 })], { firstReleasedAt: at(0) }),
    ];
    assert.deepEqual(railOrder(cards, 'station').map((o) => o.id), ['old', 'urgent-new', 'done']);
    assert.deepEqual(railOrder(cards, 'expo').map((o) => o.id), ['done', 'old', 'urgent-new']);
  });

  it('the list row says the items by the screen’s fields', () => {
    const o = order('a', [
      task('a1', { activeQty: 2, mods: ['גבינה'], removals: ['בצל'], notes: 'בצד', allergies: ['גלוטן'] }),
      task('a2', { name: 'צ׳יפס', state: 'ready', preparedQty: 1 }),
      task('a3', { name: 'קינוח', release: 'hold' }),
    ]);
    const all = itemsSummary(o);
    assert.deepEqual(all.map((p) => p.text), ['2 × המבורגר (גבינה · בלי בצל · בצד)', '1 × צ׳יפס']);
    assert.deepEqual(all.map((p) => p.allergyText), ['אלרגיה: גלוטן', null]);
    assert.deepEqual(all.map((p) => [p.done, p.allergy, p.note]), [[false, true, true], [true, false, false]]);
    const bare = itemsSummary(o, { modifiers: false, notes: false, allergens: false });
    assert.equal(bare[0].text, '2 × המבורגר');
    assert.equal(bare[0].allergyText, null);
  });

  it('big: three on a landscape TV, two on a tablet or portrait, the rest queued', () => {
    assert.equal(bigCapacity(1896, 950), 3);
    assert.equal(bigCapacity(1100, 700), 2);
    assert.equal(bigCapacity(1080, 1800), 2);
    assert.equal(bigCapacity(600, 900), 1);
    assert.deepEqual(bigSplit([1, 2, 3, 4, 5], 3), { shown: [1, 2, 3], queue: [4, 5] });
  });
});
