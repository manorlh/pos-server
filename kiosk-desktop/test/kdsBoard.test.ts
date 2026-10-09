import { describe, expect, it } from 'vitest';
import {
  allReady,
  applyPending,
  changeText,
  checkAction,
  columnsFor,
  epochMs,
  fallbackButtons,
  isSettled,
  layoutColumns,
  newArrivals,
  orderButtons,
  orderTimer,
  orderTitle,
  qtyText,
  recallButton,
  refusalText,
  roleTitle,
  rounds,
  screenOf,
  screenRole,
  sortOrders,
  taskButton,
  thresholds,
  type OverlayContext,
} from '../src/core/kdsBoard';
import type { KdsChange, KdsOrder, KdsTask } from '../src/shared/roles';

const T0 = Date.parse('2026-10-07T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function task(id: string, extra: Partial<KdsTask> = {}): KdsTask {
  return {
    id,
    orderId: 'o1',
    roundNo: 1,
    stationId: 'grill',
    stationName: 'גריל',
    targetKind: 'prep',
    required: true,
    lineKey: id,
    name: `item ${id}`,
    mods: [],
    removals: [],
    notes: null,
    allergies: [],
    important: false,
    seat: null,
    course: null,
    mealName: null,
    orderedQty: 1,
    cancelledQty: 0,
    preparedQty: 0,
    activeQty: 1,
    release: 'released',
    state: 'queued',
    version: 1,
    releasedAt: at(0),
    startedAt: null,
    readyAt: null,
    ...extra,
  };
}

function order(id: string, tasks: KdsTask[], extra: Partial<KdsOrder> = {}): KdsOrder {
  return {
    id,
    source: 'kiosk',
    displayRef: '41',
    tableRef: null,
    zoneName: null,
    serviceType: 'take_away',
    guests: null,
    waiterName: null,
    pickupName: null,
    orderNote: null,
    pickupNumber: 41,
    workflowMode: 'ORDER_PROCESS',
    paid: true,
    status: 'open',
    priority: 0,
    groupState: 'waiting',
    readyAt: null,
    allReady: allReady(tasks),
    requireExpo: true,
    requireStart: false,
    trackHandover: true,
    viewOnly: false,
    firstReleasedAt: at(0),
    createdAt: at(0),
    version: 1,
    tasks: tasks.map((t) => ({ ...t, orderId: id })),
    changes: [],
    ...extra,
  };
}

function change(id: string, extra: Partial<KdsChange> = {}): KdsChange {
  return { id, taskId: 't1', stationId: 'grill', kind: 'cancel', qty: 1, text: 'המבורגר', requiresAck: true, acked: false, createdAt: at(1), ...extra };
}

const types = (bs: Array<{ actions: Array<{ type: string }> }>) => bs.map((b) => b.actions.map((a) => a.type).join('+'));

