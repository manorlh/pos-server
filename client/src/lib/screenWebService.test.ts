/**
 * Run with `npm test`. The browser KDS and board (`/kds`, `/board` — docs/SPEC_KDS.md §13): their
 * local service (lib/screenWebService.ts) on the Windows app's engine (lib/kdsScreenEngine.ts)
 * against a pretend cloud — pairing (the browser says "web", a code of another route hands over),
 * the storage (a database per route, credentials mirrored to localStorage, a reload with no
 * network shows the last board), the bridge the shared screens read, the offline queue (actions
 * kept in order and sent with the same ids when the network is back), a revoked token, the
 * heartbeat; the board's look; the screens' service worker.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ScreenKv, ScreenWebService, routeOfRole, screenKeys, screenStoreOptions, type ScreenRoute, type ScreenWebDeps } from './screenWebService';
import { MemoryStore, openKioskStore, type StorageLike } from './kioskWebStore';
import { webDeviceInfo, type FetchFn } from './kioskWebApi';
import { KDS_OUTBOX_KEY, QUEUED_TEXT, boardView, feedShows, uuid4, type FeedState } from './kdsScreenEngine';
import { boardDisplayOf, textOn, DEFAULT_BOARD_DISPLAY } from './pickupBoard';
import type { KdsOrder, KdsTask } from './kdsScreenTypes';
import { bridgeCanPrint, bridgeLine, bridgeRoleOf, kdsBonDoc } from './screenBridge';
import { BridgeClient, NO_BRIDGE, bridgeStoreKey } from './kioskBridge';

type Call = { method: string; path: string; body: Record<string, unknown> | null; auth: string | null };
type Handler = (c: Call) => { status: number; body?: unknown } | 'offline';

const SERVER = 'http://cloud.test';
const T0 = Date.UTC(2026, 9, 7, 10, 0, 0);

function task(id: string, extra: Partial<KdsTask> = {}): KdsTask {
  return {
    id, orderId: 'o1', roundNo: 1, stationId: 'grill', stationName: 'גריל', targetKind: 'prep', required: true, lineKey: id,
    name: 'המבורגר', mods: [], removals: [], notes: null, allergies: [], important: false, seat: null, course: null, mealName: null,
    orderedQty: 1, cancelledQty: 0, preparedQty: 0, activeQty: 1, release: 'released', state: 'queued', version: 3,
    releasedAt: new Date(T0 - 60_000).toISOString(), startedAt: null, readyAt: null, ...extra,
  };
}

function order(): KdsOrder {
  return {
    id: 'o1', source: 'kiosk', displayRef: '41', tableRef: null, zoneName: null, serviceType: 'take_away', guests: null, waiterName: null,
    pickupName: null, orderNote: null, pickupNumber: 41, workflowMode: 'ORDER_PROCESS', paid: true, status: 'open', priority: 0,
    groupState: 'waiting', readyAt: null, allReady: false, requireExpo: true, requireStart: false, trackHandover: true, viewOnly: false,
    firstReleasedAt: new Date(T0 - 60_000).toISOString(), createdAt: new Date(T0 - 60_000).toISOString(), version: 5,
    tasks: [task('t1'), task('t2', { name: 'צ׳יפס' })], changes: [],
  };
}

/** The cloud: a station screen ("גריל") by default; `role: 'pickup'` makes it the board. */
function fakeCloud(opts: { deviceRole?: string; screen?: 'station' | 'pickup'; display?: unknown } = {}, over: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const posts: Array<Record<string, unknown>> = [];
  let online = true;
  let version = 10;
  const screen = opts.screen ?? 'station';
  const handlers: Record<string, Handler> = {
    'POST pairing/validate': () => ({ status: 200, body: { accessToken: 'tok', machineId: 'm1', machineCode: 'MC', tenantId: 't1', shopId: 's1' } }),
    'GET machines/me': () => ({ status: 200, body: { machineId: 'm1', machineName: 'מסך גריל', shopName: 'הרצליה', deviceRole: opts.deviceRole ?? 'kds', fiscal: false, platform: 'web' } }),
    'POST machines/me/heartbeat': () => ({ status: 200, body: { ok: true } }),
    'GET sync/m1/parameters': () => ({ status: 200, body: { parameters: { technicianCode: 'pbkdf2-sha256$1000$abc' } } }),
    'GET sync/m1/kds/board': (c) => {
      const since = new URL(`http://x/${c.path}`).searchParams.get('since');
      const base = { serverTime: new Date(T0 + 60_000).toISOString(), version, shopName: 'הרצליה' };
      if (since !== null && Number(since) === version) return { status: 200, body: { syncType: 'unchanged', ...base } };
      if (screen === 'pickup') {
        return {
          status: 200,
          body: { syncType: 'full', ...base, device: { id: 'd9', name: 'TV', role: 'pickup', stations: [], display: opts.display ?? null }, pickup: { preparing: [{ number: '41', since: null }], ready: [{ number: '40', since: null }] } },
        };
      }
      return {
        status: 200,
        body: {
          syncType: 'full', ...base,
          device: { id: 'd1', name: 'גריל 1', role: 'station', stations: [{ id: 'grill', name: 'גריל' }] },
          orders: [order()],
          stationSettings: { grill: { targetKind: 'prep', warnMinutes: 5, lateMinutes: 10 } },
        },
      };
    },
    'POST sync/m1/kds/actions': (c) => {
      posts.push(c.body ?? {});
      version += 1;
      return { status: 200, body: { outcome: 'applied', order: { id: 'o1', version: 6 } } };
    },
    ...over,
  };
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1\//, '') + url.search;
    const call: Call = { method: init.method, path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization ?? null };
    calls.push(call);
    if (!online) throw new TypeError('Failed to fetch');
    const h = handlers[`${init.method} ${path.split('?')[0]}`];
    const r = h ? h(call) : { status: 404, body: { detail: 'Not Found' } };
    if (r === 'offline') throw new TypeError('Failed to fetch');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)), headers: { get: () => null } };
  };
  return { fetchFn, calls, posts, handlers, setOnline: (v: boolean) => (online = v) };
}

