/**
 * "הזמנות להכנה" on the Windows till (core/till/readyOrders.ts, main/till/tillReadyOrders.ts, ReadyOrdersScreen): pos-android
 * ReadyOrdersTest's cases — the list read defensively, the headline, the buttons per state, the three sections, a tap shown
 * before the cloud confirms it (never twice), the refusals in Hebrew, the order's ⋮, where the menu offers it — then the
 * engine (a fake cloud: the list, a tap, no answer and "נסו שוב" with the same id, a refusal, a device the cloud refuses) and
 * the screen's markup.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  READY_TEXT,
  actionBody,
  actionsFor,
  after,
  applyAction,
  blocksList,
  headline,
  menuActions,
  minutesSince,
  outcomeOf,
  parseReadyOrders,
  readyOrdersOffered,
  readyOrdersView,
  refusalCode,
  refusalMessage,
  secondaryRef,
  sections,
  skewMs,
  statusOf,
  withPending,
  type ReadyGroup,
  type ReadyItem,
  type ReadyOrder,
  type ReadyOrdersState,
  type ReadyPending,
} from '../src/core/till/readyOrders';
import { TillReadyOrders } from '../src/main/till/tillReadyOrders';
import { ReadyOrdersScreen } from '../src/renderer/roles/till/screens/ReadyOrdersScreen';
import type { TillOp } from '../src/shared/till/protocol';
import { PIN, harness, type Harness } from './tillEngineHarness';

const FULL = {
  serverTime: '2026-10-07T10:00:00.000000+00:00',
  hasKds: true,
  hasBoard: true,
  orders: [
    {
      orderId: '8f1c2a3b-0000-4000-8000-000000000001',
      source: 'kiosk',
      sourceRef: 'tx-1',
      displayRef: '20000057',
      pickupNumber: 57,
      tableRef: null,
      serviceType: 'take_away',
      pickupName: 'דנה',
      groupState: 'waiting',
      status: 'open',
      trackHandover: true,
      firstReleasedAt: '2026-10-07T09:48:00+00:00',
      readyAt: null,
      handedOverAt: null,
      machineId: 'm-1',
      areaId: 'a-1',
      items: [
        { name: 'המבורגר', qty: 2, ready: true },
        { name: "צ'יפס", qty: 1.5, ready: false },
      ],
    },
    {
      orderId: '8f1c2a3b-0000-4000-8000-000000000002',
      source: 'table',
      sourceRef: 'order-2',
      displayRef: null,
      pickupNumber: null,
      tableRef: '12',
      serviceType: 'eat_in',
      pickupName: null,
      groupState: 'ready_for_pickup',
      status: 'ready',
      trackHandover: false,
      firstReleasedAt: '2026-10-07T09:30:00+00:00',
      readyAt: '2026-10-07T09:55:00+00:00',
      handedOverAt: null,
      machineId: null,
      areaId: null,
      items: [],
    },
  ],
};

function order(id: string, group: ReadyGroup, o: Partial<ReadyOrder> = {}): ReadyOrder {
  return {
    orderId: id,
    source: 'quick',
    sourceRef: null,
    displayRef: null,
    pickupNumber: null,
    tableRef: null,
    service: null,
    pickupName: null,
    group,
    status: null,
    trackHandover: true,
    firstReleasedAt: null,
    readyAt: null,
    handedOverAt: null,
    machineId: null,
    areaId: null,
    items: [],
    pickupLabel: null,
    ...o,
  };
}

const pend = (p: Omit<ReadyPending, 'failed'>, failed = false): ReadyPending => ({ ...p, failed });

describe('the list (ReadyOrdersTest)', () => {
  it('a full list is read field by field', () => {
    const list = parseReadyOrders(FULL);
    expect(list.serverTime).toBe('2026-10-07T10:00:00.000000+00:00');
    expect(list.hasKds).toBe(true);
    expect(list.hasBoard).toBe(true);
    expect(list.orders).toHaveLength(2);
    const k = list.orders[0];
    expect(k).toMatchObject({
      orderId: '8f1c2a3b-0000-4000-8000-000000000001',
      source: 'kiosk',
      sourceRef: 'tx-1',
      displayRef: '20000057',
      pickupNumber: 57,
      tableRef: null,
      service: 'take_away',
      pickupName: 'דנה',
      group: 'waiting',
      status: 'open',
      trackHandover: true,
      firstReleasedAt: '2026-10-07T09:48:00+00:00',
      readyAt: null,
      handedOverAt: null,
      machineId: 'm-1',
      areaId: 'a-1',
    });
    expect(k.items).toEqual<ReadyItem[]>([
      { name: 'המבורגר', qty: 2, ready: true },
      { name: "צ'יפס", qty: 1.5, ready: false },
    ]);
    const t = list.orders[1];
    expect(t).toMatchObject({ source: 'table', tableRef: '12', service: 'eat_in', group: 'ready_for_pickup', trackHandover: false, readyAt: '2026-10-07T09:55:00+00:00', items: [] });
  });

  it('missing fields read as null or the defaults; an empty answer is an empty list', () => {
    const list = parseReadyOrders({ orders: [{ orderId: 'o-1' }] });
    expect(list).toMatchObject({ serverTime: null, hasKds: false, hasBoard: false });
    expect(list.orders[0]).toMatchObject({ source: 'other', sourceRef: null, pickupNumber: null, service: null, group: 'waiting', trackHandover: true, firstReleasedAt: null, items: [] });
    expect(parseReadyOrders({}).orders).toEqual([]);
    expect(parseReadyOrders(null).hasKds).toBe(false);
  });

  it('orders without an id or with an unknown state are left out, bad items too', () => {
    const list = parseReadyOrders({
      orders: [
        { groupState: 'waiting' },
        { orderId: '   ', groupState: 'waiting' },
        { orderId: 'o-cancelled', groupState: 'cancelled' },
        { orderId: 'o-ok', groupState: 'HANDED_OVER', pickupNumber: '41', serviceType: 'delivery', items: [{ qty: 1 }, { name: 'סלט' }, { name: '  ' }] },
        'not an object',
      ],
    });
    expect(list.orders).toHaveLength(1);
    const o = list.orders[0];
    expect(o.orderId).toBe('o-ok');
    expect(o.group).toBe('handed_over');
    expect(o.pickupNumber).toBe(41);
    expect(o.service).toBeNull();
    expect(o.items).toEqual([{ name: 'סלט', qty: 1, ready: false }]);
  });

  it('the headline: a kiosk label, the pickup number, the ref, the table, a short id; the ref beside a number only', () => {
    expect(headline(order('abcdef123', 'waiting', { pickupNumber: 57, displayRef: '20000057', tableRef: '4' }))).toEqual({ kind: 'pickup_number', text: '57' });
    expect(headline(order('abcdef123', 'waiting', { pickupLabel: ' A-17 ', pickupNumber: 17 }))).toEqual({ kind: 'pickup_number', text: 'A-17' });
    expect(headline(order('abcdef123', 'waiting', { displayRef: ' 20000057 ', tableRef: '4' }))).toEqual({ kind: 'display_ref', text: '20000057' });
    expect(headline(order('abcdef123', 'waiting', { displayRef: '  ', tableRef: 'VIP 1' }))).toEqual({ kind: 'table', text: 'VIP 1' });
    expect(headline(order('abcdef123', 'waiting'))).toEqual({ kind: 'short_id', text: 'ABCDEF' });
    expect(secondaryRef(order('o', 'waiting', { pickupNumber: 57, displayRef: '20000057' }))).toBe('20000057');
    expect(secondaryRef(order('o', 'waiting', { displayRef: '20000057' }))).toBeNull();
    expect(secondaryRef(order('o', 'waiting', { pickupNumber: 57 }))).toBeNull();
  });

  it('each state offers its own buttons; a tap moves one step, "מוכן" marks every item', () => {
    expect(actionsFor('waiting')).toEqual(['ready']);
    expect(actionsFor('ready_for_pickup')).toEqual(['handover', 'undo']);
    expect(actionsFor('handed_over')).toEqual(['undo']);
    const waiting = order('o', 'waiting', { items: [{ name: 'a', qty: 1, ready: false }, { name: 'b', qty: 2, ready: true }] });
    const ready = applyAction(waiting, 'ready');
    expect(ready.group).toBe('ready_for_pickup');
    expect(ready.items.every((i) => i.ready)).toBe(true);
    expect(applyAction(ready, 'handover').group).toBe('handed_over');
    expect(after('handed_over', 'undo')).toBe('ready_for_pickup');
    expect(after('ready_for_pickup', 'undo')).toBe('waiting');
    expect(applyAction(waiting, 'handover')).toBe(waiting);
    expect(after('waiting', 'undo')).toBe('waiting');
    expect(after('handed_over', 'ready')).toBe('handed_over');
  });

  it('an unconfirmed tap is shown only while the cloud still has the order where it was tapped', () => {
    const undo = pend({ id: 'tap-1', action: 'undo', orderId: 'o', from: 'handed_over' });
    const p = new Map([['o', undo]]);
    expect(withPending([order('o', 'handed_over')], p)[0].group).toBe('ready_for_pickup');
    expect(withPending([order('o', 'ready_for_pickup')], p)[0].group).toBe('ready_for_pickup');
    const other = order('x', 'waiting');
    expect(withPending([other], p)[0]).toBe(other);
  });

  it('three sections, each oldest first; a tap moves the row at once', () => {
    const s = sections([
      order('w2', 'waiting', { firstReleasedAt: '2026-10-07T09:50:00+00:00' }),
      order('r1', 'ready_for_pickup', { firstReleasedAt: '2026-10-07T09:20:00+00:00' }),
      order('h1', 'handed_over', { firstReleasedAt: '2026-10-07T09:00:00+00:00' }),
      order('w1', 'waiting', { firstReleasedAt: '2026-10-07T09:40:00+00:00' }),
      order('r2', 'ready_for_pickup', { firstReleasedAt: '2026-10-07T09:45:00+00:00' }),
    ]);
    expect(s.waiting.map((o) => o.orderId)).toEqual(['w1', 'w2']);
    expect(s.ready.map((o) => o.orderId)).toEqual(['r1', 'r2']);
    expect(s.handedOver.map((o) => o.orderId)).toEqual(['h1']);
    const moved = sections(withPending([order('a', 'waiting')], new Map([['a', pend({ id: 't', action: 'ready', orderId: 'a', from: 'waiting' })]])));
    expect(moved.waiting).toEqual([]);
    expect(moved.ready.map((o) => o.orderId)).toEqual(['a']);
  });

  it("minutes since release by the cloud's clock", () => {
    const serverNow = Date.parse('2026-10-07T10:00:00+00:00');
    const tillNow = serverNow - 120_000;
    const skew = skewMs('2026-10-07T10:00:00.000000+00:00', tillNow);
    expect(skew).toBe(120_000);
    expect(minutesSince('2026-10-07T09:48:00+00:00', tillNow, skew)).toBe(12);
    expect(minutesSince('2026-10-07T10:05:00+00:00', tillNow, skew)).toBe(0);
    expect(minutesSince(null, tillNow, skew)).toBeNull();
    expect(skewMs(null, tillNow)).toBe(0);
  });

  it('the action body, the outcomes, the refusals', () => {
    expect(actionBody('11111111-2222-3333-4444-555555555555', 'handover', 'o-1', ' דנה ', '2026-10-07T10:00:00.000Z')).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      type: 'handover',
      orderId: 'o-1',
      actorName: 'דנה',
      occurredAt: '2026-10-07T10:00:00.000Z',
    });
    expect(actionBody('1', 'ready', 'o-1', '  ', null)).toMatchObject({ actorName: null, occurredAt: null });
    expect(outcomeOf({ outcome: 'applied' })).toEqual({ kind: 'done' });
    expect(outcomeOf({ outcome: 'noop' })).toEqual({ kind: 'done' });
    expect(outcomeOf({ outcome: 'applied', replayed: true })).toEqual({ kind: 'done' });
    expect(outcomeOf({ outcome: 'rejected', reason: 'not_order_process' })).toEqual({ kind: 'rejected', message: 'not_order_process' });
    expect(outcomeOf({ outcome: 'rejected', reason: 'group_handed_over' })).toEqual({ kind: 'rejected', message: 'already_handed_over' });
    expect(outcomeOf({ outcome: 'rejected', reason: 'group_cancelled' })).toEqual({ kind: 'rejected', message: 'cancelled' });
    expect(outcomeOf({ outcome: 'rejected', reason: 'something_new' })).toEqual({ kind: 'rejected', message: 'refused' });
    expect(outcomeOf({ outcome: 'rejected', reason: null })).toEqual({ kind: 'rejected', message: 'refused' });
    expect(refusalMessage(404, 'order_not_found')).toBe('order_not_found');
    expect(refusalMessage(403, 'not_a_till')).toBe('not_a_till');
    expect(refusalMessage(403, 'device_not_fiscal')).toBe('device_not_fiscal');
    expect(refusalMessage(422, 'machine_has_no_shop')).toBe('no_shop');
    expect(refusalMessage(403, 'area_locked')).toBe('area_locked');
    expect(refusalMessage(404, null)).toBe('order_not_found');
    expect(refusalMessage(409, 'action_id_taken')).toBe('refused');
    expect(refusalMessage(400, null)).toBe('refused');
    expect(blocksList('not_a_till') && blocksList('device_not_fiscal') && blocksList('no_shop')).toBe(true);
    expect(blocksList('order_not_found') || blocksList('refused')).toBe(false);
    expect(refusalCode({ detail: 'not_a_till' })).toBe('not_a_till');
    expect(refusalCode({ detail: { code: 'area_locked', message: 'x' } })).toBe('area_locked');
    expect(refusalCode('x')).toBeNull();
  });

  it("the order's ⋮: its id and state from orders status, only what its state allows, in an order process only", () => {
    const body = { orders: { 't-1': { orderId: 'o-1', status: 'ready', groupState: 'ready_for_pickup', workflowMode: 'ORDER_PROCESS' }, 't-2': { status: 'open', groupState: 'waiting' } } };
    expect(statusOf(body, 't-1')).toEqual({ orderId: 'o-1', group: 'ready_for_pickup', workflowMode: 'ORDER_PROCESS' });
    expect(statusOf(body, 't-2')).toBeNull();
    expect(statusOf(body, 't-3')).toBeNull();
    expect(menuActions({ orderId: 'o', group: 'ready_for_pickup', workflowMode: 'ORDER_PROCESS' })).toEqual(['handover', 'undo']);
    expect(menuActions({ orderId: 'o', group: 'waiting', workflowMode: null })).toEqual(['ready']);
    expect(menuActions({ orderId: 'o', group: 'handed_over', workflowMode: 'order_process' })).toEqual(['undo']);
    expect(menuActions({ orderId: 'o', group: 'waiting', workflowMode: 'DIRECT_SALE' })).toEqual([]);
    expect(menuActions({ orderId: 'o', group: null, workflowMode: 'ORDER_PROCESS' })).toEqual([]);
    expect(menuActions(null)).toEqual([]);
  });

  it('the menu entry shows where orders go through a preparation process', () => {
    expect(readyOrdersOffered({})).toBe(false);
    expect(readyOrdersOffered({ kdsEnabled: 'true', workflowTargets: 'printer', workflowMode: 'DIRECT_SALE' })).toBe(false);
    expect(readyOrdersOffered({ kdsEnabled: 'true', workflowTargets: 'printer,pickup_screen' })).toBe(true);
    expect(readyOrdersOffered({ kdsEnabled: 'true', workflowTargets: 'printer', workflowMode: 'ORDER_PROCESS' })).toBe(true);
    expect(readyOrdersOffered({ kdsEnabled: 'true', workflowTargets: 'printer', workflowMode: 'DIRECT_SALE', workflowAllowedModes: 'DIRECT_SALE,ORDER_PROCESS' })).toBe(true);
    // A JSON array as text, and an array, read the same.
    expect(readyOrdersOffered({ kdsEnabled: true, workflowTargets: '["printer"]', workflowAllowedModes: ['ORDER_PROCESS'] })).toBe(true);
    expect(readyOrdersOffered({ kdsEnabled: 'false', workflowTargets: 'kds' })).toBe(false);
  });

  it("the words are Android's", () => {
    expect(READY_TEXT.title).toBe('הזמנות להכנה');
    expect([READY_TEXT.sectionWaiting, READY_TEXT.sectionReady, READY_TEXT.sectionHanded]).toEqual(['בהכנה', 'מוכן לאיסוף', 'נמסרו לאחרונה']);
    expect([READY_TEXT.actionReady, READY_TEXT.actionHandover, READY_TEXT.actionUndo]).toEqual(['מוכן', 'נמסר', 'החזר']);
    expect(READY_TEXT.minutes(12)).toBe('12 דק׳');
    expect(READY_TEXT.headlineTable('4')).toBe('שולחן 4');
    expect(READY_TEXT.msg.not_a_till).toBe('המכשיר הזה אינו קופה — אי אפשר לסמן ממנו הזמנות');
  });
});

/* ------------------------------------------------------------------ the engine */