describe('KDS buttons follow the cloud’s rules', () => {
  it('a station: מוכן per item, בטל מוכן when ready, הכול מוכן per card', () => {
    const o = order('o1', [task('t1'), task('t2', { state: 'preparing' }), task('t3', { state: 'ready', preparedQty: 1 })]);
    expect(taskButton(o, o.tasks[0])).toMatchObject({ label: 'מוכן', actions: [{ type: 'item_ready', taskId: 't1' }] });
    expect(taskButton(o, o.tasks[1])?.actions[0].type).toBe('item_ready');
    expect(taskButton(o, o.tasks[2])).toMatchObject({ label: 'בטל מוכן', actions: [{ type: 'undo_ready', taskId: 't3' }] });
    expect(orderButtons(o, 'station')).toEqual([expect.objectContaining({ label: 'הכול מוכן', actions: [{ type: 'station_ready', orderId: 'o1' }] })]);
    // Nothing left: no bump.
    const done = order('o2', [task('t1', { state: 'ready', preparedQty: 1 })]);
    expect(orderButtons(done, 'station')).toEqual([]);
  });

  it('held and cancelled items have no button; a finished order none at all', () => {
    const o = order('o1', [task('h', { release: 'hold' }), task('c', { activeQty: 0, cancelledQty: 1 })]);
    expect(taskButton(o, o.tasks[0])).toBeNull();
    expect(taskButton(o, o.tasks[1])).toBeNull();
    const gone = order('o2', [task('t1')], { groupState: 'handed_over', status: 'handed_over' });
    expect(taskButton(gone, gone.tasks[0])).toBeNull();
    expect(orderButtons(gone, 'expo')).toEqual([]);
  });

  it('requireStart: התחל before מוכן, and התחל הכול on the card', () => {
    const o = order('o1', [task('t1'), task('t2')], { requireStart: true });
    expect(taskButton(o, o.tasks[0])).toMatchObject({ label: 'התחל', tone: 'start', actions: [{ type: 'start', taskId: 't1' }] });
    expect(orderButtons(o, 'station')[0]).toMatchObject({ label: 'התחל הכול', actions: [{ type: 'start', taskId: 't1' }, { type: 'start', taskId: 't2' }] });
    const mixed = order('o1', [task('t1'), task('t2', { state: 'preparing' })], { requireStart: true });
    expect(orderButtons(mixed, 'station')[0]).toMatchObject({ label: 'התחל (1)', actions: [{ type: 'start', taskId: 't1' }] });
    expect(taskButton(mixed, mixed.tasks[1])?.label).toBe('מוכן');
    const started = order('o1', [task('t1', { state: 'preparing' })], { requireStart: true });
    expect(types(orderButtons(started, 'station'))).toEqual(['station_ready']);
  });

  it('the Expo: מוכן לאיסוף only when every station is done — before that only with a reason', () => {
    const waiting = order('o1', [task('t1', { state: 'ready', preparedQty: 1 }), task('t2', { stationId: 'fry', stationName: 'טיגון' })]);
    const bs = orderButtons(waiting, 'expo');
    expect(types(bs)).toEqual(['station_ready', 'ready_for_pickup']);
    expect(bs[1]).toMatchObject({ reason: 'override', actions: [{ type: 'ready_for_pickup', orderId: 'o1', override: true }] });
    const ready = order('o1', [task('t1', { state: 'ready', preparedQty: 1 })]);
    expect(orderButtons(ready, 'expo')).toEqual([expect.objectContaining({ label: 'מוכן לאיסוף', primary: true, actions: [{ type: 'ready_for_pickup', orderId: 'o1' }] })]);
    expect(orderButtons(ready, 'expo')[0].reason).toBeUndefined();
  });

  it('the Expo: נמסר only when the order tracks handover; החזר להכנה / החזר', () => {
    const ready = order('o1', [task('t1', { state: 'ready', preparedQty: 1 })], { groupState: 'ready_for_pickup', status: 'ready' });
    expect(types(orderButtons(ready, 'expo'))).toEqual(['handover', 'undo_pickup']);
    expect(types(orderButtons({ ...ready, trackHandover: false }, 'expo'))).toEqual(['undo_pickup']);
    const handed = { ...ready, groupState: 'handed_over', status: 'handed_over' };
    expect(recallButton(handed)).toMatchObject({ label: 'החזר', actions: [{ type: 'undo_pickup', orderId: 'o1' }] });
    expect(recallButton(ready)).toBeNull();
  });

  it('the manager: as the Expo, plus priority (with a reason); a station never gets them', () => {
    const o = order('o1', [task('t1')]);
    expect(types(orderButtons(o, 'manager'))).toEqual(['station_ready', 'ready_for_pickup', 'priority']);
    expect(orderButtons(o, 'manager')[2]).toMatchObject({ label: 'דחוף', reason: 'priority', actions: [{ type: 'priority', priority: 1 }] });
    expect(orderButtons({ ...o, priority: 1 }, 'manager')[2]).toMatchObject({ label: 'בטל דחיפות', actions: [{ type: 'priority', priority: 0 }] });
    expect(types(orderButtons(o, 'expo'))).not.toContain('priority');
    expect(types(orderButtons(o, 'station'))).toEqual(['station_ready']);
  });

  it('view only (DIRECT_SALE): a bump, never a pickup step', () => {
    const o = order('o1', [task('t1')], { viewOnly: true, workflowMode: 'DIRECT_SALE', groupState: 'waiting' });
    expect(types(orderButtons(o, 'expo'))).toEqual(['station_ready']);
    expect(types(orderButtons(o, 'manager'))).toEqual(['station_ready']);
    const bumped = order('o1', [task('t1', { state: 'ready', preparedQty: 1 })], { viewOnly: true, status: 'closed' });
    expect(recallButton(bumped)?.actions).toEqual([{ type: 'undo_ready', taskId: 't1' }]);
  });

  it('a round printed on the fallback printer is reconciled, never offered as fresh work', () => {
    const o = order('o1', [task('t1', { fallbackPrinted: true, fallbackResolved: false })]);
    expect(taskButton(o, o.tasks[0])).toBeNull();
    expect(orderButtons(o, 'station')).toEqual([]);
    expect(fallbackButtons(o.tasks[0]).map((b) => b.actions[0])).toEqual([
      { type: 'resolve_fallback', taskId: 't1', resolution: 'prepared' },
      { type: 'resolve_fallback', taskId: 't1', resolution: 'prepare' },
    ]);
    expect(fallbackButtons({ ...o.tasks[0], fallbackResolved: true })).toEqual([]);
  });

  it('what the cloud would refuse outright is said before anything is queued', () => {
    expect(checkAction({ type: 'item_ready' })).toBe('חסר פריט לפעולה');
    expect(checkAction({ type: 'handover' })).toBe('חסרה הזמנה לפעולה');
    expect(checkAction({ type: 'priority', orderId: 'o1', priority: 1 })).toBe('נדרשת סיבה');
    expect(checkAction({ type: 'priority', orderId: 'o1', priority: 1, reason: '  ' })).toBe('נדרשת סיבה');
    expect(checkAction({ type: 'ready_for_pickup', orderId: 'o1', override: true })).toBe('נדרשת סיבה');
    expect(checkAction({ type: 'ready_for_pickup', orderId: 'o1' })).toBeNull();
    expect(checkAction({ type: 'priority', orderId: 'o1', priority: 12, reason: 'x' })).toBe('עדיפות לא תקינה');
    expect(checkAction({ type: 'ack_change', changeId: 'c1' })).toBeNull();
  });
});

