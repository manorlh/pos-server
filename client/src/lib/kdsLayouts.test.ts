/**
 * Run with `npm test`. The kitchen screen's layouts (docs/SPEC_KDS.md §14, lib/kdsLayouts.ts):
 * the lanes by station and by course (and the Expo's "לאיסוף"), a lane's "הכול מוכן", the rail's
 * time order, the list row's items, the big cards and their queue.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allDayCounts,
  bigCapacity,
  bigSplit,
  cardsWithItem,
  historyAfter,
  historyRows,
  inPickupLane,
  isDoneCard,
  isReadyCard,
  itemsSummary,
  laneButton,
  lanesOf,
  nextHistory,
  orderTypeOf,
  overflowing,
  passesFilters,
  pausedView,
  railOrder,
  searchItems,
  splitDone,
  tintOf,
} from './kdsLayouts';
import {
  applyPending,
  checkAction,
  itemTapButton,
  orderNumberText,
  recallFor,
  screenOf,
  serviceText,
  sortOrders,
  taskButton,
  taskStateText,
  ticketMenu,
  urgencyText,
} from './kdsBoard';
import { DEFAULT_KDS_BEHAVIOUR } from './screenLook';
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

/* ------------------------------------------- learned from a reference KDS (§16) */

const ready = { state: 'ready', preparedQty: 1 } as const;

describe('a tap on an item (itemTap)', () => {
  it('"button": the row takes no tap, its button as always', () => {
    const o = order('a', [task('a1')]);
    assert.equal(itemTapButton(o, o.tasks[0], 'button'), null);
    assert.equal(taskButton(o, o.tasks[0])?.label, 'מוכן');
  });

  it('"cycle": ממתין → בהכנה → מוכן → ממתין', () => {
    const q = order('a', [task('a1')]);
    assert.deepEqual(itemTapButton(q, q.tasks[0], 'cycle')?.actions, [{ type: 'start', taskId: 'a1' }]);
    const p = order('a', [task('a1', { state: 'preparing' })]);
    assert.deepEqual(itemTapButton(p, p.tasks[0], 'cycle')?.actions, [{ type: 'item_ready', taskId: 'a1' }]);
    const r = order('a', [task('a1', ready)]);
    assert.deepEqual(itemTapButton(r, r.tasks[0], 'cycle')?.actions, [{ type: 'requeue', taskId: 'a1' }]);
    assert.deepEqual([q, p, r].map((o) => taskStateText(o.tasks[0])), ['ממתין', 'בהכנה', 'מוכן']);
  });

  it('"ready" (מוכן בנגיעה): one tap is ready (a start first where required), again — undo', () => {
    const o = order('a', [task('a1')]);
    assert.deepEqual(itemTapButton(o, o.tasks[0], 'ready')?.actions, [{ type: 'item_ready', taskId: 'a1' }]);
    const s = order('a', [task('a1')], { requireStart: true });
    assert.deepEqual(itemTapButton(s, s.tasks[0], 'ready')?.actions.map((a) => a.type), ['start', 'item_ready']);
    const r = order('a', [task('a1', ready)]);
    assert.deepEqual(itemTapButton(r, r.tasks[0], 'ready')?.actions, [{ type: 'undo_ready', taskId: 'a1' }]);
  });

  it('held, cancelled, a finished order: no tap', () => {
    const o = order('a', [task('h', { release: 'hold' }), task('c', { activeQty: 0, cancelledQty: 1 })]);
    assert.equal(itemTapButton(o, o.tasks[0], 'ready'), null);
    assert.equal(itemTapButton(o, o.tasks[1], 'cycle'), null);
    const done = order('b', [task('b1')], { groupState: 'handed_over', status: 'handed_over' });
    assert.equal(itemTapButton(done, done.tasks[0], 'ready'), null);
  });

  it('requeue: checked, and drawn at once (never reviving a cancelled unit)', () => {
    assert.equal(checkAction({ type: 'requeue' }), 'חסר פריט לפעולה');
    assert.equal(checkAction({ type: 'requeue', taskId: 'a1' }), null);
    const o = order('a', [task('a1', { ...ready, startedAt: at(1), readyAt: at(2) }), task('a2', { activeQty: 0, cancelledQty: 1 })], { groupState: 'ready_for_pickup', status: 'ready', requireExpo: false });
    const [x] = applyPending([o], [{ type: 'requeue', taskId: 'a1' }], { role: 'expo', stationIds: [] });
    assert.deepEqual([x.tasks[0].state, x.tasks[0].preparedQty, x.tasks[0].startedAt, x.tasks[0].readyAt], ['queued', 0, null, null]);
    assert.equal(x.groupState, 'waiting');
    const [y] = applyPending([o], [{ type: 'requeue', taskId: 'a2' }], { role: 'expo', stationIds: [] });
    assert.equal(y, o);
  });
});