const op = (name: string) => name as TillOp;
const PARAMS = { kdsEnabled: 'true', workflowTargets: 'printer,pickup_screen' };

describe('the engine', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.stop();
    h = null;
  });

  async function ready(answers: Record<string, (body: Record<string, unknown> | null) => unknown>, parameters: Record<string, unknown> = PARAMS) {
    h = harness({ parameters, answers });
    let n = 0;
    const f = h.engine.register(new TillReadyOrders(h.engine.ctx, { newId: () => `tap-${++n}` }));
    await h.ok('session.login', { pin: PIN });
    return { h, f };
  }

  it('nothing while nobody is signed in, or where the workflow does not offer it', async () => {
    h = harness({ parameters: PARAMS });
    h.engine.register(new TillReadyOrders(h.engine.ctx));
    expect((h.state() as unknown as Record<string, unknown>).readyOrders).toBeUndefined();
    h.stop();
    h = harness({ parameters: { kdsEnabled: 'true', workflowTargets: 'printer' } });
    h.engine.register(new TillReadyOrders(h.engine.ctx));
    await h.ok('session.login', { pin: PIN });
    expect((h.state() as unknown as Record<string, unknown>).readyOrders).toBeUndefined();
    expect((await h.fail(op('ready.refresh'))).code).toBe('invalid_args');
  });

  it('the list: loading, then the sections; a tap shown at once, sent with its id, the list again', async () => {
    let list = structuredClone(FULL);
    const { h, f } = await ready({
      'GET sync/m/kds/ready-orders': () => list,
      'POST sync/m/kds/ready-actions': () => {
        list = structuredClone(FULL);
        list.orders[0].groupState = 'ready_for_pickup';
        return { outcome: 'applied' };
      },
    });
    const view = () => (h.state() as unknown as { readyOrders: ReadyOrdersState }).readyOrders;
    expect(view()).toMatchObject({ loaded: false, empty: true, sections: [] });
    await h.ok(op('ready.refresh'));
    await f.lastWork;
    expect(view()).toMatchObject({ loaded: true, offline: false, hasKds: true, empty: false });
    expect(view().sections.map((s) => [s.key, s.count])).toEqual([
      ['waiting', 1],
      ['ready', 1],
    ]);
    const row = view().sections[0].rows[0];
    expect(row).toMatchObject({ headline: '57', meta: 'קיוסק · לקחת · דנה · 20000057', mode: 'actions', actions: [{ action: 'ready', label: 'מוכן', primary: true }] });
    expect(row.items).toEqual([
      { text: '2 × המבורגר', ready: true },
      { text: "1.50 × צ'יפס", ready: false },
    ]);
    expect(view().sections[1].rows[0]).toMatchObject({ headline: 'שולחן 12', headlineLtr: false, meta: 'שולחן · לשבת' });
    // An action its state does not offer: refused.
    expect((await h.fail(op('ready.tap'), { orderId: FULL.orders[0].orderId, action: 'handover' })).code).toBe('invalid_args');
    await h.ok(op('ready.tap'), { orderId: FULL.orders[0].orderId, action: 'ready' });
    await f.lastWork;
    const sent = h.sent.filter((s) => s.method === 'POST' && s.path === 'sync/m/kds/ready-actions');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ id: 'tap-1', type: 'ready', orderId: FULL.orders[0].orderId, actorName: 'דנה כהן' });
    expect(view().sections.map((s) => [s.key, s.count])).toEqual([['ready', 2]]);
    expect(view().sections[0].rows.find((r) => r.orderId === FULL.orders[0].orderId)?.actions.map((a) => a.action)).toEqual(['handover', 'undo']);
  });

  it('no answer: kept with "נסו שוב" — the same id; "ביטול הסימון" drops it', async () => {
    let up = false;
    const { h, f } = await ready({
      'GET sync/m/kds/ready-orders': () => FULL,
      'POST sync/m/kds/ready-actions': () => (up ? { outcome: 'applied' } : { __status: 503 }),
    });
    const view = () => (h.state() as unknown as { readyOrders: ReadyOrdersState }).readyOrders;
    await h.ok(op('ready.refresh'));
    await f.lastWork;
    const id = FULL.orders[1].orderId;
    await h.ok(op('ready.tap'), { orderId: id, action: 'handover' });
    // Shown at once, in its new section.
    expect(view().sections.find((s) => s.key === 'handed')?.rows[0]).toMatchObject({ orderId: id, mode: 'sending' });
    await f.lastWork;
    expect(view().sections.find((s) => s.key === 'handed')?.rows[0]).toMatchObject({ orderId: id, mode: 'failed' });
    // A second tap on the same order waits for the first.
    await h.ok(op('ready.tap'), { orderId: id, action: 'undo' });
    up = true;
    await h.ok(op('ready.retry'), { orderId: id });
    await f.lastWork;
    const posts = h.sent.filter((s) => s.method === 'POST' && s.path === 'sync/m/kds/ready-actions');
    expect(posts.map((p) => (p.body as { id: string }).id)).toEqual(['tap-1', 'tap-1']);
    // Then a failed one discarded: the cloud's state again.
    up = false;
    await h.ok(op('ready.tap'), { orderId: FULL.orders[0].orderId, action: 'ready' });
    await f.lastWork;
    await h.ok(op('ready.discard'), { orderId: FULL.orders[0].orderId });
    expect(view().sections.find((s) => s.key === 'waiting')?.rows[0]).toMatchObject({ orderId: FULL.orders[0].orderId, mode: 'actions' });
  });

  it('a refusal drops the tap and says why once at the top; "סגירת ההודעה" clears it', async () => {
    const { h, f } = await ready({
      'GET sync/m/kds/ready-orders': () => FULL,
      'POST sync/m/kds/ready-actions': () => ({ outcome: 'rejected', reason: 'group_cancelled' }),
    });
    const view = () => (h.state() as unknown as { readyOrders: ReadyOrdersState }).readyOrders;
    await h.ok(op('ready.refresh'));
    await f.lastWork;
    await h.ok(op('ready.tap'), { orderId: FULL.orders[0].orderId, action: 'ready' });
    await f.lastWork;
    expect(view().notice).toBe('ההזמנה בוטלה');
    expect(view().sections[0]).toMatchObject({ key: 'waiting', count: 1 });
    await h.ok(op('ready.dismiss'));
    expect(view().notice).toBeNull();
  });

  it('offline: the last list with the strip; a device the cloud refuses: said instead of a list', async () => {
    let mode: 'ok' | 'down' | 'refused' = 'ok';
    const { h, f } = await ready({
      'GET sync/m/kds/ready-orders': () => (mode === 'ok' ? FULL : mode === 'down' ? { __status: 503 } : { __status: 403, detail: 'device_not_fiscal' }),
    });
    const view = () => (h.state() as unknown as { readyOrders: ReadyOrdersState }).readyOrders;
    await h.ok(op('ready.refresh'));
    await f.lastWork;
    mode = 'down';
    await h.ok(op('ready.refresh'));
    await f.lastWork;
    expect(view()).toMatchObject({ offline: true, empty: false });
    mode = 'refused';
    await h.ok(op('ready.refresh'));
    await f.lastWork;
    expect(view().blocked).toBe('מכשיר תצוגה אינו קופה — אי אפשר לסמן ממנו הזמנות');
  });

  it("an order's ⋮: what its state allows; a tap said in a toast; no answer — the same id again", async () => {
    let up = true;
    const { h } = await ready({
      'GET sync/m/kds/orders/status': () => ({ orders: { 'tx-9': { orderId: 'o-9', groupState: 'waiting', workflowMode: 'ORDER_PROCESS' } } }),
      'POST sync/m/kds/ready-actions': () => (up ? { outcome: 'applied' } : { __status: 503 }),
    });
    expect(await h.ok(op('ready.status'), { source: 'quick', ref: 'tx-9' })).toEqual({ orderId: 'o-9', actions: [{ action: 'ready', label: 'מוכן' }] });
    expect(h.sent.some((s) => s.path === 'sync/m/kds/orders/status')).toBe(true);
    expect(await h.ok(op('ready.menuAction'), { source: 'quick', ref: 'tx-9', action: 'ready' })).toEqual({ kind: 'done', text: 'ההזמנה סומנה כמוכנה' });
    expect(await h.ok(op('ready.menuAction'), { source: 'quick', ref: 'tx-9', action: 'undo' })).toEqual({ kind: 'refused', text: 'השרת דחה את הפעולה' });
    up = false;
    expect(await h.ok(op('ready.menuAction'), { source: 'quick', ref: 'tx-9', action: 'ready' })).toMatchObject({ kind: 'offline' });
    up = true;
    expect(await h.ok(op('ready.menuRetry'), { ref: 'tx-9' })).toMatchObject({ kind: 'done' });
    const ids = h.sent.filter((s) => s.method === 'POST').map((s) => (s.body as { id: string }).id);
    expect(ids.slice(-2)).toEqual(['tap-2', 'tap-2']);
    expect((await h.fail(op('ready.status'), { source: 'fax', ref: 'x' })).code).toBe('invalid_args');
  });
});