describe('KDS timer', () => {
  const settings = { grill: { targetKind: 'prep', warnMinutes: 5, lateMinutes: 10 }, fry: { targetKind: 'prep', warnMinutes: 3, lateMinutes: 15 } };

  it('the strictest station thresholds, else the cloud’s defaults (10 / 20)', () => {
    expect(thresholds(order('o1', [task('t1'), task('t2', { stationId: 'fry' })]), settings)).toEqual({ warn: 3, late: 10 });
    expect(thresholds(order('o1', [task('t1', { stationId: 'other' })]), settings)).toEqual({ warn: 10, late: 20 });
  });

  it('בזמן → מתעכב → באיחור, counted on the cloud’s clock', () => {
    const o = order('o1', [task('t1')]);
    expect(orderTimer(o, settings, T0 + 4 * 60_000)).toEqual({ minutes: 4, level: 'normal' });
    expect(orderTimer(o, settings, T0 + 5 * 60_000)).toEqual({ minutes: 5, level: 'warn' });
    expect(orderTimer(o, settings, T0 + 12 * 60_000 + 59_000)).toEqual({ minutes: 12, level: 'late' });
    // A local clock 3 minutes behind, corrected by the server offset.
    const localNow = T0 + 2 * 60_000;
    const offset = 3 * 60_000;
    expect(orderTimer(o, settings, localNow + offset).level).toBe('warn');
    // A clock a little ahead of the release never shows a negative age.
    expect(orderTimer(o, settings, T0 - 30_000).minutes).toBe(0);
  });

  it('a later round counts from its own release; nothing open = מוכן', () => {
    const o = order('o1', [task('t1', { state: 'ready', preparedQty: 1 }), task('t2', { roundNo: 2, releasedAt: at(30) })]);
    expect(orderTimer(o, settings, T0 + 32 * 60_000)).toEqual({ minutes: 2, level: 'normal' });
    const done = order('o1', [task('t1', { state: 'ready', preparedQty: 1 })]);
    expect(orderTimer(done, settings, T0 + 40 * 60_000).level).toBe('done');
    expect(orderTimer({ ...o, groupState: 'ready_for_pickup' }, settings, T0 + 40 * 60_000).level).toBe('done');
  });

  it('reads the cloud’s times with or without a zone (naive = UTC)', () => {
    expect(epochMs('2026-10-07T10:00:00')).toBe(T0);
    expect(epochMs('2026-10-07T10:00:00+00:00')).toBe(T0);
    expect(epochMs('2026-10-07T13:00:00+03:00')).toBe(T0);
    expect(epochMs('nonsense')).toBeNull();
    expect(epochMs(null)).toBeNull();
  });
});