describe('the ticket’s menu', () => {
  it('the Expo: דחוף, and the items: ממתין / בהכנה / מוכן — only what changes something', () => {
    const o = order('a', [task('a1'), task('a2', { state: 'preparing' }), task('a3', ready)]);
    const menu = ticketMenu(o, 'expo', { stationRush: false, urgencyLevels: false });
    assert.deepEqual(menu.map((b) => b.label), ['דחוף', 'הכול ממתין', 'הכול בהכנה', 'הכול מוכן']);
    assert.equal(menu[0].reason, 'priority');
    assert.deepEqual(menu[0].actions, [{ type: 'priority', orderId: 'a', priority: 1 }]);
    assert.deepEqual(menu[1].actions.map((a) => a.taskId), ['a2', 'a3']);
    assert.deepEqual(menu[2].actions.map((a) => [a.type, a.taskId]), [['start', 'a1'], ['undo_ready', 'a3']]);
    assert.deepEqual(menu[3].actions.map((a) => [a.type, a.taskId]), [['item_ready', 'a1'], ['item_ready', 'a2']]);
  });

  it('a station: no דחוף unless its screen allows; levels; an urgent order can be cancelled', () => {
    const o = order('a', [task('a1')]);
    assert.ok(!ticketMenu(o, 'station', { stationRush: false, urgencyLevels: false }).some((b) => b.reason === 'priority'));
    const rush = ticketMenu(o, 'station', { stationRush: true, urgencyLevels: true }).filter((b) => b.reason === 'priority');
    assert.deepEqual(rush.map((b) => b.label), ['דחוף', 'דחוף מאוד', 'בהול']);
    const urgent = order('b', [task('b1')], { priority: 2 });
    assert.deepEqual(ticketMenu(urgent, 'manager', { stationRush: false, urgencyLevels: true }).filter((b) => b.reason).map((b) => b.label), ['בטל דחיפות', 'דחוף', 'בהול']);
    assert.deepEqual(ticketMenu(urgent, 'manager', { stationRush: false, urgencyLevels: false }).filter((b) => b.reason).map((b) => b.label), ['בטל דחיפות']);
    assert.deepEqual([urgencyText(0), urgencyText(1), urgencyText(2), urgencyText(5)], [null, 'דחוף', 'דחוף מאוד', 'בהול']);
  });

  it('a required start comes first in "הכול מוכן"; a finished order has no menu', () => {
    const o = order('a', [task('a1'), task('a2', { state: 'preparing' })], { requireStart: true });
    const all = ticketMenu(o, 'station', { stationRush: false, urgencyLevels: false }).find((b) => b.label === 'הכול מוכן');
    assert.deepEqual(all?.actions.map((a) => [a.type, a.taskId]), [['start', 'a1'], ['item_ready', 'a1'], ['item_ready', 'a2']]);
    assert.deepEqual(ticketMenu(order('b', [task('b1')], { groupState: 'handed_over', status: 'handed_over' }), 'expo', { stationRush: true, urgencyLevels: true }), []);
  });
});