const made: ScreenWebService[] = [];
afterEach(() => {
  for (const s of made.splice(0)) s.stop();
});

function service(cloud: ReturnType<typeof fakeCloud>, route: ScreenRoute = 'kds', store = new MemoryStore(), extra: Partial<ScreenWebDeps> = {}) {
  let n = 0;
  const svc = new ScreenWebService({
    route,
    store,
    fetchFn: cloud.fetchFn,
    defaultServer: SERVER,
    appVersion: `web-${route}-test`,
    deviceInfo: () => ({ ...webDeviceInfo({ userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-T220) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' }, 'test'), client: `r2m-web-${route}` }),
    now: () => T0,
    uuid: () => `act-${String(++n).padStart(4, '0')}-0000`,
    feedEveryMs: 3_600_000,
    timers: { set: () => 0, clear: () => undefined },
    ...extra,
  });
  made.push(svc);
  return svc;
}

class FakeStorage implements StorageLike {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
}

describe('pairing a browser screen', () => {
  it('pairs with the code alone: the browser says web, the cloud says what it is', async () => {
    const cloud = fakeCloud();
    const store = new MemoryStore();
    const svc = service(cloud, 'kds', store);
    assert.equal((await svc.init()).phase, 'unpaired');
    const r = await svc.pair({ code: 'ab12-cd34', machineName: 'מסך גריל' });
    assert.deepEqual(r, { ok: true, handoff: null });
    const validate = cloud.calls.find((c) => c.path === 'pairing/validate');
    assert.equal(validate?.auth, null);
    assert.equal(validate?.body?.code, 'AB12CD34');
    const info = validate?.body?.device_info as Record<string, string>;
    assert.equal(info.platform, 'web');
    assert.equal(info.client, 'r2m-web-kds');
    const v = svc.view();
    assert.equal(v.phase, 'ready');
    assert.equal(v.machine?.name, 'מסך גריל');
    assert.equal(v.machine?.deviceRole, 'kds');
    assert.equal(v.technicianCode, 'pbkdf2-sha256$1000$abc');
    assert.equal((await store.get<{ accessToken: string }>(screenKeys('kds').credentials))?.accessToken, 'tok');
    // Every later call carries the machine token.
    await svc.refresh();
    assert.equal(cloud.calls.find((c) => c.path.startsWith('sync/m1/kds/board'))?.auth, 'Bearer tok');
  });

  it("a board's code typed at /kds hands over to /board (and a kiosk's to /k)", async () => {
    for (const [role, target] of [['order_status_board', 'board'], ['kiosk', 'k']] as const) {
      const store = new MemoryStore();
      const svc = service(fakeCloud({ deviceRole: role }), 'kds', store);
      await svc.init();
      const r = await svc.pair({ code: 'AB12CD34', machineName: 'x' });
      assert.deepEqual(r, { ok: true, handoff: target });
      assert.equal(svc.handedOver?.accessToken, 'tok');
      assert.equal(svc.view().phase, 'unpaired');
      assert.equal(await store.get(screenKeys('kds').credentials), null);
    }
    assert.deepEqual([routeOfRole('kds'), routeOfRole('order_status_board'), routeOfRole('kiosk'), routeOfRole('till'), routeOfRole(null)], ['kds', 'board', 'k', null, null]);
  });

  it("says the cloud's refusal as it is (a wrong code, another platform's code)", async () => {
    const mismatch = fakeCloud({}, {
      'POST pairing/validate': () => ({ status: 422, body: { detail: 'platform_mismatch', message: 'קוד הצימוד נוצר למכשיר Android, אבל המכשיר הזה הוא דפדפן (Web).' } }),
    });
    const svc = service(mismatch);
    await svc.init();
    const r = await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /דפדפן/);
    const wrong = service(fakeCloud({}, { 'POST pairing/validate': () => ({ status: 400, body: { detail: 'Invalid or expired pairing code' } }) }));
    await wrong.init();
    const w = await wrong.pair({ code: 'AB12CD34', machineName: 'x' });
    assert.equal(w.ok ? '' : w.error, 'קוד הצימוד שגוי או שפג תוקפו');
    assert.equal(wrong.view().phase, 'unpaired');
  });
});

describe('storage', () => {
  it('a database per route; the credentials mirrored to localStorage under the route’s own keys', async () => {
    const ls = new FakeStorage();
    // No IndexedDB here: localStorage itself (the fallback), each key named by its route.
    const kds = await openKioskStore({ localStorage: ls }, screenStoreOptions('kds'));
    const board = await openKioskStore({ localStorage: ls }, screenStoreOptions('board'));
    assert.equal(kds.kind, 'localstorage');
    await kds.set(screenKeys('kds').credentials, { accessToken: 'a' });
    await board.set(screenKeys('board').credentials, { accessToken: 'b' });
    assert.deepEqual(await kds.get(screenKeys('kds').credentials), { accessToken: 'a' });
    assert.deepEqual(await board.get(screenKeys('board').credentials), { accessToken: 'b' });
    assert.deepEqual(screenStoreOptions('board'), { dbName: 'r2m-board', mirrored: ['r2m.board.credentials'] });
    assert.notEqual(screenKeys('kds').kvPrefix, screenKeys('board').kvPrefix);
    // Nothing of the kiosk's (`r2m.kiosk.*`) is touched.
    assert.ok([...ls.map.keys()].every((k) => !k.startsWith('r2m.kiosk.')));
  });

  it('the engine’s kv: written behind in order, read back after a reload', async () => {
    const store = new MemoryStore();
    const kv = new ScreenKv(store, 'r2m.kds.kv.');
    kv.setJson('a', [1]);
    kv.setJson('a', [1, 2]);
    kv.setJson('b', { x: 1 });
    assert.deepEqual(kv.getJson('a'), [1, 2]);
    await kv.flush();
    assert.deepEqual(await store.get('r2m.kds.kv.a'), [1, 2]);
    const again = new ScreenKv(store, 'r2m.kds.kv.');
    await again.load(['a', 'b', 'c']);
    assert.deepEqual([again.getJson('a'), again.getJson('b'), again.getJson('c')], [[1, 2], { x: 1 }, null]);
    await again.clear(['a']);
    assert.equal(await store.get('r2m.kds.kv.a'), null);
  });

  it('a reload with no network shows the last board at once, marked offline', async () => {
    const cloud = fakeCloud();
    const store = new MemoryStore();
    const svc = service(cloud, 'kds', store);
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    await svc.refresh();
    await svc.flush();
    svc.stop();
    cloud.setOnline(false);
    const again = service(cloud, 'kds', store);
    const v = await again.init();
    assert.equal(v.phase, 'ready');
    const kds = await again.bridge().kds();
    assert.equal(kds.offline, true);
    assert.equal(kds.orders.length, 1);
    assert.equal(kds.device?.name, 'גריל 1');
    assert.equal(kds.updatedAt !== null, true);
  });
});

describe('the bridge the shared screens read', () => {
  it('the KDS view and its events', async () => {
    const cloud = fakeCloud();
    const svc = service(cloud);
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    const bridge = svc.bridge();
    const seen: number[] = [];
    const off = bridge.on('kds', (v) => seen.push(v.orders.length));
    await svc.refresh();
    off();
    assert.ok(seen.length > 0 && seen.every((n) => n === 1));
    const v = await bridge.kds();
    assert.equal(v.offline, false);
    assert.equal(v.serverOffsetMs, 60_000);
    assert.equal(svc.view().shows, 'kds');
    assert.equal(svc.view().online, true);
  });

  it('a pickup device is the board — whatever the route — with its look', async () => {
    const cloud = fakeCloud({ deviceRole: 'kds', screen: 'pickup', display: { theme: 'light', accent: '#16A34A', showPreparing: false } });
    const svc = service(cloud, 'kds');
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    const boards: string[][] = [];
    svc.bridge().on('board', (b) => boards.push(b.ready.map((n) => n.number)));
    await svc.refresh();
    assert.equal(svc.view().shows, 'board');
    const b = await svc.bridge().board();
    assert.deepEqual([b.preparing.map((n) => n.number), b.ready.map((n) => n.number), b.notConfigured], [['41'], ['40'], false]);
    assert.deepEqual(b.display, { ...DEFAULT_BOARD_DISPLAY, theme: 'light', accent: '#16a34a', sound: true, showPreparing: false, title: null });
    assert.deepEqual(boards.at(-1), ['40']);
  });
});

describe('the offline queue', () => {
  it('sends at once when online, with the item’s version and the cloud’s clock', async () => {
    const cloud = fakeCloud();
    const svc = service(cloud);
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    await svc.refresh();
    const r = await svc.kdsAction({ type: 'item_ready', taskId: 't1' });
    assert.deepEqual(r, { ok: true });
    assert.equal(cloud.posts.length, 1);
    assert.deepEqual(cloud.posts[0], { id: 'act-0001-0000', type: 'item_ready', taskId: 't1', occurredAt: new Date(T0 + 60_000).toISOString(), expectedVersion: 3 });
  });

  it('without a connection: kept (through a reload), shown applied, then sent in order with the same ids', async () => {
    const cloud = fakeCloud();
    const store = new MemoryStore();
    const svc = service(cloud, 'kds', store);
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    await svc.refresh();
    cloud.setOnline(false);
    assert.deepEqual(await svc.kdsAction({ type: 'item_ready', taskId: 't1' }), { ok: true, message: QUEUED_TEXT });
    assert.deepEqual(await svc.kdsAction({ type: 'item_ready', taskId: 't2' }), { ok: true, message: QUEUED_TEXT });
    const v = await svc.bridge().kds();
    assert.equal(v.pendingActions, 2);
    assert.deepEqual(v.orders[0].tasks.map((t) => [t.state, t.pending]), [['ready', true], ['ready', true]]);
    assert.equal(svc.view().pendingActions, 2);
    await svc.flush();
    const kept = await store.get<Array<{ id: string; body: Record<string, unknown> }>>(screenKeys('kds').kvPrefix + KDS_OUTBOX_KEY);
    assert.deepEqual(kept?.map((e) => e.id), ['act-0001-0000', 'act-0002-0000']);
    // A late action: no version (the cloud's offline rules).
    assert.equal(kept?.[0].body.expectedVersion, undefined);
    svc.stop();
    // The tab reloads, still offline: the actions are still there; then the network comes back.
    const again = service(cloud, 'kds', store);
    await again.init();
    assert.equal(again.view().pendingActions, 2);
    cloud.setOnline(true);
    await again.refresh();
    assert.deepEqual(cloud.posts.map((p) => [p.id, p.taskId]), [['act-0001-0000', 't1'], ['act-0002-0000', 't2']]);
    assert.equal(again.view().pendingActions, 0);
    await again.flush();
    assert.deepEqual(await store.get(screenKeys('kds').kvPrefix + KDS_OUTBOX_KEY), []);
  });

  it("a refusal is dropped and said; it never blocks the rest", async () => {
    let n = 0;
    const cloud = fakeCloud({}, {
      'POST sync/m1/kds/actions': (c) => {
        n += 1;
        return n === 1 ? { status: 409, body: { detail: { code: 'version_conflict' } } } : { status: 200, body: { outcome: 'applied', order: { version: 7 }, id: c.body?.id } };
      },
    });
    const svc = service(cloud);
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    await svc.refresh();
    const r = await svc.kdsAction({ type: 'item_ready', taskId: 't1' });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /#41|41/);
    assert.match((await svc.bridge().kds()).lastError ?? '', /מוכן/);
    assert.deepEqual(await svc.kdsAction({ type: 'item_ready', taskId: 't2' }), { ok: true });
  });
});

describe('the life of a paired screen', () => {
  it('a heartbeat with the version; machines/me and the technician code on schedule', async () => {
    const cloud = fakeCloud();
    const svc = service(cloud);
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    await svc.tick();
    const beat = cloud.calls.find((c) => c.path === 'machines/me/heartbeat');
    assert.equal(beat?.body?.appVersion, 'web-kds-test');
    assert.equal(beat?.body?.pendingCount, 0);
    assert.ok(svc.view().lastBeatOkAt);
    assert.equal(cloud.calls.filter((c) => c.path === 'sync/m1/parameters').length >= 1, true);
  });

  it('a revoked token: back to pairing, nothing kept', async () => {
    const cloud = fakeCloud();
    const store = new MemoryStore();
    const svc = service(cloud, 'kds', store);
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    await svc.refresh();
    cloud.handlers['GET sync/m1/kds/board'] = () => ({ status: 401, body: { detail: 'Machine token revoked' } });
    await svc.refresh();
    assert.equal(svc.view().phase, 'unpaired');
    assert.equal(await store.get(screenKeys('kds').credentials), null);
    assert.equal(await store.get(screenKeys('kds').kvPrefix + 'role.kds.cache'), null);
  });

  it('"ניתוק" forgets the screen', async () => {
    const svc = service(fakeCloud());
    await svc.init();
    await svc.pair({ code: 'AB12CD34', machineName: 'x' });
    await svc.unpair();
    assert.equal(svc.view().phase, 'unpaired');
    assert.equal(svc.view().machine, null);
  });
});

describe('the engine and the board, shared with the Windows app', () => {
  const state = (body: Record<string, unknown> | null): FeedState => ({ body, okAt: T0, offline: false, notConfigured: false, serverOffsetMs: 0 });

  it('what the cloud says the screen is', () => {
    assert.equal(feedShows(state(null)), null);
    assert.equal(feedShows(state({ device: { role: 'pickup' }, pickup: {} })), 'board');
    assert.equal(feedShows(state({ device: { role: 'expo' }, orders: [] })), 'kds');
    // A station's board has no `pickup`: not configured as a board.
    assert.equal(boardView(state({ device: { role: 'station' }, orders: [] })).notConfigured, true);
    assert.equal(boardView(state({ device: { role: 'pickup', display: null }, pickup: {} })).display, null);
  });

  it("the board's look, cleaned", () => {
    assert.deepEqual(boardDisplayOf(null), DEFAULT_BOARD_DISPLAY);
    assert.deepEqual(boardDisplayOf({ theme: 'neon', accent: 'green', sound: false, showPreparing: 0, title: '  איסוף  ' }), {
      ...DEFAULT_BOARD_DISPLAY, theme: 'dark', accent: null, sound: false, showPreparing: true, title: 'איסוף',
    });
    assert.equal(boardDisplayOf({ theme: 'contrast', accent: '#ABCDEF' }).accent, '#abcdef');
    assert.equal(textOn('#ffff00'), '#000000');
    assert.equal(textOn('#2563eb'), '#ffffff');
    assert.equal(textOn('#16a34a'), '#000000');
  });

  it('ids are UUIDs even where randomUUID is missing (http on the LAN)', () => {
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.match(uuid4(), V4);
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) }, configurable: true });
    try {
      const a = uuid4();
      assert.match(a, V4);
      assert.notEqual(a, uuid4());
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    }
  });
});