/* ------------------------------------------------------------------ the screen */

describe('the screen', () => {
  const actions = { refresh: () => undefined, tap: () => undefined, retry: () => undefined, discard: () => undefined, dismiss: () => undefined };
  const render = (view: ReadyOrdersState | undefined) => renderToStaticMarkup(createElement(ReadyOrdersScreen, { view, actions, back: () => undefined }));

  it('loading, blocked, empty', () => {
    expect(render(undefined)).toContain('טוען הזמנות…');
    const base = readyOrdersView({ list: null, loaded: true, offline: false, blocked: 'no_shop', pending: new Map(), notice: null, nowMs: 0, skewMs: 0 });
    expect(render(base)).toContain('הקופה לא משויכת לסניף');
    const empty = render({ ...base, blocked: null });
    expect(empty).toContain('אין הזמנות בהכנה');
    expect(empty).toContain('הזמנות שנשלחות להכנה יופיעו כאן.');
  });

  it('the sections, the rows, the strips, a failed tap', () => {
    const list = parseReadyOrders(FULL);
    const view = readyOrdersView({
      list,
      loaded: true,
      offline: true,
      blocked: null,
      pending: new Map([[FULL.orders[1].orderId, pend({ id: 't', action: 'handover', orderId: FULL.orders[1].orderId, from: 'ready_for_pickup' }, true)]]),
      notice: 'already_handed_over',
      nowMs: Date.parse('2026-10-07T10:00:00Z'),
      skewMs: 0,
    });
    const html = render(view);
    for (const w of ['בהכנה', 'נמסרו לאחרונה', '57', '12 דק׳', 'מוכן', 'אין חיבור לשרת — הרשימה אולי לא מעודכנת', 'ההזמנה כבר נמסרה', 'יש מסכי מטבח בסניף — אפשר לסמן גם כאן', 'לא נשלח — אין חיבור לשרת. הלוח לא עודכן.', 'נסו שוב', 'ביטול הסימון', 'שולחן 12']) {
      expect(html).toContain(w);
    }
    expect(html).toContain('t-ready-item-done');
  });
});
