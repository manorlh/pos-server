import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './kioskWebStore';
import { CustomerDisplayWebService, KEYS, parseConfigPayload } from './customerDisplayWeb';

type Call = { method: string; url: string; headers: Record<string, string> };

function fakeCloud(script: (call: Call) => { status: number; body?: unknown; etag?: string }) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string> }) => {
    const call = { method: init.method, url, headers: init.headers };
    calls.push(call);
    const r = script(call);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => text,
      headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? (r.etag ?? null) : null) },
    };
  };
  return { calls, fetchFn };
}

const CONFIG = {
  role: 'display',
  config: { enabled: true, language: 'en', show: { prices: false } },
  branding: { shopName: 'סניף 1', logoUrl: 'https://x/logo.png', primaryColor: null },
  media: [],
  poll: { configSec: 120, relayMs: 1500, lanMs: 700 },
  till: { machineId: 't1', name: 'קופה 1' },
};

function service(cloud: ReturnType<typeof fakeCloud>, now: { t: number }) {
  return new CustomerDisplayWebService({
    store: new MemoryStore(),
    fetchFn: cloud.fetchFn,
    defaultServer: 'https://api.example',
    appVersion: 'test',
    deviceInfo: () => ({ platform: 'web' }),
    now: () => now.t,
    timers: { set: () => 0, clear: () => undefined },
  });
}

test('the configuration from the wire: defaults completed, the till named', () => {
  const p = parseConfigPayload(CONFIG);
  assert.ok(p);
  assert.equal(p.config.enabled, true);
  assert.equal(p.config.language, 'en');
  assert.equal(p.config.show.prices, false);
  assert.equal(p.config.show.items, true);
  assert.equal(p.till?.name, 'קופה 1');
  assert.equal(parseConfigPayload(null), null);
});

test('pairs, pulls the configuration, then the till state through the relay — only what is newer', async () => {
  const now = { t: 1_000_000 };
  let relaySeq = 3;
  const cloud = fakeCloud((c) => {
    if (c.url.endsWith('/pairing/validate')) return { status: 200, body: { accessToken: 'tok', machineId: 'd1' } };
    if (c.url.endsWith('/sync/d1/customer-display')) return { status: 200, body: CONFIG, etag: '"e1"' };
    if (c.url.includes('/sync/d1/customer-display/state')) {
      if (c.url.endsWith(`after=${relaySeq}`)) return { status: 204 };
      return { status: 200, body: { seq: relaySeq, state: { v: 1, seq: relaySeq, phase: 'basket', lines: [], total: 4500, itemCount: 1 } } };
    }
    if (c.url.endsWith('/machines/me/heartbeat')) return { status: 200, body: {} };
    return { status: 404 };
  });
  const svc = service(cloud, now);
  await svc.init();
  assert.equal(svc.view().phase, 'unpaired');
  assert.deepEqual(await svc.pair({ code: 'ABC123', machineName: 'מסך' }), { ok: true });
  await svc.tick();
  let v = svc.view();
  assert.equal(v.phase, 'ready');
  assert.equal(v.state.phase, 'basket');
  assert.equal(v.state.total, 4500);
  assert.equal(v.tillName, 'קופה 1');
  assert.equal(v.online, true);
  // Nothing newer: 204, the screen stays.
  await svc.tick();
  assert.equal(svc.view().state.total, 4500);
  assert.ok(cloud.calls.some((c) => c.url.endsWith('state?after=3')));
  // The configuration is asked again only when due, and with its ETag.
  now.t += 121_000;
  relaySeq = 4;
  await svc.tick();
  const configCalls = cloud.calls.filter((c) => c.url.endsWith('/sync/d1/customer-display'));
  assert.equal(configCalls.length, 2);
  assert.equal(configCalls[1].headers['If-None-Match'], '"e1"');
  // The cloud stops answering: "offline" after a while, the last screen kept.
  v = svc.view();
  now.t += 20_000;
  assert.equal(svc.view().online, false);
  assert.equal(svc.view().state.phase, v.state.phase);
});

test('a code that is no customer display\'s: said, and no state is read', async () => {
  const now = { t: 5_000 };
  const cloud = fakeCloud((c) => {
    if (c.url.endsWith('/pairing/validate')) return { status: 200, body: { accessToken: 'tok', machineId: 'k1' } };
    if (c.url.endsWith('/sync/k1/customer-display')) return { status: 200, body: { ...CONFIG, role: 'till' } };
    return { status: 200, body: {} };
  });
  const svc = service(cloud, now);
  await svc.init();
  await svc.pair({ code: 'ABC123', machineName: '' });
  await svc.tick();
  assert.match(svc.view().wrongRole ?? '', /מסך לקוח/);
  assert.equal(cloud.calls.filter((c) => c.url.includes('/customer-display/state')).length, 0);
});

test('a revoked token goes back to pairing and forgets the configuration', async () => {
  const now = { t: 5_000 };
  const store = new MemoryStore();
  await store.set(KEYS.credentials, { serverUrl: 'https://api.example/api/v1/', accessToken: 't', machineId: 'd1', machineCode: null, tenantId: null, shopId: null, pairedAt: '' });
  const cloud = fakeCloud(() => ({ status: 401, body: { detail: 'Token revoked' } }));
  const svc = new CustomerDisplayWebService({
    store, fetchFn: cloud.fetchFn, defaultServer: 'https://api.example', appVersion: 't', deviceInfo: () => ({}),
    now: () => now.t, timers: { set: () => 0, clear: () => undefined },
  });
  await svc.init();
  await svc.tick();
  assert.equal(svc.view().phase, 'unpaired');
  assert.equal(await store.get(KEYS.credentials), null);
});