describe('KDS optimistic overlay', () => {
  const station: OverlayContext = { role: 'station', stationIds: ['grill'] };
  const expo: OverlayContext = { role: 'expo', stationIds: [] };

  it('start → preparing, item_ready → ready, undo_ready → preparing', () => {
    const o = order('o1', [task('t1'), task('t2', { orderedQty: 2, activeQty: 2 })]);
    const [started] = applyPending([o], [{ type: 'start', taskId: 't1', unsent: true }], station);
    expect(started.tasks[0]).toMatchObject({ state: 'preparing', pending: true });
    expect(started.pending).toBe(true);
    const [ready] = applyPending([o], [{ type: 'item_ready', taskId: 't2' }], station);
    expect(ready.tasks[1]).toMatchObject({ state: 'ready', preparedQty: 2 });
    expect(ready.tasks[1].pending).toBeUndefined();
    const [undone] = applyPending([ready], [{ type: 'undo_ready', taskId: 't2' }], station);
    expect(undone.tasks[1]).toMatchObject({ state: 'preparing', preparedQty: 0 });
  });

  it('never revives a cancellation, never skips a required start', () => {
    const o = order('o1', [task('c', { activeQty: 0, cancelledQty: 1 }), task('q')], { requireStart: true });
    const [after] = applyPending([o], [{ type: 'item_ready', taskId: 'c' }, { type: 'item_ready', taskId: 'q' }], station);
    expect(after.tasks.map((t) => t.state)).toEqual(['queued', 'queued']);
    const [x] = applyPending([o], [{ type: 'start', taskId: 'q' }, { type: 'item_ready', taskId: 'q' }], station);
    expect(x.tasks[1].state).toBe('ready');
  });

  it('station_ready: this station’s tasks only (queued ones wait for a start when required)', () => {
    const o = order('o1', [task('t1', { state: 'preparing' }), task('t2'), task('f', { stationId: 'fry' }), task('h', { release: 'hold' })], { requireStart: true });
    const [after] = applyPending([o], [{ type: 'station_ready', orderId: 'o1' }], station);
    expect(after.tasks.map((t) => t.state)).toEqual(['ready', 'queued', 'queued', 'queued']);
    // The Expo's bump covers every station.
    const free = { ...o, requireStart: false };
    const [all] = applyPending([free], [{ type: 'station_ready', orderId: 'o1' }], expo);
    expect(all.tasks.map((t) => t.state)).toEqual(['ready', 'ready', 'ready', 'queued']);
    // Another order is untouched.
    const other = order('o2', [task('t9')]);
    expect(applyPending([other], [{ type: 'station_ready', orderId: 'o1' }], expo)[0]).toBe(other);
  });

  it('ready_for_pickup: when all ready, or with an override; handover; undo_pickup', () => {
    const notReady = order('o1', [task('t1')]);
    expect(applyPending([notReady], [{ type: 'ready_for_pickup', orderId: 'o1' }], expo)[0].groupState).toBe('waiting');
    const forced = applyPending([notReady], [{ type: 'ready_for_pickup', orderId: 'o1', override: true, reason: 'הלקוח ממתין' }], expo)[0];
    expect(forced).toMatchObject({ groupState: 'ready_for_pickup', status: 'ready', groupOverride: 'הלקוח ממתין' });
    const ready = order('o1', [task('t1', { state: 'ready', preparedQty: 1 })]);
    const picked = applyPending([ready], [{ type: 'ready_for_pickup', orderId: 'o1' }], expo)[0];
    expect(picked).toMatchObject({ groupState: 'ready_for_pickup', status: 'ready', groupOverride: null });
    const handed = applyPending([picked], [{ type: 'handover', orderId: 'o1' }], expo)[0];
    expect(handed).toMatchObject({ groupState: 'handed_over', status: 'handed_over' });
    // Handed over: gone from the cards (to the recent strip, for "החזר").
    expect(screenOf([handed], 'expo', T0)).toEqual({ cards: [], recent: [handed] });
    expect(applyPending([handed], [{ type: 'undo_pickup', orderId: 'o1' }], expo)[0].groupState).toBe('ready_for_pickup');
    expect(applyPending([picked], [{ type: 'undo_pickup', orderId: 'o1' }], expo)[0]).toMatchObject({ groupState: 'waiting', status: 'open' });
  });

  it('the shared service’s rule without requireExpo: the last item makes it ready; an undo takes it back', () => {
    const o = order('o1', [task('t1', { state: 'ready', preparedQty: 1 }), task('t2')], { requireExpo: false });
    const ready = applyPending([o], [{ type: 'item_ready', taskId: 't2' }], expo)[0];
    expect(ready).toMatchObject({ allReady: true, groupState: 'ready_for_pickup' });
    const back = applyPending([ready], [{ type: 'undo_ready', taskId: 't1' }], expo)[0];
    expect(back).toMatchObject({ allReady: false, groupState: 'waiting' });
    // With requireExpo the Expo still confirms.
    expect(applyPending([{ ...o, requireExpo: true }], [{ type: 'item_ready', taskId: 't2' }], expo)[0].groupState).toBe('waiting');
    // A station never moves the group (it sees only its own items).
    expect(applyPending([o], [{ type: 'item_ready', taskId: 't2' }], station)[0].groupState).toBe('waiting');
  });

  it('ack_change → acked; priority; resolve_fallback', () => {
    const o = order('o1', [task('t1', { fallbackPrinted: true })], { changes: [change('c1'), change('c2', { taskId: 't9' })] });
    const acked = applyPending([o], [{ type: 'ack_change', changeId: 'c1' }], station)[0];
    expect(acked.changes.map((c) => c.acked)).toEqual([true, false]);
    expect(applyPending([o], [{ type: 'priority', orderId: 'o1', priority: 1, reason: 'VIP' }], expo)[0]).toMatchObject({ priority: 1, priorityReason: 'VIP' });
    const prepared = applyPending([o], [{ type: 'resolve_fallback', taskId: 't1', resolution: 'prepared' }], station)[0];
    expect(prepared.tasks[0]).toMatchObject({ fallbackResolved: true, state: 'ready' });
    const prepare = applyPending([o], [{ type: 'resolve_fallback', taskId: 't1', resolution: 'prepare' }], station)[0];
    expect(prepare.tasks[0]).toMatchObject({ fallbackResolved: true, state: 'queued' });
  });

  it('a delivered action stays drawn until the board shows it', () => {
    const o = order('o1', [task('t1')], { version: 3 });
    const s = { action: { type: 'item_ready' as const, taskId: 't1' }, boardVersion: 10, orderVersion: 4, at: T0 };
    expect(isSettled(s, { version: 10, orders: [o] }, T0 + 1_000)).toBe(false); // no new board yet
    expect(isSettled(s, { version: 11, orders: [o] }, T0 + 1_000)).toBe(false); // a board from before the action
    expect(isSettled(s, { version: 12, orders: [{ ...o, version: 4 }] }, T0 + 1_000)).toBe(true);
    expect(isSettled(s, { version: 12, orders: [] }, T0 + 1_000)).toBe(true); // gone
    expect(isSettled(s, { version: 10, orders: [o] }, T0 + 16_000)).toBe(true); // waited long enough
    const ack = { action: { type: 'ack_change' as const, changeId: 'c1' }, boardVersion: 10, orderVersion: null, at: T0 };
    expect(isSettled(ack, { version: 11, orders: [{ ...o, changes: [change('c1')] }] }, T0)).toBe(false);
    expect(isSettled(ack, { version: 11, orders: [{ ...o, changes: [change('c1', { acked: true })] }] }, T0)).toBe(true);
  });
});

