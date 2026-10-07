import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KdsModule, KDS_OUTBOX_KEY, QUEUED_TEXT, SERVER_ERROR_TRIES, deliveryOf, refusalCode, type OutboxEntry } from '../src/main/roles/kds';
import { Api } from '../src/main/sync/api';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import type { KdsOrder, KdsTask } from '../src/shared/roles';

const T0 = Date.parse('2026-10-07T10:00:00Z');
const OFFSET = 60_000; // the cloud's clock is a minute ahead of this PC

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
    name: 'המבורגר',
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
    releasedAt: new Date(T0).toISOString(),
    startedAt: null,
    readyAt: null,
    ...extra,
  };
}

function order(extra: Partial<KdsOrder> = {}): KdsOrder {
  return {
    id: 'o1',
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
    allReady: false,
    requireExpo: false,
    requireStart: false,
    trackHandover: true,
    viewOnly: false,
    firstReleasedAt: new Date(T0).toISOString(),
    createdAt: new Date(T0).toISOString(),
    version: 1,
    tasks: [task('t1'), task('t2')],
    changes: [],
    ...extra,
  };
}

type Answer = { status: number; body?: unknown } | 'offline';

const modules: KdsModule[] = [];
afterEach(() => {
  for (const m of modules.splice(0)) m.stop();
});

function world() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'r2m-kds-'));
  const db = openDb(path.join(dir, 'k.db'));
  migrate(db);
  const kv = new Kv(db);
  const w = {
    now: T0,
    online: true,
    board: { version: 10, orders: [order()] } as { version: number; orders: KdsOrder[] },
    /** Every POST that left (also those that got no answer). */
    attempts: [] as Array<Record<string, unknown>>,
    /** The POSTs the cloud received. */
    posts: [] as Array<Record<string, unknown>>,
    answers: [] as Answer[],
    gets: 0,
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/kds/actions')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      w.attempts.push(body);
      const a = w.answers.shift() ?? (w.online ? { status: 200, body: { outcome: 'applied', order: { id: body.orderId ?? 'o1', version: 2 } } } : 'offline');
      if (a === 'offline' || !w.online) throw new TypeError('fetch failed');
      w.posts.push(body);
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
    }
    if (!w.online) throw new TypeError('fetch failed');
    if (url.includes('/kds/board')) {
      w.gets++;
      const since = new URL(url).searchParams.get('since');
      const base = { serverTime: new Date(w.now + OFFSET).toISOString(), version: w.board.version };
      if (since !== null && Number(since) === w.board.version) return new Response(JSON.stringify({ syncType: 'unchanged', ...base }), { status: 200 });
      return new Response(
        JSON.stringify({
          syncType: 'full',
          ...base,
          device: { id: 'd1', name: 'גריל 1', role: 'station', stations: [{ id: 'grill', name: 'גריל' }] },
          shopName: 'סניף',
          orders: w.board.orders,
          stationSettings: { grill: { targetKind: 'prep', warnMinutes: 5, lateMinutes: 10 } },
        }),
        { status: 200 },
      );
    }
    return new Response('{"detail":"Not Found"}', { status: 404 });
  };
  const api = new Api('http://cloud.test/api/v1/', () => 'tok', fetchFn);
  let n = 0;
  const make = () => {
    const m = new KdsModule({ api, kv, machineId: () => 'm1', log: () => undefined }, () => undefined, {
      now: () => w.now,
      uuid: () => `act-${String(++n).padStart(4, '0')}-0000`,
    });
    modules.push(m);
    return m;
  };
  return { w, kv, make };
}

const stateOf = (m: KdsModule, id: string) => m.view().orders[0].tasks.find((t) => t.id === id)!;