describe('what the screen shows', () => {
  it('the order types and external orders', () => {
    const b = DEFAULT_KDS_BEHAVIOUR;
    const table = order('t', [task('t1')], { source: 'table', serviceType: null });
    const quick = order('q', [task('q1')], { source: 'quick', serviceType: null });
    const away = order('w', [task('w1')]);
    const courier = order('d', [task('d1')], { source: 'external', serviceType: 'delivery' });
    assert.deepEqual([table, quick, away, courier].map(orderTypeOf), ['eatIn', null, 'takeAway', 'delivery']);
    assert.ok([table, quick, away, courier].every((o) => passesFilters(o, b)));
    const noTa = { ...b, orderTypes: { eatIn: true, takeAway: false, delivery: true } };
    assert.deepEqual([table, quick, away, courier].map((o) => passesFilters(o, noTa)), [true, true, false, true]);
    assert.deepEqual([table, courier].map((o) => passesFilters(o, { ...b, externalOrders: 'only' })), [false, true]);
    assert.deepEqual([table, courier].map((o) => passesFilters(o, { ...b, externalOrders: 'hide' })), [true, false]);
    assert.equal(tintOf(away, b), null);
    assert.equal(tintOf(away, { serviceTint: { takeAway: true, delivery: false } }), 'takeAway');
    assert.equal(tintOf(courier, { serviceTint: { takeAway: true, delivery: true } }), 'delivery');
    assert.equal(serviceText('delivery'), 'משלוח');
  });

  it('FIFO as always, LIFO the newest first — urgent first either way', () => {
    const cards = [order('old', [task('o1')], { firstReleasedAt: at(1) }), order('new', [task('n1')], { firstReleasedAt: at(9) }), order('urgent', [task('u1')], { firstReleasedAt: at(5), priority: 1 })];
    assert.deepEqual(sortOrders(cards, 'expo').map((o) => o.id), ['urgent', 'old', 'new']);
    assert.deepEqual(sortOrders(cards, 'expo', true).map((o) => o.id), ['urgent', 'new', 'old']);
    assert.deepEqual(screenOf(cards, 'station', T0).cards.map((o) => o.id), ['urgent', 'old', 'new']);
    assert.deepEqual(screenOf(cards, 'station', T0, { lifo: true }).cards.map((o) => o.id), ['urgent', 'new', 'old']);
    assert.deepEqual(railOrder(cards, 'expo', true).map((o) => o.id), ['new', 'urgent', 'old']);
  });

  it('"להכנה": what is left to prepare by name, the search, the filter by item', () => {
    const cards = [
      order('a', [task('a1', { name: 'צ׳יפס', activeQty: 2, orderedQty: 2 }), task('a2', { name: 'המבורגר' }), task('a3', { name: 'סלט', ...ready })]),
      order('b', [task('b1', { name: 'צ׳יפס ', activeQty: 3, orderedQty: 3, preparedQty: 1, state: 'preparing' }), task('b2', { name: 'קינוח', release: 'hold' })]),
    ];
    const all = allDayCounts(cards);
    assert.deepEqual(all.map((i) => [i.name, i.qty, i.orders]), [['המבורגר', 1, 1], ['צ׳יפס', 4, 2]]);
    assert.deepEqual(searchItems(all, 'ציפ').length, 0);
    assert.deepEqual(searchItems(all, 'צ׳י').map((i) => i.name), ['צ׳יפס']);
    assert.deepEqual(searchItems(all, '').length, 2);
    assert.deepEqual(cardsWithItem(cards, 'המבורגר').map((o) => o.id), ['a']);
    assert.deepEqual(cardsWithItem(cards, 'סלט'), []);
  });

  it('keep a finished ticket or not; "מוכנות"; pause; overflow', () => {
    const done = order('d', [task('d1', ready)]);
    const work = order('w', [task('w1')]);
    assert.ok(isDoneCard(done, 'station') && !isDoneCard(work, 'station'));
    assert.deepEqual(splitDone([work, done], 'station', true).cards.map((o) => o.id), ['w', 'd']);
    const split = splitDone([work, done], 'station', false);
    assert.deepEqual([split.cards.map((o) => o.id), split.gone.map((o) => o.id)], [['w'], ['d']]);
    // The Expo: only a ready-for-pickup order it has nothing left to do on.
    const pickup = order('p', [task('p1', ready)], { groupState: 'ready_for_pickup', status: 'ready', trackHandover: false });
    assert.ok(isDoneCard(pickup, 'expo'));
    assert.ok(!isDoneCard({ ...pickup, trackHandover: true }, 'expo'));
    assert.ok(isReadyCard(done, 'station') && !isReadyCard(work, 'station') && isReadyCard(pickup, 'expo'));
    assert.deepEqual(pausedView([work, done], null), { cards: [work, done], waiting: 0 });
    const paused = pausedView([work, done, order('n', [task('n1')])], new Set(['w', 'd']));
    assert.deepEqual([paused.cards.map((o) => o.id), paused.waiting], [['w', 'd'], 1]);
    assert.deepEqual([overflowing(25, 25), overflowing(26, 25), overflowing(99, null)], [false, true, false]);
  });

  it('the history: what finished here, half an hour, back when it has work again; "החזר"', () => {
    const done = order('d', [task('d1', ready)]);
    let h = nextHistory(new Map(), [done], new Set(), T0);
    assert.deepEqual([...h.keys()], ['d']);
    h = nextHistory(h, [], new Set(), T0 + 10 * 60_000);
    assert.equal(h.get('d')?.at, T0);
    assert.equal(nextHistory(h, [], new Set(), T0 + 31 * 60_000).size, 0);
    assert.equal(nextHistory(h, [], new Set(['d']), T0 + 60_000).size, 0);
    assert.deepEqual(historyRows(h, new Set(['d'])), []);
    assert.equal(historyRows(h, new Set()).length, 1);
    const many = nextHistory(new Map(), Array.from({ length: 50 }, (_, i) => order(`o${i}`, [task(`t${i}`, ready)])), new Set(), T0);
    assert.equal(many.size, 40);
    // From a board: a station's finished card; an order with work is not history.
    const fromBoard = historyAfter(new Map(), [done, order('w', [task('w1')])], 'station', DEFAULT_KDS_BEHAVIOUR, T0);
    assert.deepEqual([...fromBoard.keys()], ['d']);
    // "החזר": a station's ready items back; the Expo's ready for pickup back to preparation; handed over back to ready.
    assert.deepEqual(recallFor(done, 'station')?.actions, [{ type: 'undo_ready', taskId: 'd1' }]);
    assert.deepEqual(recallFor(order('p', [task('p1', ready)], { groupState: 'ready_for_pickup' }), 'expo')?.actions, [{ type: 'undo_pickup', orderId: 'p' }]);
    assert.deepEqual(recallFor(order('h', [task('h1', ready)], { groupState: 'handed_over', status: 'handed_over' }), 'expo')?.label, 'החזר');
    assert.equal(recallFor(order('x', [task('x1')]), 'station'), null);
  });

  it('the order’s number when the title does not say it', () => {
    assert.equal(orderNumberText(order('k', [], { pickupNumber: 41, displayRef: '41' })), null);
    assert.equal(orderNumberText(order('q', [], { pickupNumber: 57, displayRef: '20000057', source: 'quick' })), '#20000057');
    assert.equal(orderNumberText(order('t', [], { source: 'table', tableRef: '7', displayRef: 'שולחן 7', pickupNumber: null })), null);
    assert.equal(orderNumberText(order('l', [], { pickupLabel: 'A-17', pickupNumber: 17, displayRef: '17' })), null);
  });
});