describe('KDS screen', () => {
  it('urgent first, then the oldest; a station’s finished cards go last', () => {
    const old = order('a', [task('t1')], { firstReleasedAt: at(0) });
    const young = order('b', [task('t2')], { firstReleasedAt: at(5) });
    const urgent = order('c', [task('t3')], { firstReleasedAt: at(9), priority: 1 });
    const done = order('d', [task('t4', { state: 'ready', preparedQty: 1 })], { firstReleasedAt: at(-10) });
    expect(sortOrders([young, done, old, urgent], 'station').map((o) => o.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(sortOrders([young, done, old, urgent], 'expo').map((o) => o.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('the Expo: cancelled orders leave once seen; a ready order without handover tracking leaves after 15 min', () => {
    const cancelled = order('x', [task('t1', { activeQty: 0, cancelledQty: 1 })], { status: 'cancelled', groupState: 'cancelled', changes: [change('c1')] });
    expect(screenOf([cancelled], 'expo', T0).cards).toHaveLength(1); // the cancellation still needs a "ראיתי"
    const seen = { ...cancelled, changes: [change('c1', { acked: true })] };
    expect(screenOf([seen], 'expo', T0)).toEqual({ cards: [], recent: [] });
    expect(screenOf([seen], 'station', T0).cards).toEqual([]);
    const ready = order('r', [task('t1', { state: 'ready', preparedQty: 1 })], { groupState: 'ready_for_pickup', status: 'ready', readyAt: at(0), trackHandover: false });
    expect(screenOf([ready], 'expo', T0 + 10 * 60_000).cards).toHaveLength(1);
    expect(screenOf([ready], 'expo', T0 + 16 * 60_000).cards).toHaveLength(0);
    expect(screenOf([{ ...ready, trackHandover: true }], 'expo', T0 + 60 * 60_000).cards).toHaveLength(1);
  });

  it('titles, quantities, rounds, change texts, role titles', () => {
    expect(orderTitle(order('o', [], { tableRef: '7', displayRef: null, pickupNumber: null }))).toBe('שולחן 7');
    expect(orderTitle(order('o', [], { tableRef: '7', displayRef: 'שולחן 7 (גן)' }))).toBe('שולחן 7 (גן)');
    expect(orderTitle(order('o', []))).toBe('#41');
    expect(orderTitle(order('abcdef123', [], { pickupNumber: null, displayRef: null }))).toBe('abcdef');
    expect(qtyText(2)).toBe('2');
    expect(qtyText(1.5)).toBe('1.5');
    expect(qtyText(0.333)).toBe('0.33');
    expect(rounds([task('a', { roundNo: 2, releasedAt: at(9) }), task('b'), task('c', { roundNo: 2, releasedAt: at(8) })]).map((r) => [r.roundNo, r.tasks.length, r.releasedAt])).toEqual([
      [1, 1, at(0)],
      [2, 2, at(8)],
    ]);
    const o = order('o1', [task('t1', { name: 'צ׳יפס' })]);
    expect(changeText(change('c', { qty: 2, text: 'צ׳יפס' }), o)).toBe('בוטל: 2 × צ׳יפס');
    expect(changeText(change('c', { kind: 'note', text: 'בלי מלח' }), o)).toBe('שינוי הערה — צ׳יפס: בלי מלח');
    expect(changeText(change('c', { kind: 'note', text: null }), o)).toBe('ההערה הוסרה — צ׳יפס');
    expect(screenRole({ role: 'expo' })).toBe('expo');
    expect(screenRole(null)).toBe('station');
    expect(roleTitle({ id: 'd', name: 'x', role: 'station', stations: [{ id: 'a', name: 'גריל' }, { id: 'b', name: 'טיגון' }] })).toBe('גריל · טיגון');
    expect(roleTitle({ id: 'd', name: 'x', role: 'manager', stations: [] })).toBe('מנהל מטבח');
  });

  it('refusals in Hebrew (the code itself when unknown)', () => {
    expect(refusalText('start_required')).toBe('יש להתחיל הכנה לפני סימון מוכן');
    expect(refusalText('version_conflict')).toContain('השתנה');
    expect(refusalText('something_new')).toBe('הפעולה לא בוצעה (something_new)');
  });

  it('columns fill a landscape 1920 screen and a portrait one, in reading order', () => {
    expect(columnsFor(1920 - 24)).toBe(5);
    expect(columnsFor(1080 - 24)).toBe(3);
    expect(columnsFor(0)).toBe(1);
    const cols = layoutColumns([1, 2, 3, 4, 5, 6], 3, (n) => (n === 1 ? 5 : 1));
    expect(cols).toEqual([[1], [2, 4, 6], [3, 5]]);
    expect(layoutColumns([], 4, () => 1)).toEqual([[], [], [], []]);
  });

  it('announces only orders that were not there before (never the first board)', () => {
    const a = order('a', []);
    const b = order('b', []);
    expect(newArrivals(null, [a])).toEqual([]);
    expect(newArrivals(new Set(['a']), [a, b])).toEqual(['b']);
  });
});
