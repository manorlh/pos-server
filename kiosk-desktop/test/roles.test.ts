import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asksKdsDevice, isFiscal, normalizeRole, resolveRole, ROLE_INFO } from '../src/core/roles';
import { boardOf, columnFit, newlyReady } from '../src/core/pickupBoard';
import { boardView } from '../src/main/roles/board';
import { KdsFeed } from '../src/main/roles/feed';
import { Api } from '../src/main/sync/api';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';

describe('the role comes from the cloud', () => {
  const paired = { paired: true, deviceRole: null as unknown, kioskActive: false, kdsDevice: null };

  it('nothing before pairing; unknown until machines/me says', () => {
    expect(resolveRole({ ...paired, paired: false, deviceRole: 'kiosk' })).toBe(null);
    expect(resolveRole(paired)).toBe(null);
  });

  it('the roles set at "הוספת מכשיר"', () => {
    expect(resolveRole({ ...paired, deviceRole: 'till' })).toBe('till');
    expect(resolveRole({ ...paired, deviceRole: 'kds' })).toBe('kds');
    expect(resolveRole({ ...paired, deviceRole: 'order_status_board' })).toBe('order_status_board');
    expect(resolveRole({ ...paired, deviceRole: 'kiosk' })).toBe('kiosk');
  });

  it('the kiosk always wins: today’s kiosk is unchanged', () => {
    expect(resolveRole({ ...paired, deviceRole: 'till', kioskActive: true })).toBe('kiosk');
    expect(resolveRole({ ...paired, deviceRole: null, kioskActive: true })).toBe('kiosk');
  });

  it('a KDS device made on the KDS page; its pickup role is the board', () => {
    expect(resolveRole({ ...paired, deviceRole: 'till', kdsDevice: { role: 'expo' } })).toBe('kds');
    expect(resolveRole({ ...paired, deviceRole: 'till', kdsDevice: { role: 'pickup' } })).toBe('order_status_board');
    expect(resolveRole({ ...paired, deviceRole: 'kds', kdsDevice: { role: 'pickup' } })).toBe('order_status_board');
    expect(resolveRole({ ...paired, deviceRole: 'till', kdsDevice: { role: 'station', isActive: false } })).toBe('till');
  });

  it('screens are never fiscal; spellings are read leniently', () => {
    expect(isFiscal('kiosk')).toBe(true);
    expect(isFiscal('till')).toBe(true);
    expect(isFiscal('kds')).toBe(false);
    expect(isFiscal('order_status_board')).toBe(false);
    expect(isFiscal(null)).toBe(false);
    expect(normalizeRole('Order-Status-Board')).toBe('order_status_board');
    expect(normalizeRole('pickup')).toBe('order_status_board');
    expect(normalizeRole('robot')).toBe(null);
    expect(ROLE_INFO.till.ready).toBe(false);
  });

  it('asks kds/device only for a screen or a till flagged kdsScreen (as the Android till)', () => {
    expect(asksKdsDevice('till', false)).toBe(false);
    expect(asksKdsDevice('till', true)).toBe(true);
    expect(asksKdsDevice('kds', false)).toBe(true);
    expect(asksKdsDevice('order_status_board', false)).toBe(true);
  });
});

describe('the order status board', () => {
  it('numbers only, deduplicated; a number both preparing and ready is ready', () => {
    const b = boardOf({
      preparing: [{ number: 12, since: '2026-10-07T10:00:00Z' }, { number: '13' }, { number: '13' }, { number: '' }, { name: 'x' }, { number: '14' }],
      ready: [{ number: '14', since: null }],
    });
    expect(b.preparing.map((n) => n.number)).toEqual(['12', '13']);
    expect(b.ready).toEqual([{ number: '14', since: null }]);
    expect(boardOf(null)).toEqual({ preparing: [], ready: [] });
  });

  it('announces only numbers that turned ready (never the first board)', () => {
    expect(newlyReady(null, [{ number: '1', since: null }])).toEqual([]);
    expect(newlyReady([{ number: '1', since: null }], [{ number: '2', since: null }, { number: '1', since: null }])).toEqual(['2']);
    expect(columnFit(3).size).toBe('xl');
    expect(columnFit(20).cols).toBe(4);
  });

  it('a device that is not a pickup screen says so', () => {
    const s = { okAt: 1, offline: false, notConfigured: false, serverOffsetMs: 0 };
    expect(boardView({ ...s, body: { orders: [] } }).notConfigured).toBe(true);
    expect(boardView({ ...s, body: { shopName: 'הרצליה', pickup: { preparing: [{ number: '5' }], ready: [] } } })).toMatchObject({ shopName: 'הרצליה', notConfigured: false, preparing: [{ number: '5', since: null }] });
  });
});

describe('the KDS feed', () => {
  function feedWorld(answers: Array<{ status: number; body?: unknown } | 'offline'>) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r2m-feed-'));
    const db = openDb(path.join(dir, 'k.db'));
    migrate(db);
    const kv = new Kv(db);
    const urls: string[] = [];
    let now = 1_000_000;
    const fetchFn: typeof fetch = async (input) => {
      urls.push(String(input));
      const a = answers.shift() ?? 'offline';
      if (a === 'offline') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
    };
    const api = new Api('http://cloud.test/api/v1/', () => 'tok', fetchFn);
    const make = () => new KdsFeed({ api, kv, machineId: () => 'm1', log: () => undefined }, 'role.board.cache', 3_000, () => now);
    return { make, urls, tick: (ms: number) => (now += ms) };
  }

  it('asks with the version it has, keeps the last board through an outage and a restart', async () => {
    const w = feedWorld([
      { status: 200, body: { syncType: 'full', version: 7, serverTime: '2026-10-07T10:00:00Z', pickup: { preparing: [{ number: '1' }], ready: [] } } },
      { status: 200, body: { syncType: 'unchanged', version: 7 } },
      'offline',
      'offline',
    ]);
    const feed = w.make();
    await feed.poll();
    expect(w.urls[0]).toMatch(/sync\/m1\/kds\/board$/);
    await feed.poll();
    expect(w.urls[1]).toMatch(/kds\/board\?since=7$/);
    expect(feed.state().offline).toBe(false);
    w.tick(5_000);
    await feed.poll();
    expect(feed.state().offline).toBe(false); // a short blip is not "offline" yet
    w.tick(20_000);
    await feed.poll();
    expect(feed.state().offline).toBe(true);
    expect(feed.state().body?.version).toBe(7);
    // A restart without internet: the last board is there at once.
    expect(w.make().state().body?.version).toBe(7);
  });

  it('a machine the cloud does not know as a KDS screen', async () => {
    const w = feedWorld([{ status: 403, body: { detail: 'not_a_kds_device' } }]);
    const feed = w.make();
    await feed.poll();
    expect(feed.state().notConfigured).toBe(true);
  });
});