interface Sw {
  routeOf(req: { url: string; method: string; mode?: string; headers?: { get(n: string): string | null } }, origin: string, page: string): string;
  SCREENS: string[];
}

describe('the screens’ service worker (public/screens-sw.js)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sw = require(join(process.cwd(), 'public', 'screens-sw.js')) as Sw;
  const O = 'https://pos-cloud-app.vercel.app';
  const req = (url: string, mode = 'no-cors', method = 'GET', rsc = false) => ({ url, method, mode, headers: { get: (n: string) => (n === 'RSC' && rsc ? '1' : null) } });

  it("keeps its own route's page, never another page", () => {
    assert.deepEqual(sw.SCREENS, ['kds', 'board']);
    assert.equal(sw.routeOf(req(`${O}/kds`, 'navigate'), O, '/kds'), 'page');
    assert.equal(sw.routeOf(req(`${O}/kds?demo=1`, 'navigate'), O, '/kds'), 'page');
    assert.equal(sw.routeOf(req(`${O}/board`, 'navigate'), O, '/kds'), 'pass');
    assert.equal(sw.routeOf(req(`${O}/board`, 'navigate'), O, '/board'), 'page');
    assert.equal(sw.routeOf(req(`${O}/dashboard/kds`, 'navigate'), O, '/kds'), 'pass');
    assert.equal(sw.routeOf(req(`${O}/k`, 'navigate'), O, '/kds'), 'pass');
  });

  it('keeps the code, the icons and its manifest; passes the API, payloads and writes', () => {
    assert.equal(sw.routeOf(req(`${O}/_next/static/chunks/app/kds/page-abc.js`), O, '/kds'), 'static');
    assert.equal(sw.routeOf(req(`${O}/icons/icon-192.png`), O, '/board'), 'asset');
    assert.equal(sw.routeOf(req(`${O}/board.webmanifest`), O, '/board'), 'asset');
    assert.equal(sw.routeOf(req(`${O}/kds.webmanifest`), O, '/board'), 'pass');
    assert.equal(sw.routeOf(req('https://api.example.com/api/v1/sync/m1/kds/board'), O, '/kds'), 'pass');
    assert.equal(sw.routeOf(req(`${O}/kds?_rsc=1`), O, '/kds'), 'pass');
    assert.equal(sw.routeOf(req(`${O}/kds`, 'navigate', 'GET', true), O, '/kds'), 'pass');
    assert.equal(sw.routeOf(req(`${O}/kds`, 'navigate', 'POST'), O, '/kds'), 'pass');
  });
});

