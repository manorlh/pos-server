/**
 * Run with `npm test`. The browser kiosk's local service and storage (lib/kioskWebService.ts,
 * lib/kioskWebStore.ts, lib/kioskWebApi.ts — docs/SPEC_KIOSK.md §27) against a pretend cloud:
 * pairing (the device says "web"), the kept copies (a reload shows the kiosk with no network),
 * the sync, "מזומן בקופה" orders (written first, sent until the cloud has them), vouchers
 * (redeemed online, given back), help, a revoked token, and the honest pay methods.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebKioskService, usableMethods, webSells, type WebKioskDeps } from './kioskWebService';
import { KV, LocalStore, MemoryStore, openKioskStore, type StorageLike } from './kioskWebStore';
import { apiBase, describeBrowser, detailOf, messageOf, normalizePairingCode, webDeviceInfo, type FetchFn } from './kioskWebApi';
import { applyCatalogPull, buildWebCatalog, configMediaUrls, sizedImage } from './kioskWebCatalog';
import type { WebOrderLine } from './kioskWebOrders';

type Call = { method: string; path: string; body: Record<string, unknown> | null; auth: string | null };
type Handler = (c: Call) => { status: number; body?: unknown } | 'offline';

const SERVER = 'http://cloud.test';

function fakeCloud(over: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  let online = true;
  const handlers: Record<string, Handler> = {
    'POST pairing/validate': () => ({ status: 200, body: { accessToken: 'tok', machineId: 'm1', machineCode: 'MC', tenantId: 't1', shopId: 's1' } }),
    'GET machines/me': () => ({ status: 200, body: { machineId: 'm1', machineName: 'קיוסק דפדפן', shopName: 'סניף', companyName: 'עסק', posNumber: '7' } }),
    'POST machines/me/heartbeat': () => ({ status: 200, body: { ok: true } }),
    'POST sync/m1/kiosk/sync': () => ({
      status: 200,
      body: {
        kiosk: true,
        name: 'קיוסק דפדפן',
        configVersion: 'v1',
        config: { payment: { methods: ['card', 'voucher', 'cash_at_till'] }, pickup: { scope: 'kiosk', prefix: 'W', start: 1, max: 999 } },
        state: { paused: false },
        operator: { id: 'kiosk:m1', name: 'קיוסק דפדפן' },
        alerts: { open: [], help: null },
        closeRequest: null,
      },
    }),
    'GET sync/m1/settings': () => ({ status: 200, body: { syncType: 'full', settings: {}, businessInfo: { companyName: 'עסק בע״מ' }, settingsUpdatedAt: '2026-10-07T00:00:00Z' } }),
    'GET sync/m1/parameters': () => ({ status: 200, body: { parameters: { technicianCode: null } } }),
    'GET sync/m1/catalog': () => ({
      status: 200,
      body: {
        syncType: 'full',
        serverTime: '2026-10-07T00:00:00Z',
        categories: [{ id: 'c1', name: 'המבורגרים', isActive: true }],
        products: [
          { id: 'p1', categoryId: 'c1', name: 'המבורגר', price: 54, isAvailable: true },
          { id: 'p2', categoryId: 'c1', name: 'אזל', price: 10, isAvailable: false },
          { id: 'p3', categoryId: 'c1', name: 'קופות בלבד', price: 10, salesChannel: 'pos_only' },
        ],
        menu: { groups: [{ id: 'g1', name: 'תוספות', kind: 'addon', options: [{ id: 'o1', name: 'גבינה', price: 5 }] }], links: { categories: { c1: ['g1'] } } },
        machineCatalog: { mode: 'all' },
      },
    }),
    'POST sync/m1/kiosk/open-orders': (c) => {
      const orders = (c.body?.orders as Array<{ localId: string }>) ?? [];
      return { status: 200, body: { accepted: orders.map((o) => o.localId), rejected: [], states: Object.fromEntries(orders.map((o) => [o.localId, { state: 'open' }])) } };
    },
    ...over,
  };
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1\//, '') + url.search;
    const call: Call = { method: init.method, path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization ?? null };
    calls.push(call);
    if (!online) throw new TypeError('Failed to fetch');
    const key = `${init.method} ${path.split('?')[0]}`;
    const h = handlers[key] ?? Object.entries(handlers).find(([k]) => k.includes('*') && new RegExp(`^${k.replace(/\*/g, '.*')}$`).test(key))?.[1];
    const r = h ? h(call) : { status: 404, body: { detail: 'Not Found' } };
    if (r === 'offline') throw new TypeError('Failed to fetch');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)), headers: { get: () => null } };
  };
  return { fetchFn, calls, handlers, setOnline: (v: boolean) => (online = v) };
}

function service(cloud: ReturnType<typeof fakeCloud>, store = new MemoryStore(), extra: Partial<WebKioskDeps> = {}) {
  let now = Date.UTC(2026, 9, 7, 9, 0, 0);
  const svc = new WebKioskService({
    store,
    fetchFn: cloud.fetchFn,
    defaultServer: SERVER,
    appVersion: 'web-test',
    deviceInfo: () => webDeviceInfo({ userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-T220) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' }, 'test'),
    now: () => now,
    timers: { set: () => 0, clear: () => undefined },
    ...extra,
  });
  return { svc, store, tick: (ms: number) => (now += ms), nowMs: () => now };
}

const line = (over: Partial<WebOrderLine> = {}): WebOrderLine => ({
  key: 'k1',
  productId: 'p1',
  name: 'המבורגר',
  qty: 1,
  baseAgorot: 5400,
  unitAgorot: 5400,
  options: [],
  note: null,
  categoryId: 'c1',
  sku: null,
  barcode: null,
  imageUrl: null,
  allergens: [],
  ...over,
});

async function paired() {
  const cloud = fakeCloud();
  const s = service(cloud);
  await s.svc.init();
  const r = await s.svc.pair({ code: 'ab12-cd34', machineName: 'טאבלט' });
  assert.deepEqual(r, { ok: true });
  return { cloud, ...s };
}

describe('pairing', () => {
  it('sends the code in snake_case with the browser as the "web" platform, and keeps the token', async () => {
    const { cloud, svc, store } = await paired();
    const v = cloud.calls.find((c) => c.path === 'pairing/validate')!;
    assert.equal(v.body?.code, 'AB12CD34');
    assert.equal(v.body?.machine_name, 'טאבלט');
    const info = v.body?.device_info as Record<string, string>;
    assert.equal(info.platform, 'web');
    assert.equal(info.os, 'Android');
    assert.equal(info.browser, 'Chrome');
    assert.equal(v.auth, null);
    const creds = await store.get<{ accessToken: string; machineId: string; serverUrl: string }>(KV.credentials);
    assert.equal(creds?.accessToken, 'tok');
    assert.equal(creds?.serverUrl, 'http://cloud.test/api/v1/');
    // Every call after it carries the machine token.
    assert.ok(cloud.calls.filter((c) => c.path !== 'pairing/validate').every((c) => c.auth === 'Bearer tok'));
    const view = svc.view();
    assert.equal(view.phase, 'kiosk');
    assert.equal(view.machine?.machineId, 'm1');
    assert.equal(view.brandName, 'עסק בע״מ');
    // Only what a kiosk sells: the delisted-for-tills product is gone, the sold-out one is marked.
    assert.deepEqual(view.catalog.products.map((p) => [p.id, p.soldOut]).sort(), [['p1', false], ['p2', true]]);
    assert.equal(view.catalog.groups.p1?.[0]?.options[0]?.price, 5);
  });

  it("refuses with the cloud's own words, and an unknown code in Hebrew", async () => {
    const cloud = fakeCloud({
      'POST pairing/validate': (c) =>
        c.body?.code === 'WINDOWS1'
          ? { status: 422, body: { detail: 'platform_mismatch', codePlatform: 'windows', devicePlatform: 'web', message: 'קוד הצימוד נוצר למכשיר Windows' } }
          : { status: 400, body: { detail: 'Invalid or expired pairing code' } },
    });
    const { svc } = service(cloud);
    await svc.init();
    assert.deepEqual(await svc.pair({ code: 'windows1', machineName: '' }), { ok: false, error: 'קוד הצימוד נוצר למכשיר Windows' });
    assert.deepEqual(await svc.pair({ code: 'ZZZZ9999', machineName: '' }), { ok: false, error: 'קוד הצימוד שגוי או שפג תוקפו' });
    assert.equal(svc.view().phase, 'unpaired');
  });

  it('says so when the server cannot be reached', async () => {
    const cloud = fakeCloud();
    cloud.setOnline(false);
    const { svc } = service(cloud);
    await svc.init();
    const r = await svc.pair({ code: 'AB12CD34', machineName: '' });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /אין חיבור לשרת/);
  });
});

describe('a reload', () => {
  it('shows the kiosk at once from what it kept, with no network at all', async () => {
    const { store } = await paired();
    const cloud = fakeCloud();
    cloud.setOnline(false);
    const again = service(cloud, store);
    const view = await again.svc.init();
    assert.equal(view.phase, 'kiosk');
    assert.equal(view.catalog.products.length, 2);
    await again.svc.tick();
    assert.equal(again.svc.view().state.offline, true);
    // Offline: a voucher cannot be checked; paying at the till still works.
    assert.deepEqual(again.svc.view().pay.usable, ['cash_at_till']);
  });

  it('a revoked token ends the pairing (back to the pairing screen)', async () => {
    const { cloud, svc, store, tick } = await paired();
    cloud.handlers['POST sync/m1/kiosk/sync'] = () => ({ status: 401, body: { detail: 'Machine token revoked; re-pair this terminal' } });
    cloud.handlers['POST machines/me/heartbeat'] = () => ({ status: 401, body: { detail: 'Machine token revoked; re-pair this terminal' } });
    tick(60_000);
    await svc.tick();
    assert.equal(svc.view().phase, 'unpaired');
    assert.equal(await store.get(KV.credentials), null);
  });
});

describe('the honest pay methods', () => {
  it('never the card; a voucher only online; sells only with "מזומן בקופה"', () => {
    assert.deepEqual(usableMethods(['card', 'voucher', 'cash_at_till'], true), ['voucher', 'cash_at_till']);
    assert.deepEqual(usableMethods(['card', 'voucher', 'cash_at_till'], false), ['cash_at_till']);
    assert.equal(webSells(['card']), false);
    assert.equal(webSells(['card', 'voucher']), false);
    assert.equal(webSells(['cash_at_till']), true);
  });

  it('never "פיצול תשלום בכרטיסים" (split_card): one card per document here', async () => {
    assert.deepEqual(usableMethods(['card', 'split_card', 'cash_at_till'], true, true), ['card', 'cash_at_till']);
    assert.equal(webSells(['split_card']), false);
    const { cloud, svc } = await paired();
    cloud.handlers['POST sync/m1/kiosk/sync'] = () => ({
      status: 200,
      body: { kiosk: true, configVersion: 'v2', config: { payment: { methods: ['split_card', 'cash_at_till', 'voucher'] } }, state: {} },
    });
    await svc.kioskSync();
    assert.deepEqual(svc.view().pay.methods, ['cash_at_till', 'voucher']);
    assert.deepEqual(svc.view().pay.usable, ['cash_at_till', 'voucher']);
    assert.equal(svc.view().state.noPayment, false);
    // Only it and a voucher: as a method this kiosk does not know — the card beside the voucher, and no sale here without the bridge.
    cloud.handlers['POST sync/m1/kiosk/sync'] = () => ({
      status: 200,
      body: { kiosk: true, configVersion: 'v3', config: { payment: { methods: ['voucher', 'split_card'] } }, state: {} },
    });
    await svc.kioskSync();
    assert.deepEqual(svc.view().pay.methods, ['card', 'voucher']);
    assert.ok(!svc.view().pay.usable.includes('split_card'));
    assert.equal(svc.view().state.noPayment, true);
  });

  it('rests on "התשלום אינו זמין" when the kiosk takes only the card', async () => {
    const { cloud, svc } = await paired();
    cloud.handlers['POST sync/m1/kiosk/sync'] = () => ({ status: 200, body: { kiosk: true, configVersion: 'v2', config: { payment: { methods: ['card'] } }, state: {} } });
    await svc.kioskSync();
    assert.equal(svc.view().state.noPayment, true);
    assert.deepEqual(svc.view().pay.methods, ['card']);
  });
});

describe('"מזומן בקופה" orders', () => {
  it('are written, numbered from the kiosk\'s own sequence and sent as open orders the tills collect', async () => {
    const { cloud, svc, store } = await paired();
    const r = await svc.placeOpenOrder({ lines: [line()], service: 'take_away', tableRef: null, customerName: 'דנה', customerPhone: null, tipAgorot: 500, vouchers: [] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.order.pickupLabel, 'W-1');
    assert.equal(r.dueAgorot, 5900);
    assert.equal(r.pending, false);
    const sent = cloud.calls.find((c) => c.path === 'sync/m1/kiosk/open-orders')!;
    const o = (sent.body?.orders as Array<Record<string, unknown>>)[0];
    assert.equal(o.state, 'open');
    assert.equal(o.totalAgorot, 5400);
    assert.equal(o.dueAgorot, 5900);
    assert.equal(typeof (o.cart as { codec: string }).codec, 'string');
    assert.equal((await store.get<{ cloudState: string }>(`${KV.orderPrefix}${r.order.localId}`))?.cloudState, 'open');
    const second = await svc.placeOpenOrder({ lines: [line()], service: 'eat_in', tableRef: '12', customerName: null, customerPhone: null, tipAgorot: 0, vouchers: [] });
    assert.equal(second.ok && second.order.pickupLabel, 'W-2');
    // Today's count and sum on the status the dashboard shows.
    const status = svc.kioskStatus();
    assert.equal(status.ordersToday, 2);
    assert.equal((status.health as { platform: string }).platform, 'web');
  });

  it('offline: kept and said "pending", then sent by the next sync', async () => {
    const { cloud, svc, tick } = await paired();
    cloud.setOnline(false);
    const r = await svc.placeOpenOrder({ lines: [line()], service: 'take_away', tableRef: null, customerName: null, customerPhone: null, tipAgorot: 0, vouchers: [] });
    assert.equal(r.ok && r.pending, true);
    assert.equal(svc.view().staff.pendingOrders, 1);
    cloud.setOnline(true);
    tick(20_000);
    await svc.tick();
    assert.equal(svc.view().staff.pendingOrders, 0);
  });

  it('a shop-wide number from the cloud, or a local one tagged L when it does not answer', async () => {
    const { cloud, svc } = await paired();
    cloud.handlers['POST sync/m1/kiosk/sync'] = () => ({ status: 200, body: { kiosk: true, configVersion: 'v3', config: { payment: { methods: ['cash_at_till'] }, pickup: { scope: 'shop', prefix: 'A', start: 1, max: 99 } }, state: {} } });
    cloud.handlers['POST sync/m1/kiosk/pickup-number'] = () => ({ status: 200, body: { number: 41, label: 'A-41' } });
    await svc.kioskSync();
    const a = await svc.placeOpenOrder({ lines: [line()], service: 'take_away', tableRef: null, customerName: null, customerPhone: null, tipAgorot: 0, vouchers: [] });
    assert.equal(a.ok && a.order.pickupLabel, 'A-41');
    cloud.handlers['POST sync/m1/kiosk/pickup-number'] = () => 'offline';
    const b = await svc.placeOpenOrder({ lines: [line()], service: 'take_away', tableRef: null, customerName: null, customerPhone: null, tipAgorot: 0, vouchers: [] });
    assert.equal(b.ok && b.order.pickupLabel, 'AL-1');
  });

  it('the cloud prices it otherwise while the customer waits: never placed, the catalog pulled, the change shown', async () => {
    const { cloud, svc } = await paired();
    cloud.handlers['POST sync/m1/kiosk/open-orders'] = (c) => ({
      status: 200,
      body: { accepted: [], rejected: [{ localId: (c.body?.orders as Array<{ localId: string }>)[0].localId, reason: 'price_changed', lines: [{ key: 'k1', productId: 'p1', name: 'המבורגר', fromAgorot: 5400, toAgorot: 5600, reason: 'price' }] }] },
    });
    const pulls = cloud.calls.filter((c) => c.path.startsWith('sync/m1/catalog')).length;
    const r = await svc.placeOpenOrder({ lines: [line()], service: 'take_away', tableRef: null, customerName: null, customerPhone: null, tipAgorot: 0, vouchers: [] });
    assert.deepEqual(r, { ok: false, reason: 'changed', changes: [{ kind: 'repriced', productId: 'p1', name: 'המבורגר', key: 'k1', from: 5400, to: 5600 }] });
    const sent = cloud.calls.filter((c) => c.path === 'sync/m1/kiosk/open-orders');
    assert.equal((sent[0].body?.orders as Array<Record<string, unknown>>)[0].customerWaiting, true);
    // Forgotten (never retried, not on the staff screen); the catalog asked to catch up.
    assert.deepEqual([svc.view().staff.pendingOrders, svc.todaysOrders().length], [0, 0]);
    assert.equal(cloud.calls.filter((c) => c.path.startsWith('sync/m1/catalog')).length, pulls + 1);
  });

  it('a retry never says the customer waits (the slip may be in their hand)', async () => {
    const { cloud, svc, tick } = await paired();
    cloud.setOnline(false);
    await svc.placeOpenOrder({ lines: [line()], service: 'take_away', tableRef: null, customerName: null, customerPhone: null, tipAgorot: 0, vouchers: [] });
    cloud.setOnline(true);
    tick(20_000);
    await svc.tick();
    const sent = cloud.calls.filter((c) => c.path === 'sync/m1/kiosk/open-orders');
    assert.deepEqual(sent.map((c) => (c.body?.orders as Array<Record<string, unknown>>)[0].customerWaiting), [true, undefined]);
  });

  it('refused for good: never sent again, and the customer is told', async () => {
    const { cloud, svc } = await paired();
    cloud.handlers['POST sync/m1/kiosk/open-orders'] = (c) => ({ status: 200, body: { accepted: [], rejected: [{ localId: (c.body?.orders as Array<{ localId: string }>)[0].localId, reason: 'invalid' }], states: {} } });
    const r = await svc.placeOpenOrder({ lines: [line()], service: 'take_away', tableRef: null, customerName: null, customerPhone: null, tipAgorot: 0, vouchers: [] });
    assert.equal(r.ok, false);
    assert.equal(svc.view().staff.pendingOrders, 0);
  });

  it('"שלח למטבח לפני תשלום" with one bon printer: the bon goes through the cloud first, kitchenSent', async () => {
    const { cloud, svc } = await paired();
    cloud.handlers['POST sync/m1/kiosk/sync'] = () => ({
      status: 200,
      body: { kiosk: true, configVersion: 'v4', config: { payment: { methods: ['cash_at_till'], cashAtTillKitchenBeforePay: true }, printing: { bonMode: 'single', bonPrinterId: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f', bonCopies: 1 } }, state: {} },
    });
    cloud.handlers['POST sync/m1/print-jobs'] = () => ({ status: 201, body: { status: 'pending' } });
    await svc.kioskSync();
    const r = await svc.placeOpenOrder({ lines: [line({ options: [{ groupId: 'g1', groupName: 'תוספות', kind: 'addon', optionId: 'o1', name: 'גבינה', priceAgorot: 500 }], unitAgorot: 5900 })], service: 'take_away', tableRef: null, customerName: 'דנה', customerPhone: null, tipAgorot: 0, vouchers: [] });
    assert.equal(r.ok && r.order.kitchenSent, true);
    const job = cloud.calls.find((c) => c.path === 'sync/m1/print-jobs')!;
    const ticket = job.body?.ticket as { lines: Array<{ mods: string[] }>; customerName: string; orderRef: string };
    assert.deepEqual(ticket.lines[0].mods, ['גבינה']);
    assert.equal(ticket.customerName, 'דנה');
    assert.equal(ticket.orderRef, r.ok ? r.order.pickupLabel : '');
  });
});

describe('vouchers', () => {
  const voucherCloud = (over: Record<string, Handler> = {}) => ({
    'POST sync/m1/prepaid-vouchers/lookup': () => ({ status: 200, body: { serial: 9, redeemable: true, splitAllowed: true, items: [{ productId: 'p1', tillProductId: 'p1', name: 'המבורגר', quantity: 2, remaining: 2 }] } }),
    'POST sync/m1/prepaid-vouchers/redeem': (c: Call) => ({ status: 200, body: { ok: true, redemptionId: 'red-1', redeemed: (c.body?.items as Array<{ productId: string; quantity: number }>).map((i) => ({ ...i, tillProductId: i.productId, name: 'המבורגר' })), voucher: { serial: 9, eventName: 'כנס' } } }),
    'POST sync/m1/prepaid-vouchers/redemptions/*/reverse': () => ({ status: 200, body: { ok: true } }),
    ...over,
  });

  it('are looked up and redeemed online for what the basket holds, once per request id', async () => {
    const { cloud, svc } = await paired();
    Object.assign(cloud.handlers, voucherCloud());
    const r = await svc.redeemVoucher({ code: 'ABCDEFGHJKMNPQRS', lines: [line({ qty: 1 })], earlier: [], clientRequestId: 'req-1' });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.leg.amountAgorot, 5400);
    assert.equal(r.leg.serial, 9);
    const redeem = cloud.calls.find((c) => c.path === 'sync/m1/prepaid-vouchers/redeem')!;
    assert.deepEqual(redeem.body?.items, [{ productId: 'p1', quantity: 1 }]);
    assert.equal(redeem.body?.clientRequestId, 'req-1');
    assert.equal(redeem.body?.posUserId, 'kiosk:m1');
  });

  it('a one-time voucher taken in part asks first; nothing in the basket says so', async () => {
    const { cloud, svc } = await paired();
    Object.assign(cloud.handlers, voucherCloud({
      'POST sync/m1/prepaid-vouchers/lookup': () => ({ status: 200, body: { redeemable: true, splitAllowed: false, items: [{ productId: 'p1', tillProductId: 'p1', name: 'המבורגר', quantity: 2, remaining: 2 }] } }),
    }));
    assert.equal((await svc.redeemVoucher({ code: 'X1234567', lines: [line({ qty: 1 })], earlier: [], clientRequestId: 'r' })).kind, 'forfeit');
    assert.equal((await svc.redeemVoucher({ code: 'X1234567', lines: [line({ qty: 1 })], earlier: [], clientRequestId: 'r', forfeitRest: true })).kind, 'ok');
    assert.equal((await svc.redeemVoucher({ code: 'X1234567', lines: [line({ productId: 'other' })], earlier: [], clientRequestId: 'r2' })).kind, 'no_match');
  });

  it("the cloud's refusal and an outage are told apart", async () => {
    const { cloud, svc } = await paired();
    Object.assign(cloud.handlers, voucherCloud({ 'POST sync/m1/prepaid-vouchers/lookup': () => ({ status: 404, body: { detail: 'prepaid_voucher_not_found' } }) }));
    assert.deepEqual(await svc.redeemVoucher({ code: 'NOPE1234', lines: [line()], earlier: [], clientRequestId: 'r' }), { kind: 'refused', reason: 'prepaid_voucher_not_found' });
    cloud.setOnline(false);
    assert.deepEqual(await svc.redeemVoucher({ code: 'NOPE1234', lines: [line()], earlier: [], clientRequestId: 'r' }), { kind: 'offline' });
  });

  it('given back online; kept and given back by the next sync when the cloud is away', async () => {
    const { cloud, svc, tick } = await paired();
    Object.assign(cloud.handlers, voucherCloud());
    cloud.setOnline(false);
    await svc.reverseVoucher('red-9');
    assert.equal(svc.view().staff.pendingReversals, 1);
    cloud.setOnline(true);
    tick(20_000);
    await svc.tick();
    assert.equal(svc.view().staff.pendingReversals, 0);
    assert.ok(cloud.calls.some((c) => c.path === 'sync/m1/prepaid-vouchers/redemptions/red-9/reverse' && c.method === 'POST'));
  });
});

describe('the kiosk and the tills', () => {
  it('"עזרה" rides on the next kiosk/sync until the tills answer', async () => {
    const { cloud, svc } = await paired();
    svc.reportFlow({ flowState: 'ordering', screen: 'catalog', busy: false, idle: false });
    svc.helpRequest();
    let help: { requestId: string; pings: number } | undefined;
    cloud.handlers['POST sync/m1/kiosk/sync'] = (c) => {
      const alerts = ((c.body?.status as { alerts?: Array<{ kind: string; requestId: string; pings: number }> })?.alerts ?? []);
      help = alerts.find((a) => a.kind === 'help');
      return { status: 200, body: { kiosk: true, configVersion: 'v1', config: {}, state: {}, alerts: { help: help ? { requestId: help.requestId, state: 'acknowledged' } : null } } };
    };
    await svc.kioskSync();
    assert.equal(help?.pings, 1);
    help = undefined;
    await svc.kioskSync();
    assert.equal(help, undefined);
  });

  it('a "close the shift" request is answered: a browser kiosk has no shift', async () => {
    const { cloud, svc } = await paired();
    cloud.handlers['POST sync/m1/kiosk/sync'] = () => ({ status: 200, body: { kiosk: true, configVersion: 'v1', config: {}, state: {}, closeRequest: { id: '0b8e3a2c-1d4f-4e5a-9b6c-7d8e9f0a1b2c' } } });
    await svc.kioskSync();
    const close = svc.kioskStatus().closeResult as { id: string; state: string };
    assert.deepEqual([close.id, close.state], ['0b8e3a2c-1d4f-4e5a-9b6c-7d8e9f0a1b2c', 'done']);
  });

  it('a pause from the cloud rests the kiosk; a timed one lifts at its time', async () => {
    const { cloud, svc, tick, nowMs } = await paired();
    const until = new Date(nowMs() + 60_000).toISOString();
    cloud.handlers['POST sync/m1/kiosk/sync'] = () => ({ status: 200, body: { kiosk: true, configVersion: 'v5', config: {}, state: { paused: true, message: 'תכף חוזרים', until } } });
    await svc.kioskSync();
    assert.deepEqual([svc.view().state.paused, svc.view().state.pausedMessage], [true, 'תכף חוזרים']);
    tick(61_000);
    await svc.kioskSync();
    assert.equal(svc.view().state.paused, false);
  });

  it('checks the basket against the catalog before the order goes out', async () => {
    const { cloud, svc } = await paired();
    // The cloud does not answer in time: the kiosk's own catalog decides (and the kiosk is not "offline" for it).
    cloud.handlers['POST sync/m1/kiosk/basket-check'] = () => 'offline';
    const r = await svc.checkBasket([
      { key: 'a', productId: 'p1', unitAgorot: 5000, qty: 2, options: [] },
      { key: 'b', productId: 'p2', unitAgorot: 1000, options: [] },
      { key: 'c', productId: 'p1', unitAgorot: 5900, options: [{ groupId: 'g1', optionId: 'o1' }] },
    ]);
    assert.deepEqual(r.changes.map((c) => [c.kind, c.key]), [['repriced', 'a'], ['removed', 'b']]);
    assert.equal(r.totalAgorot, 2 * 5400 + 5900);
    assert.equal(r.source, 'local');
    assert.equal(svc.view().state.offline, false);
  });

  it('asks the cloud first (kiosk/basket-check): gone, a base price now, changed promotions pulled', async () => {
    const { cloud, svc } = await paired();
    cloud.handlers['GET sync/m1/promotions'] = () => ({
      status: 200,
      body: { etag: 'e2', promotions: [{ id: 'pr1', name: '10% המבורגרים', type: 'discount', priority: 0, config: { target: { categoryIds: ['c1'] }, discountKind: 'percent', discountValue: 10 } }] },
    });
    cloud.handlers['POST sync/m1/kiosk/basket-check'] = (c) => {
      const lines = c.body?.lines as Array<{ productId: string; unitPriceAgorot?: number }>;
      return {
        status: 200,
        body: {
          ok: false,
          lines: lines.map((l) => (l.productId === 'p1' ? { productId: 'p1', available: true, reason: null, priceAgorot: 5600, priceChanged: true } : { productId: l.productId, available: false, reason: 'unavailable', priceAgorot: null, priceChanged: false })),
          promotions: { etag: 'e2', changed: true },
        },
      };
    };
    const shown = 5400 + 5900;
    const r = await svc.checkBasket(
      [
        { key: 'a', productId: 'p1', unitAgorot: 5400, options: [] },
        { key: 'c', productId: 'p1', unitAgorot: 5900, options: [{ groupId: 'g1', optionId: 'o1' }] },
      ],
      shown,
    );
    const ask = cloud.calls.find((c) => c.path === 'sync/m1/kiosk/basket-check')!;
    // Each line's product with the base price the kiosk holds (no option), one per line.
    assert.deepEqual(ask.body?.lines, [{ productId: 'p1', quantity: 1, unitPriceAgorot: 5400 }, { productId: 'p1', quantity: 1, unitPriceAgorot: 5400 }]);
    assert.deepEqual(r.changes.map((c) => (c.kind === 'repriced' ? [c.key, c.from, c.to] : [c.key])), [['a', 5400, 5600], ['c', 5900, 6100]]);
    // The new promotion (10%) pulled before pricing: the total the customer is shown now.
    assert.equal(r.promotions, true);
    assert.equal(r.source, 'cloud');
    assert.equal(r.totalAgorot, 5600 - 560 + (6100 - 610));
    assert.equal(r.totalMoved, true);
    // A product the cloud says is gone is removed, though the kiosk's catalog still sells it.
    cloud.handlers['POST sync/m1/kiosk/basket-check'] = () => ({ status: 200, body: { ok: false, lines: [{ productId: 'p1', available: false, reason: 'out_of_stock', priceAgorot: 5400, priceChanged: false }] } });
    const gone = await svc.checkBasket([{ key: 'a', productId: 'p1', unitAgorot: 5600, options: [] }]);
    assert.deepEqual(gone.changes.map((c) => [c.kind, c.key]), [['removed', 'a']]);
  });
});

describe('storage', () => {
  it('localStorage: JSON in, JSON out, listed by prefix; a full storage never throws', async () => {
    const map = new Map<string, string>();
    let full = false;
    const fake: StorageLike = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        if (full) throw new Error('QuotaExceededError');
        map.set(k, v);
      },
      removeItem: (k) => void map.delete(k),
      key: (i) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    };
    const s = new LocalStore(fake);
    await s.set(`${KV.orderPrefix}a`, { x: 1 });
    await s.set('other', 2);
    assert.deepEqual(await s.get(`${KV.orderPrefix}a`), { x: 1 });
    assert.deepEqual(await s.keys(KV.orderPrefix), [`${KV.orderPrefix}a`]);
    full = true;
    await s.set('big', 'x');
    assert.equal(await s.get('big'), null);
    map.set('broken', '{not json');
    assert.equal(await s.get('broken'), null);
  });

  it('falls back to memory when the browser blocks storage (and still works)', async () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    };
    const s = await openKioskStore({ indexedDB: null, localStorage: throwing });
    assert.equal(s.kind, 'memory');
    await s.set(KV.credentials, { a: 1 });
    assert.deepEqual(await s.get(KV.credentials), { a: 1 });
  });
});

describe('the API and the catalog', () => {
  it('builds the base as the tills do', () => {
    assert.equal(apiBase('https://api.example.com/'), 'https://api.example.com/api/v1/');
    assert.equal(apiBase('api.example.com'), 'https://api.example.com/api/v1/');
    assert.equal(apiBase('http://localhost:8001/api/v1'), 'http://localhost:8001/api/v1/');
    assert.equal(normalizePairingCode(' ab12 cd-34 '), 'AB12CD34');
    assert.equal(detailOf({ detail: { code: 'x' } }), 'x');
    assert.equal(messageOf({ detail: { message: 'שלום' } }), 'שלום');
  });

  it('tells the browser and the OS for the dashboard', () => {
    assert.deepEqual(describeBrowser('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), { browser: 'Safari', os: 'iPadOS', model: 'iPad' });
    assert.equal(describeBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0').browser, 'Edge');
    assert.equal(describeBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1').os, 'iPadOS');
    const info = webDeviceInfo({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36', screen: { width: 1920, height: 1080, dpr: 1 }, standalone: true }, '1.0.0');
    assert.deepEqual([info.platform, info.os, info.screen, info.installed], ['web', 'Windows', '1920x1080@1', 'yes']);
  });

  it('asks a Cloudinary picture at the size it is shown; any other URL as it is', () => {
    assert.equal(sizedImage('https://res.cloudinary.com/demo/image/upload/v123/a.jpg', 480), 'https://res.cloudinary.com/demo/image/upload/c_limit,w_480,f_auto,q_auto/v123/a.jpg');
    assert.equal(sizedImage('https://res.cloudinary.com/demo/image/upload/c_fill,w_300/v1/a.jpg', 480), 'https://res.cloudinary.com/demo/image/upload/c_fill,w_300/v1/a.jpg');
    assert.equal(sizedImage('http://localhost:8001/media/a.webp', 480), 'http://localhost:8001/media/a.webp');
    assert.equal(sizedImage(null, 480), null);
  });

  it('a full pull of nothing never empties the kiosk; a delta upserts', () => {
    const prev = { products: [{ id: 'p1', name: 'a' }], categories: [{ id: 'c1' }], menu: null, machineCatalog: null, serverTime: null };
    assert.equal(applyCatalogPull(prev, { syncType: 'full', products: [], categories: [] }).products.length, 1);
    const next = applyCatalogPull(prev, { syncType: 'delta', products: [{ id: 'p2' }, { id: 'p1', name: 'b' }], serverTime: 'T' });
    assert.deepEqual(next.products.map((p) => [p.id, p.name]), [['p1', 'b'], ['p2', undefined]]);
    assert.equal(next.serverTime, 'T');
    const cat = buildWebCatalog({ ...next, categories: [{ id: 'c1', name: 'x' }], products: [{ id: 'p1', categoryId: 'c1', name: 'b', price: 12.345, allergens: ['milk'] }] }, {});
    assert.equal(cat.products[0].price, 12.35);
    assert.deepEqual([cat.products[0].allergens, cat.products[0].allergenCodes], [['חלב'], ['milk']]);
  });

  it('never shows what needs a manager\'s code: the product, or a category with everything beneath it', () => {
    const cat = buildWebCatalog({
      products: [
        { id: 'cola', categoryId: 'drinks', name: 'קולה', price: 8 },
        { id: 'cigars', categoryId: 'drinks', name: 'סיגרים', price: 90, requiresManagerApproval: true },
        { id: 'beer', categoryId: 'alcohol', name: 'בירה', price: 25 },
        { id: 'merlot', categoryId: 'wine', name: 'מרלו', price: 120 },
      ],
      categories: [
        { id: 'drinks', name: 'שתייה' },
        { id: 'alcohol', name: 'אלכוהול', parentId: 'drinks', requiresManagerApproval: true },
        { id: 'wine', name: 'יין', parentId: 'alcohol' },
      ],
      menu: null,
      machineCatalog: null,
    }, {});
    assert.deepEqual(cat.products.map((p) => p.id), ['cola']);
    assert.deepEqual(cat.categories.map((c) => c.id), ['drinks']);
  });

  it('lists the media a config holds for the service worker', () => {
    const urls = configMediaUrls({ theme: { logo: { url: 'https://x/l.png', kind: 'image' } }, attract: { slides: [{ media: { url: 'https://x/v.mp4', kind: 'video' } }, { media: { url: 'blob:x', kind: 'image' } }] } });
    assert.deepEqual(urls.sort(), ['https://x/l.png', 'https://x/v.mp4']);
  });
});