describe('KDS actions', () => {
  it('go out at once with an id, the cloud’s time and the item’s version; stay drawn until the board shows them', async () => {
    const { w, make } = world();
    const m = make();
    await m.feed.poll();
    const r = await m.action({ type: 'item_ready', taskId: 't1' });
    expect(r).toEqual({ ok: true });
    expect(w.posts).toEqual([{ id: 'act-0001-0000', type: 'item_ready', taskId: 't1', occurredAt: new Date(T0 + OFFSET).toISOString(), expectedVersion: 1 }]);
    expect(m.view().pendingActions).toBe(0);
    // The feed was asked again at once; the board has not caught up: still drawn ready.
    await m.feed.poll();
    expect(w.gets).toBeGreaterThanOrEqual(2);
    expect(stateOf(m, 't1')).toMatchObject({ state: 'ready' });
    expect(stateOf(m, 't1').pending).toBeUndefined();
    // The cloud's board shows it (the order's version moved): the cloud's word from now on.
    w.board = { version: 11, orders: [order({ version: 2, tasks: [task('t1', { state: 'ready', preparedQty: 1, version: 2 }), task('t2')] })] };
    await m.feed.poll();
    expect(stateOf(m, 't1')).toMatchObject({ state: 'ready', version: 2 });
    // A second action on the same item carries the new version.
    await m.action({ type: 'undo_ready', taskId: 't1' });
    expect(w.posts[1]).toMatchObject({ type: 'undo_ready', expectedVersion: 2 });
  });

  it('offline: kept in order in the local database (a restart keeps them), retried in order with the same ids', async () => {
    const { w, kv, make } = world();
    const m = make();
    await m.feed.poll();
    w.online = false;
    expect(await m.action({ type: 'start', taskId: 't1' })).toEqual({ ok: true, message: QUEUED_TEXT });
    expect(await m.action({ type: 'item_ready', taskId: 't1' })).toEqual({ ok: true, message: QUEUED_TEXT });
    expect(await m.action({ type: 'ack_change', changeId: 'c1' })).toEqual({ ok: true, message: QUEUED_TEXT });
    // The first went out with the version it saw; nothing else did (a queue behind it is late).
    expect(w.attempts[0]).toMatchObject({ id: 'act-0001-0000', expectedVersion: 1 });
    expect(w.posts).toEqual([]);
    const v = m.view();
    expect(v.pendingActions).toBe(3);
    expect(stateOf(m, 't1')).toMatchObject({ state: 'ready', pending: true });
    expect(v.orders[0].pending).toBe(true);
    expect(kv.getJson<OutboxEntry[]>(KDS_OUTBOX_KEY)!.map((e) => e.id)).toEqual(['act-0001-0000', 'act-0002-0000', 'act-0003-0000']);

    // A restart without internet: the outbox and the drawn board are still there.
    m.stop();
    const m2 = make();
    expect(m2.outbox().map((e) => e.body.type)).toEqual(['start', 'item_ready', 'ack_change']);
    expect(m2.view().pendingActions).toBe(3);
    expect(m2.view().orders[0].tasks[0].state).toBe('ready');

    // Back online: the next good poll sends them, in order, as late actions (no expected version).
    w.online = true;
    await m2.feed.poll();
    await m2.drain();
    expect(w.posts.map((p) => [p.id, p.type])).toEqual([
      ['act-0001-0000', 'start'],
      ['act-0002-0000', 'item_ready'],
      ['act-0003-0000', 'ack_change'],
    ]);
    expect(w.posts.every((p) => !('expectedVersion' in p))).toBe(true);
    expect(w.posts[0].occurredAt).toBe(new Date(T0 + OFFSET).toISOString()); // when it was tapped
    expect(m2.view().pendingActions).toBe(0);
    expect(kv.getJson<OutboxEntry[]>(KDS_OUTBOX_KEY)).toEqual([]);
  });

  it('a refusal (409 / 422 / rejected) drops that action only and says why in Hebrew', async () => {
    const { w, make } = world();
    const m = make();
    await m.feed.poll();
    w.answers.push({ status: 409, body: { detail: { code: 'version_conflict', task: {} } } });
    const r = await m.action({ type: 'item_ready', taskId: 't1' });
    expect(r).toEqual({ ok: false, message: '#41 · מוכן: המצב השתנה במסך אחר — המסך עודכן' });
    expect(m.view().lastError).toBe(r.message);
    expect(m.view().pendingActions).toBe(0);
    expect(stateOf(m, 't1').state).toBe('queued'); // not drawn
    w.answers.push({ status: 200, body: { outcome: 'rejected', reason: 'start_required' } });
    expect((await m.action({ type: 'item_ready', taskId: 't2' })).message).toBe('#41 · מוכן: יש להתחיל הכנה לפני סימון מוכן');

    // In the middle of an outbox: the refused one leaves, the next still goes.
    w.online = false;
    await m.action({ type: 'start', taskId: 't1' });
    await m.action({ type: 'handover', orderId: 'o1' });
    await m.action({ type: 'start', taskId: 't2' });
    w.online = true;
    w.answers.push({ status: 200, body: { outcome: 'applied' } }, { status: 403, body: { detail: { code: 'expo_or_manager_only' } } });
    await m.feed.poll();
    await m.drain();
    expect(w.posts.slice(-3).map((p) => p.type)).toEqual(['start', 'handover', 'start']);
    expect(m.view().pendingActions).toBe(0);
    expect(m.view().lastError).toBe('#41 · נמסר: רק מסך Expo או מנהל מטבח יכול לבצע פעולה זו');
  });

  it('a server error keeps it (backed off) and gives up after a few tries', async () => {
    const { w, make } = world();
    const m = make();
    await m.feed.poll();
    for (let i = 0; i < SERVER_ERROR_TRIES; i++) w.answers.push({ status: 500, body: { detail: 'Internal Server Error' } });
    expect(await m.action({ type: 'item_ready', taskId: 't1' })).toEqual({ ok: true, message: QUEUED_TEXT });
    expect(m.outbox()[0]).toMatchObject({ attempts: 1, nextAt: T0 + 2_000 });
    expect(m.outbox()[0].body.expectedVersion).toBeUndefined();
    // Not before its time.
    await m.feed.poll();
    await m.drain();
    expect(w.posts).toHaveLength(1);
    for (let i = 1; i < SERVER_ERROR_TRIES; i++) {
      w.now += 61_000;
      await m.feed.poll();
      await m.drain();
    }
    expect(w.posts).toHaveLength(SERVER_ERROR_TRIES);
    expect(m.outbox()).toEqual([]);
    expect(m.view().lastError).toContain('שגיאת שרת');
  });

  it('what the cloud would refuse outright is never queued', async () => {
    const { w, make } = world();
    const m = make();
    await m.feed.poll();
    expect(await m.action({ type: 'priority', orderId: 'o1', priority: 1 })).toEqual({ ok: false, message: 'נדרשת סיבה' });
    expect(m.outbox()).toEqual([]);
    expect(w.attempts).toEqual([]);
    const r = await m.action({ type: 'priority', orderId: 'o1', priority: 1, reason: '  לקוח ממתין ' });
    expect(r.ok).toBe(true);
    expect(w.posts[0]).toMatchObject({ type: 'priority', priority: 1, reason: 'לקוח ממתין' });
    expect(w.posts[0].expectedVersion).toBeUndefined();
  });

  it('reads the cloud’s answers', () => {
    const h = new Headers();
    expect(deliveryOf({ kind: 'offline', reason: 'x' })).toMatchObject({ kind: 'retry', serverError: false });
    expect(deliveryOf({ kind: 'refused', status: 503, body: null, detail: null, headers: h })).toMatchObject({ kind: 'retry', serverError: true });
    expect(deliveryOf({ kind: 'refused', status: 429, body: null, detail: null, headers: h })).toMatchObject({ kind: 'retry' });
    expect(deliveryOf({ kind: 'refused', status: 404, body: { detail: { code: 'task_not_found' } }, detail: null, headers: h })).toEqual({ kind: 'refused', code: 'task_not_found' });
    expect(deliveryOf({ kind: 'ok', status: 200, body: { outcome: 'noop', replayed: true }, headers: h })).toEqual({ kind: 'done', outcome: 'noop', orderVersion: null });
    expect(deliveryOf({ kind: 'ok', status: 200, body: { outcome: 'applied', order: { version: 7 } }, headers: h })).toEqual({ kind: 'done', outcome: 'applied', orderVersion: 7 });
    expect(refusalCode(422, { detail: [{ loc: ['body', 'id'], msg: 'too short' }] })).toBe('invalid_request');
    expect(refusalCode(403, { detail: 'not_a_kds_device' })).toBe('not_a_kds_device');
    expect(refusalCode(418, null)).toBe('HTTP 418');
  });
});
