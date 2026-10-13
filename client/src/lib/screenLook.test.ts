/**
 * Run with `npm test`. The screens' look (docs/SPEC_KDS.md §14, lib/screenLook.ts): the cloud's
 * `device.display` cleaned — nothing / a v1 board look / garbage all draw today's screens; the
 * thresholds go together; the demo's address and the address of a look round-trip; the timer uses
 * the screen's thresholds and can drop its colours; the board keeps a ready number its minutes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BOARD_DISPLAY,
  DEFAULT_KDS_BEHAVIOUR,
  DEFAULT_KDS_DISPLAY,
  boardDisplayOf,
  kdsBehaviourOf,
  kdsDisplayOf,
  lookFromQuery,
  lookQuery,
  screenDisplayInput,
  screenDisplayOf,
  screenThresholds,
} from './screenLook';
import { gridFit, newestFirst, readyWithin } from './pickupBoard';
import { orderTimer } from './kdsBoard';
import type { KdsOrder, KdsTask } from './kdsScreenTypes';

const T0 = Date.UTC(2026, 9, 7, 10, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function task(extra: Partial<KdsTask> = {}): KdsTask {
  return {
    id: 't1', orderId: 'o1', roundNo: 1, stationId: 's1', stationName: 'גריל', targetKind: 'prep', required: true, lineKey: 't1',
    name: 'המבורגר', mods: [], removals: [], notes: null, allergies: [], important: false, seat: null, course: null, mealName: null,
    orderedQty: 1, cancelledQty: 0, preparedQty: 0, activeQty: 1, release: 'released', state: 'queued', version: 1,
    releasedAt: at(0), startedAt: null, readyAt: null, ...extra,
  };
}

function order(tasks: KdsTask[]): KdsOrder {
  return {
    id: 'o1', source: 'kiosk', displayRef: '41', tableRef: null, zoneName: null, serviceType: 'take_away', guests: null,
    waiterName: null, pickupName: null, orderNote: null, pickupNumber: 41, workflowMode: 'ORDER_PROCESS', paid: true, status: 'open',
    priority: 0, groupState: 'waiting', readyAt: null, allReady: false, requireExpo: true, requireStart: false, trackHandover: true,
    viewOnly: false, firstReleasedAt: at(0), createdAt: at(0), version: 1, tasks, changes: [],
  };
}

describe('the look, cleaned', () => {
  it('nothing, an empty object and garbage are all today’s screens', () => {
    for (const raw of [null, undefined, {}, 'x', 7, []]) {
      assert.deepEqual(kdsDisplayOf(raw), DEFAULT_KDS_DISPLAY);
      assert.deepEqual(boardDisplayOf(raw), DEFAULT_BOARD_DISPLAY);
    }
    assert.equal(DEFAULT_KDS_DISPLAY.layout, 'tickets');
    assert.equal(DEFAULT_BOARD_DISPLAY.boardLayout, 'columns');
    assert.deepEqual(DEFAULT_KDS_DISPLAY.sounds, { new: 'chime', change: 'knock', late: 'off' });
    assert.ok(Object.values(DEFAULT_KDS_DISPLAY.fields).every(Boolean));
  });

  it('a v1 board look keeps its five keys, everything else today’s', () => {
    const b = boardDisplayOf({ theme: 'light', accent: '#16A34A', sound: false, showPreparing: false, title: ' איסוף ' });
    assert.deepEqual(b, { ...DEFAULT_BOARD_DISPLAY, theme: 'light', accent: '#16a34a', sound: false, showPreparing: false, title: 'איסוף' });
  });

  it('a full v2 look, and every bad value back to its default', () => {
    const k = kdsDisplayOf({
      v: 2, theme: 'contrast', layout: 'list', columnsBy: 'course', density: 'large', fontScale: 1.234, ageColors: false,
      warnMinutes: 8, lateMinutes: 12, fields: { waiter: false, x: false }, sounds: { new: 'bell', change: 'siren' }, clock: false,
    });
    assert.equal(k.layout, 'list');
    assert.equal(k.fontScale, 1.23);
    assert.equal(k.fields.waiter, false);
    assert.equal(k.fields.allergens, true);
    assert.deepEqual(k.sounds, { new: 'bell', change: 'knock', late: 'off' });
    assert.equal(k.clock, false);
    assert.equal(k.counts, true);
    const bad = kdsDisplayOf({ layout: 'mosaic', density: 'huge', fontScale: 9, warnMinutes: 12, lateMinutes: 8 });
    assert.equal(bad.layout, 'tickets');
    assert.equal(bad.density, 'normal');
    assert.equal(bad.fontScale, 1.6);
    assert.equal(kdsDisplayOf({ fontScale: 0.1 }).fontScale, 0.8);
    // Late before the warning, or one alone: the stations' thresholds.
    assert.equal(bad.warnMinutes, null);
    assert.equal(kdsDisplayOf({ warnMinutes: 8 }).warnMinutes, null);
  });

  it('the board’s media: http(s) only from the cloud, a picture made in the page, at most 12', () => {
    const b = boardDisplayOf({
      boardLayout: 'split', readyMinutes: 10, promoText: '  שתייה   ב-5 ',
      media: [{ url: 'ftp://x/a.jpg' }, { url: 'https://cdn.test/a.mp4', kind: 'video', durationSec: 1 }, { url: 'data:image/svg+xml,%3Csvg%3E' }, 'junk'],
    });
    assert.equal(b.boardLayout, 'split');
    assert.equal(b.readyMinutes, 10);
    assert.equal(b.promoText, 'שתייה ב-5');
    assert.deepEqual(b.media.map((m) => [m.kind, m.durationSec]), [['video', 8], ['image', 8]]);
    assert.equal(boardDisplayOf({ media: Array.from({ length: 20 }, (_, i) => ({ url: `https://x.test/${i}.jpg` })) }).media.length, 12);
    assert.equal(boardDisplayOf({ readyMinutes: 0 }).readyMinutes, null);
  });

  it('the body the cloud takes trims the texts', () => {
    const body = screenDisplayInput({ ...screenDisplayOf({}), title: '  כותרת  ', promoText: '   ' });
    assert.equal(body.title, 'כותרת');
    assert.equal(body.promoText, null);
  });
});

describe('the address', () => {
  it('the demo’s switches make a look, and a look its address', () => {
    const k = lookFromQuery(new URLSearchParams('layout=columns&by=course&theme=light&density=compact&font=1.2&age=8-12&hide=waiter,guests&clock=0&sound=late:beep'), 'kds');
    assert.equal(k.layout, 'columns');
    assert.equal(k.columnsBy, 'course');
    assert.equal(k.theme, 'light');
    assert.equal(k.density, 'compact');
    assert.equal(k.fontScale, 1.2);
    assert.deepEqual([k.warnMinutes, k.lateMinutes], [8, 12]);
    assert.equal(k.fields.waiter, false);
    assert.equal(k.fields.notes, true);
    assert.equal(k.clock, false);
    assert.equal(k.sounds.late, 'beep');
    const back = lookFromQuery(new URLSearchParams(lookQuery(k, 'kds').split('?')[1]), 'kds');
    assert.deepEqual(kdsDisplayOf(back), kdsDisplayOf(k));
    assert.equal(lookFromQuery(new URLSearchParams('age=off'), 'kds').ageColors, false);
    assert.equal(lookQuery(screenDisplayOf({}), 'kds'), '/kds?demo=1');
  });

  it('the board’s switches, the demo’s pictures and back', () => {
    const demo = [{ url: 'data:image/svg+xml,%3Csvg%3E', kind: 'image' as const, sha256: null, bytes: null, durationSec: 8 }];
    const b = lookFromQuery(new URLSearchParams('layout=ticker&prep=0&ready=7&media=demo&promo=מבצע'), 'board', demo);
    assert.equal(b.boardLayout, 'ticker');
    assert.equal(b.showPreparing, false);
    assert.equal(b.readyMinutes, 7);
    assert.equal(b.media.length, 1);
    assert.equal(b.promoText, 'מבצע');
    const urls = lookFromQuery(new URLSearchParams('media=https://cdn.test/a.jpg,https://cdn.test/b.mp4'), 'board');
    assert.deepEqual(urls.media.map((m) => m.kind), ['image', 'video']);
    const q = new URLSearchParams(lookQuery({ ...b, media: [] }, 'board').split('?')[1]);
    assert.equal(q.get('layout'), 'ticker');
    assert.equal(q.get('prep'), '0');
    assert.equal(q.get('ready'), '7');
  });
});

describe('how the kitchen screen behaves (§16)', () => {
  const TODAY = {
    toolbar: true, allDay: false, itemTap: 'button', ticketOrder: 'fifo', perRow: null, maxTicketHeight: null, keepReadyOpen: true,
    filterFullTicket: false, stationRush: false, urgencyLevels: false, overflowAt: null,
    orderTypes: { eatIn: true, takeAway: true, delivery: true }, externalOrders: 'all', serviceTint: { takeAway: false, delivery: false },
    ticketInfo: { source: true, orderTime: false, orderNumber: false, readyBy: false },
  };

  it('nothing stored is today’s behaviour, and the server’s defaults are the same', () => {
    assert.deepEqual(kdsBehaviourOf(null), DEFAULT_KDS_BEHAVIOUR);
    assert.deepEqual(DEFAULT_KDS_BEHAVIOUR, TODAY);
    const k = kdsDisplayOf({});
    assert.deepEqual(Object.fromEntries(Object.keys(TODAY).map((key) => [key, (k as unknown as Record<string, unknown>)[key]])), TODAY);
  });

  it('every look of before resolves exactly as before (its keys and today’s behaviour)', () => {
    const before = {
      v: 2, theme: 'light', accent: '#123456', layout: 'rail', columnsBy: 'course', density: 'compact', fontScale: 1.2, ageColors: false,
      warnMinutes: 5, lateMinutes: 9, clock: false, counts: false, fields: { table: false, waiter: false }, sounds: { new: 'bell' },
    };
    const k = kdsDisplayOf(before);
    assert.deepEqual([k.theme, k.accent, k.layout, k.columnsBy, k.density, k.fontScale], ['light', '#123456', 'rail', 'course', 'compact', 1.2]);
    assert.deepEqual([k.ageColors, k.warnMinutes, k.lateMinutes, k.clock, k.counts], [false, 5, 9, false, false]);
    assert.equal(k.fields.table, false);
    assert.equal(k.sounds.new, 'bell');
    // The source chip was the "table" switch: hidden there, hidden still.
    assert.equal(k.ticketInfo.source, false);
    assert.equal(k.itemTap, 'button');
    assert.equal(k.toolbar, true);
    for (const layout of ['tickets', 'columns', 'rail', 'list', 'big']) assert.equal(kdsDisplayOf({ layout }).layout, layout);
  });

  it('a full behaviour, and every bad value back to today’s', () => {
    const b = kdsBehaviourOf({
      toolbar: false, allDay: true, itemTap: 'cycle', ticketOrder: 'lifo', perRow: 6, maxTicketHeight: 500, keepReadyOpen: false,
      filterFullTicket: true, stationRush: true, urgencyLevels: true, overflowAt: 25, orderTypes: { takeAway: false },
      externalOrders: 'only', serviceTint: { delivery: true }, ticketInfo: { orderTime: true, readyBy: true, source: false },
    });
    assert.deepEqual([b.toolbar, b.allDay, b.itemTap, b.ticketOrder, b.perRow, b.maxTicketHeight], [false, true, 'cycle', 'lifo', 6, 500]);
    assert.deepEqual([b.keepReadyOpen, b.filterFullTicket, b.stationRush, b.urgencyLevels, b.overflowAt], [false, true, true, true, 25]);
    assert.deepEqual(b.orderTypes, { eatIn: true, takeAway: false, delivery: true });
    assert.equal(b.externalOrders, 'only');
    assert.deepEqual(b.serviceTint, { takeAway: false, delivery: true });
    assert.deepEqual(b.ticketInfo, { source: false, orderTime: true, orderNumber: false, readyBy: true });
    const bad = kdsBehaviourOf({ itemTap: 'double', ticketOrder: 'random', perRow: 1, maxTicketHeight: 100, overflowAt: 500, externalOrders: 'x', toolbar: 'no' });
    assert.deepEqual([bad.itemTap, bad.ticketOrder, bad.perRow, bad.maxTicketHeight, bad.overflowAt, bad.externalOrders, bad.toolbar], ['button', 'fifo', null, null, null, 'all', true]);
    assert.equal(kdsBehaviourOf({ perRow: 11 }).perRow, null);
    assert.equal(kdsBehaviourOf({ maxTicketHeight: 3001 }).maxTicketHeight, null);
  });

  it('the demo’s switches and back', () => {
    const q = 'tap=ready&order=lifo&row=7&maxh=600&keep=0&full=1&rush=1&levels=1&overflow=30&types=takeAway&ext=hide&tint=delivery&info=orderTime,readyBy&hide=source&toolbar=0&allday=1';
    const k = lookFromQuery(new URLSearchParams(q), 'kds');
    assert.deepEqual([k.itemTap, k.ticketOrder, k.perRow, k.maxTicketHeight, k.keepReadyOpen, k.filterFullTicket], ['ready', 'lifo', 7, 600, false, true]);
    assert.deepEqual([k.stationRush, k.urgencyLevels, k.overflowAt, k.externalOrders, k.toolbar, k.allDay], [true, true, 30, 'hide', false, true]);
    assert.deepEqual(k.orderTypes, { eatIn: true, takeAway: false, delivery: true });
    assert.deepEqual(k.serviceTint, { takeAway: false, delivery: true });
    assert.deepEqual(k.ticketInfo, { source: false, orderTime: true, orderNumber: false, readyBy: true });
    assert.equal(k.fields.table, true);
    const back = lookFromQuery(new URLSearchParams(lookQuery(k, 'kds').split('?')[1]), 'kds');
    assert.deepEqual(kdsDisplayOf(back), kdsDisplayOf(k));
    // The table hidden, the source shown on its own: said too.
    const own = screenDisplayOf({ fields: { table: false }, ticketInfo: { source: true } });
    assert.equal(lookFromQuery(new URLSearchParams(lookQuery(own, 'kds').split('?')[1]), 'kds').ticketInfo.source, true);
    assert.equal(lookQuery(screenDisplayOf({}), 'kds'), '/kds?demo=1');
  });
});

describe('the timer and the board', () => {
  it('the screen’s own thresholds beat the stations’, and the colours can go', () => {
    const o = order([task()]);
    const settings = { s1: { targetKind: 'prep', warnMinutes: 10, lateMinutes: 20 } };
    const look = { thresholds: screenThresholds({ warnMinutes: 8, lateMinutes: 12 }) };
    assert.equal(orderTimer(o, settings, T0 + 7 * 60_000, look).level, 'normal');
    assert.equal(orderTimer(o, settings, T0 + 8 * 60_000, look).level, 'warn');
    assert.equal(orderTimer(o, settings, T0 + 12 * 60_000, look).level, 'late');
    // Without the screen's: the stations' (10 / 20) as before.
    assert.equal(orderTimer(o, settings, T0 + 12 * 60_000).level, 'warn');
    assert.equal(orderTimer(o, settings, T0 + 12 * 60_000, { thresholds: screenThresholds(DEFAULT_KDS_DISPLAY) }).level, 'warn');
    // Colours off: the minutes only.
    assert.deepEqual(orderTimer(o, settings, T0 + 30 * 60_000, { ageColors: false }), { minutes: 30, level: 'normal' });
    // Ready is still ready.
    assert.equal(orderTimer(order([task({ state: 'ready', preparedQty: 1 })]), settings, T0, { ageColors: false }).level, 'done');
  });

  it('a ready number stays its minutes; the newest first; the grid fills the screen', () => {
    const now = T0 + 20 * 60_000;
    const list = [{ number: '1', since: at(1) }, { number: '2', since: at(15) }, { number: '3', since: null }];
    assert.deepEqual(readyWithin(list, 10, now).map((n) => n.number), ['2', '3']);
    assert.equal(readyWithin(list, null, now).length, 3);
    assert.deepEqual(newestFirst(list).map((n) => n.number), ['2', '1', '3']);
    assert.deepEqual(gridFit(1, 1600, 900), { cols: 1, rows: 1 });
    const many = gridFit(24, 1600, 800);
    assert.ok(many.cols * many.rows >= 24 && many.cols > many.rows);
  });
});