describe('with the Windows bridge (SPEC_KIOSK §28)', () => {
  it('a KDS pairs as a KDS, the board as the board; its pairing kept in the screen’s own store', async () => {
    assert.equal(bridgeRoleOf('kds'), 'kds');
    assert.equal(bridgeRoleOf('board'), 'order_status_board');
    const store = new MemoryStore();
    await store.set(bridgeStoreKey('kds'), { pairingId: 'p1', secret: 'c2VjcmV0', role: 'kds', pairedAt: '2026-10-07T10:00:00Z', version: '0.3.0' });
    const client = new BridgeClient({ fetchFn: async () => ({ ok: false, status: 404, text: async () => '' }), store, role: bridgeRoleOf('kds') });
    assert.equal((await client.load())?.pairingId, 'p1');
    const board = new BridgeClient({ fetchFn: async () => ({ ok: false, status: 404, text: async () => '' }), store, role: bridgeRoleOf('board') });
    assert.equal(await board.load(), null);
  });

  it('prints only when paired, answering and its printer is ready; says where it stands', () => {
    const paired = { ...NO_BRIDGE, present: true, paired: true, version: '0.3.0', ready: { card: false, print: true, drawer: false } };
    assert.equal(bridgeCanPrint(null), false);
    assert.equal(bridgeCanPrint(NO_BRIDGE), false);
    assert.equal(bridgeCanPrint(paired), true);
    assert.equal(bridgeCanPrint({ ...paired, present: false }), false);
    assert.equal(bridgeCanPrint({ ...paired, ready: { card: false, print: false, drawer: false } }), false);
    assert.equal(bridgeLine(null), 'לא נמצא גשר במחשב הזה');
    assert.equal(bridgeLine({ ...NO_BRIDGE, present: true }), 'נמצא גשר — לא מצומד');
    assert.equal(bridgeLine({ ...NO_BRIDGE, present: true, otherPage: true }), 'הגשר מצומד לדף אחר');
    assert.equal(bridgeLine(paired), 'מצומד · גרסה 0.3.0');
  });

  it("a card as the bridge's bon: live items with their details, the station in the band", () => {
    const o = order();
    o.pickupName = 'יוסי';
    o.orderNote = 'בלי מלח';
    o.tasks = [
      task('t1', { mods: ['גבינה'], removals: ['בצל'], notes: 'עשוי היטב', allergies: ['גלוטן'], seat: '2' }),
      task('t2', { name: 'קבב', activeQty: 0, cancelledQty: 1 }),
      task('t3', { name: 'עוגה', release: 'hold' }),
      task('t4', { name: 'צ׳יפס', activeQty: 2, orderedQty: 2, roundNo: 2 }),
    ];
    const doc = kdsBonDoc(o, { device: { id: 'd1', name: 'גריל 1', role: 'station', stations: [{ id: 'grill', name: 'גריל' }] }, machineName: 'מסך גריל', now: new Date(T0) });
    assert.equal(doc.kind, 'bon');
    assert.equal(doc.title, '#41 · יוסי');
    assert.equal(doc.notice, 'גריל');
    assert.equal(doc.dining, 'take_away');
    assert.deepEqual(doc.lines.map((l) => [l.qty, l.name]), [[1, 'המבורגר'], [2, 'צ׳יפס']]);
    assert.deepEqual(doc.lines[0], { qty: 1, name: 'המבורגר', detail: 'מקום 2', mods: ['+ גבינה'], removals: ['בלי בצל'], notes: 'עשוי היטב · אלרגיה: גלוטן' });
    assert.equal(doc.lines[1].detail, 'סבב 2');
    assert.ok(doc.foot.includes('הערה: בלי מלח') && doc.foot.includes('מסך: מסך גריל'));
    assert.ok(JSON.stringify(doc).length < 100_000);
    // An Expo prints without a station band.
    assert.equal(kdsBonDoc(o, { device: { id: 'd2', name: 'Expo', role: 'expo', stations: [] }, machineName: null, now: new Date(T0) }).notice, null);
  });
});
