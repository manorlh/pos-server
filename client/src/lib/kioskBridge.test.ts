/**
 * Run with `npm test`. "גשר לדפדפן" on the browser side (lib/kioskBridge.ts, docs/SPEC_KIOSK.md §28):
 * finding the bridge, pairing, signed calls, linking the kiosk's machine — against a pretend bridge
 * that checks every signature as the real one does — and what the browser kiosk does with it
 * (lib/kioskWebService.ts): the card tile enabled only through a ready, linked bridge; nothing
 * changes without one; the machine's heartbeat and the shift's close left to the bridge. (The real
 * bridge runs this same file in kiosk-desktop/test/bridge.test.ts.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  BridgeAgent,
  BridgeClient,
  base64url,
  bridgeCardReady,
  bridgeCardReason,
  bridgeCodeFromHash,
  bridgeStoreKey,
  bridgeWorthProbing,
  canonical,
  fromBase64url,
  hashWithoutBridgeCode,
  payFlowEvent,
  type BridgeFetch,
} from './kioskBridge';
import { asksPayMethod, mergeBridgePart, usableMethods, webSells, WebKioskService } from './kioskWebService';
import { MemoryStore } from './kioskWebStore';
import type { FetchFn } from './kioskWebApi';

type Json = Record<string, unknown>;

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), headers: { get: () => null } };
}

/** A bridge that answers as the real one: one pairing, every other call's signature checked. */
function fakeBridge(opts: { cardReady?: boolean; down?: boolean } = {}) {
  const st = {
    down: opts.down ?? false,
    paired: false,
    pairingId: null as string | null,
    secret: null as string | null,
    link: null as Json | null,
    cardReady: opts.cardReady ?? true,
    calls: [] as string[],
    linkBodies: [] as Json[],
    flows: [] as Json[],
    closes: [] as string[],
    nonces: new Set<string>(),
  };
  const status = () => ({
    api: 1,
    version: '0.3.0',
    role: 'kiosk',
    link: st.link,
    ready: { card: st.cardReady && !!st.link, print: true, drawer: false },
    card: st.link ? { ready: st.cardReady, state: st.cardReady ? 'ready' : 'unreachable', blocked: false, reason: st.cardReady ? null : 'מסופון האשראי לא זמין כרגע', kind: 'nayax_lan', unresolved: [] } : null,
    printer: { target: 'Windows: SNBC BTP-880', health: 'ok', lastError: null, lastOkAt: null },
    drawer: false,
    shift: st.link ? { open: true, number: 3 } : null,
    outbox: 0,
    pay: null,
    statusPart: st.link
      ? { shiftOpen: true, bonPrinter: 'ok', receiptPrinter: 'ok', unprintedBons: 0, ordersToday: 2, salesTodayAgorot: 10800, pendingOrders: 0, alerts: [], health: { terminal: { state: 'ready', address: 'https://10.0.0.5:8080/SPICy' }, printer: { state: 'ok' }, pending: { documents: 1, orders: 0 } } }
      : null,
    launcher: { enabled: false, phase: 'off' },
  });
  const fetchFn: BridgeFetch = async (url, init) => {
    if (st.down) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const path = u.pathname;
    st.calls.push(`${init.method} ${path}`);
    const body = init.body ? (JSON.parse(init.body) as Json) : {};
    if (path === '/health') return reply(200, { bridge: 'r2m', api: 1, version: '0.3.0', paired: st.paired, pairingId: st.pairingId, role: st.paired ? 'kiosk' : null, ready: { card: false, print: st.paired, drawer: false } });
    if (path === '/pair') {
      if (body.code !== '482913') return reply(403, { error: 'code', message: 'קוד שגוי (נותרו 4 ניסיונות)' });
      st.paired = true;
      st.pairingId = randomBytes(12).toString('base64url');
      st.secret = randomBytes(32).toString('base64url');
      return reply(200, { pairingId: st.pairingId, secret: st.secret, api: 1, version: '0.3.0' });
    }
    const h = init.headers;
    const ts = h['X-R2M-Ts'];
    const nonce = h['X-R2M-Nonce'];
    const good =
      st.paired &&
      h['X-R2M-Bridge-Key'] === st.pairingId &&
      !st.nonces.has(nonce) &&
      h['X-R2M-Sig'] ===
        createHmac('sha256', Buffer.from(st.secret!, 'base64url'))
          .update(canonical(init.method, path + u.search, ts, nonce, createHash('sha256').update(init.body ?? '').digest('hex')))
          .digest('base64url');
    if (!good) return reply(401, { error: 'auth', why: h['X-R2M-Bridge-Key'] === st.pairingId ? 'signature' : 'unknown_key' });
    st.nonces.add(nonce);
    if (path === '/status') return reply(200, status());
    if (path === '/link') {
      st.linkBodies.push(body);
      st.link = { machineId: body.machineId, role: 'kiosk', linkedAt: '2026-10-07T10:00:00Z', machineName: body.machineName ?? null, shopName: 'סניף', posNumber: '7' };
      return reply(200, status());
    }
    if (path === '/flow') {
      st.flows.push(body);
      return reply(200, { ok: true });
    }
    if (path === '/close-request') {
      st.closes.push(String(body.id));
      return reply(200, { state: 'done', shiftId: 'shift-3', zNumber: null, detail: null });
    }
    if (path === '/unpair') {
      st.paired = false;
      st.pairingId = null;
      return reply(200, { ok: true });
    }
    return reply(404, { error: 'not_found' });
  };
  return { st, fetchFn };
}

describe('the browser side of the bridge (pure)', () => {
  it('base64url both ways; the canonical string; the code in the fragment, used once', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const b = randomBytes(n);
      assert.equal(base64url(b), Buffer.from(b).toString('base64url'));
      assert.deepEqual(Buffer.from(fromBase64url(Buffer.from(b).toString('base64url'))), b);
    }
    assert.equal(canonical('post', '/pay/start', 17, 'n', 'ABC'), 'POST\n/pay/start\n17\nn\nabc');
    assert.equal(bridgeCodeFromHash('#pair=AB12CD34&bridge=482913'), '482913');
    assert.equal(bridgeCodeFromHash('#bridge=48291'), null);
    assert.equal(hashWithoutBridgeCode('#pair=AB12CD34&bridge=482913'), '#pair=AB12CD34');
    assert.equal(bridgeStoreKey('kds'), 'r2m.bridge.kds');
  });

  it('looked for on Windows, or with a pairing or a code — never on an iPad that has neither', () => {
    const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36';
    assert.equal(bridgeWorthProbing({ userAgent: ipad, hasPairing: false, hasCode: false }), false);
    assert.equal(bridgeWorthProbing({ userAgent: win, hasPairing: false, hasCode: false }), true);
    assert.equal(bridgeWorthProbing({ userAgent: ipad, hasPairing: true, hasCode: false }), true);
  });

  it('the payment states move the kiosk as on Windows', () => {
    assert.equal(payFlowEvent({ phase: 'charging' }), 'paymentCharging');
    assert.equal(payFlowEvent({ phase: 'approved' }), 'paymentApproved');
    assert.equal(payFlowEvent({ phase: 'declined' }), 'paymentDeclined');
    assert.equal(payFlowEvent({ phase: 'unknown' }), 'paymentUnknown');
  });

  it('the pay methods: the card only through a ready bridge; asked unless the card is the only way', () => {
    assert.deepEqual(usableMethods(['card', 'voucher', 'cash_at_till'], true), ['voucher', 'cash_at_till']);
    assert.deepEqual(usableMethods(['card', 'voucher', 'cash_at_till'], false, true), ['card', 'cash_at_till']);
    assert.equal(webSells(['card']), false);
    assert.equal(webSells(['card'], true), true);
    assert.equal(asksPayMethod(['card'], true), false);
    assert.equal(asksPayMethod(['card', 'cash_at_till'], true), true);
    assert.equal(asksPayMethod(['card', 'cash_at_till'], false), true);
    assert.equal(asksPayMethod(['card'], false), false);
  });

  it('the bridge’s part merged into the kiosk’s status: its shift, its card orders, its terminal', () => {
    const s = mergeBridgePart(
      { shiftOpen: false, ordersToday: 1, salesTodayAgorot: 500, pendingOrders: 1, alerts: [{ kind: 'help' }], health: { platform: 'web', terminal: { state: 'none' }, pending: { orders: 1, documents: 0 } } },
      { shiftOpen: true, ordersToday: 2, salesTodayAgorot: 10800, pendingOrders: 0, alerts: [{ kind: 'printer', key: 'printer:receipt' }], health: { terminal: { state: 'ready' }, pending: { documents: 1, orders: 0 } } },
    );
    assert.equal(s.shiftOpen, true);
    assert.equal(s.ordersToday, 3);
    assert.equal(s.salesTodayAgorot, 11300);
    assert.equal((s.alerts as unknown[]).length, 2);
    assert.deepEqual((s.health as Json).terminal, { state: 'ready' });
    assert.deepEqual(((s.health as Json).pending as Json).documents, 1);
    assert.equal((s.health as Json).platform, 'web');
  });
});

describe('BridgeClient / BridgeAgent against a pretend bridge', () => {
  it('no bridge: nothing found, nothing paired, no card', async () => {
    const b = fakeBridge({ down: true });
    const client = new BridgeClient({ fetchFn: b.fetchFn, store: new MemoryStore(), role: 'kiosk' });
    const agent = new BridgeAgent(client, { WebSocket: null });
    const s = await agent.refresh();
    assert.equal(s.present, false);
    assert.equal(bridgeCardReady(s, 'm1'), false);
    assert.equal(bridgeCardReason(s, 'm1'), null);
  });

  it('pairs with the code, keeps the secret, signs every call, links the kiosk’s machine once', async () => {
    const b = fakeBridge();
    const store = new MemoryStore();
    const client = new BridgeClient({ fetchFn: b.fetchFn, store, role: 'kiosk' });
    const agent = new BridgeAgent(client, { machine: () => ({ serverUrl: 'http://cloud.test/api/v1/', machineId: 'm1', accessToken: 'tok', machineName: 'קיוסק' }), WebSocket: null });
    let s = await agent.refresh();
    assert.equal(s.present, true);
    assert.equal(s.paired, false);
    assert.equal(bridgeCardReason(s, 'm1'), 'הגשר ל-Windows לא מצומד');
    const wrong = await agent.pair('000000');
    assert.deepEqual(wrong, { ok: false, error: 'קוד שגוי (נותרו 4 ניסיונות)' });
    assert.deepEqual(await agent.pair('482 913'), { ok: true });
    s = agent.state;
    assert.equal(s.paired, true);
    assert.equal(bridgeCardReady(s, 'm1'), true);
    assert.equal(bridgeCardReady(s, 'another-machine'), false);
    assert.deepEqual(b.st.linkBodies, [{ serverUrl: 'http://cloud.test/api/v1/', machineId: 'm1', accessToken: 'tok', machineName: 'קיוסק' }]);
    assert.ok((await store.get<{ secret: string }>(bridgeStoreKey('kiosk')))?.secret);
    // A reload: the pairing comes back from storage; the link is not sent again.
    const again = new BridgeClient({ fetchFn: b.fetchFn, store, role: 'kiosk' });
    await again.load();
    const agent2 = new BridgeAgent(again, { machine: () => ({ serverUrl: 'http://cloud.test/api/v1/', machineId: 'm1', accessToken: 'tok', machineName: 'קיוסק' }), WebSocket: null });
    assert.equal((await agent2.refresh()).paired, true);
    assert.equal(b.st.linkBodies.length, 1);
    // The flow, once per change.
    agent2.reportFlow({ flowState: 'attract', screen: 'attract', busy: false, idle: true });
    agent2.reportFlow({ flowState: 'attract', screen: 'attract', busy: false, idle: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.st.flows.length, 1);
  });

  it('a bridge paired again elsewhere: this page’s secret is dropped, the card off', async () => {
    const b = fakeBridge();
    const store = new MemoryStore();
    const client = new BridgeClient({ fetchFn: b.fetchFn, store, role: 'kiosk' });
    const agent = new BridgeAgent(client, { WebSocket: null });
    await agent.pair('482913');
    b.st.pairingId = 'someone-elses-pairing';
    const s = await agent.refresh();
    assert.equal(s.paired, false);
    assert.equal(s.otherPage, true);
    assert.equal(await store.get(bridgeStoreKey('kiosk')), null);
    assert.equal(bridgeCardReason(s, 'm1'), 'הגשר מצומד לדף אחר');
  });
});

describe('the browser kiosk with a bridge (kioskWebService)', () => {
  const SNAP = {
    kiosk: true,
    name: 'קיוסק דפדפן',
    configVersion: 'v1',
    config: { payment: { methods: ['card'] }, pickup: { scope: 'kiosk', prefix: 'W', start: 1, max: 999 } },
    state: { paused: false },
    operator: { id: 'kiosk:m1', name: 'קיוסק' },
    alerts: { open: [], help: null },
    closeRequest: { id: 'close-1', source: 'cloud_shop_z' },
  };

  function cloud() {
    const calls: Array<{ method: string; path: string; body: Json | null }> = [];
    const fetchFn: FetchFn = async (input, init) => {
      const path = new URL(input).pathname.replace(/^\/api\/v1\//, '');
      const body = init.body ? (JSON.parse(init.body) as Json) : null;
      calls.push({ method: init.method, path, body });
      const map: Record<string, unknown> = {
        'pairing/validate': { accessToken: 'tok', machineId: 'm1' },
        'machines/me': { machineId: 'm1', machineName: 'קיוסק דפדפן', posNumber: '7' },
        'machines/me/heartbeat': { ok: true },
        'sync/m1/kiosk/sync': SNAP,
        'sync/m1/settings': { syncType: 'full', settings: {}, businessInfo: null },
        'sync/m1/parameters': { parameters: {} },
        'sync/m1/catalog': { syncType: 'full', serverTime: 't', categories: [], products: [] },
      };
      const b = map[path];
      return { ok: b !== undefined, status: b !== undefined ? 200 : 404, text: async () => JSON.stringify(b ?? { detail: 'Not Found' }), headers: { get: () => null } };
    };
    return { calls, fetchFn };
  }

  async function kioskWith(bridge: ReturnType<typeof fakeBridge> | null) {
    const c = cloud();
    const store = new MemoryStore();
    let svc: WebKioskService | null = null;
    const agent = bridge
      ? new BridgeAgent(new BridgeClient({ fetchFn: bridge.fetchFn, store, role: 'kiosk' }), { machine: () => svc?.bridgeMachine() ?? null, WebSocket: null })
      : null;
    svc = new WebKioskService({ store, fetchFn: c.fetchFn, defaultServer: 'http://cloud.test', appVersion: 'web-1.0.0', deviceInfo: () => ({ platform: 'web' }), bridge: agent, timers: { set: () => 0, clear: () => undefined } });
    await svc.init();
    assert.deepEqual(await svc.pair({ code: 'AB12CD34', machineName: 'קיוסק' }), { ok: true });
    return { svc, agent, c };
  }

  it('without a bridge nothing changes: card-only config rests on "התשלום אינו זמין"', async () => {
    const { svc, c } = await kioskWith(null);
    const v = svc.view();
    assert.equal(v.bridge, null);
    assert.deepEqual(v.pay.usable, []);
    assert.equal(v.pay.cardOff, 'browser');
    assert.equal(v.state.noPayment, true);
    // The browser's own heartbeat, and "no shift here" for the shop Z's close.
    assert.ok(c.calls.some((x) => x.path === 'machines/me/heartbeat'));
    assert.deepEqual((svc.kioskStatus().closeResult as Json).state, 'done');
    svc.stop();
  });

  it('a ready, linked bridge: the card tile on, the kiosk sells; its heartbeat and the close are the bridge’s', async () => {
    const b = fakeBridge();
    const { svc, agent, c } = await kioskWith(b);
    // Not looked for yet: as with no bridge.
    assert.equal(svc.view().pay.cardOff, 'browser');
    await agent!.refresh();
    assert.equal(svc.view().pay.cardOff, 'הגשר ל-Windows לא מצומד');
    await agent!.pair('482913');
    const v = svc.view();
    assert.deepEqual(v.pay.usable, ['card']);
    assert.equal(v.pay.cardOff, null);
    assert.equal(v.state.noPayment, false);
    assert.equal(v.bridge?.fiscal, true);
    assert.equal(b.st.linkBodies[0].machineId, 'm1');
    // The machine's heartbeat is the bridge's from now on.
    const beats = c.calls.filter((x) => x.path === 'machines/me/heartbeat').length;
    await svc.syncNow();
    assert.equal(c.calls.filter((x) => x.path === 'machines/me/heartbeat').length, beats);
    // kiosk/sync: the bridge's shift and card orders in, health.bridge reported, the close handed over.
    await new Promise((r) => setTimeout(r, 20));
    const s1 = svc.kioskStatus();
    assert.equal(s1.shiftOpen, true);
    assert.equal(s1.ordersToday, 2);
    assert.deepEqual(((s1.health as Json).bridge as Json).paired, true);
    // The sync handed the close to the bridge (never "no shift here"); its answer goes up next.
    assert.deepEqual(b.st.closes, ['close-1']);
    assert.deepEqual(svc.kioskStatus().closeResult, { id: 'close-1', state: 'done', shiftId: 'shift-3', zNumber: null, detail: null });
    // The flow goes to the bridge too.
    svc.reportFlow({ flowState: 'ordering', screen: 'catalog', busy: false, idle: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(b.st.flows.at(-1), { flowState: 'ordering', screen: 'catalog', busy: false, idle: false });
    svc.stop();
  });

  it('a bridge whose terminal does not answer: the tile grey with the bridge’s reason', async () => {
    const b = fakeBridge({ cardReady: false });
    const { svc, agent } = await kioskWith(b);
    await agent!.pair('482913');
    const v = svc.view();
    assert.equal(v.pay.cardOff, 'מסופון האשראי לא זמין כרגע');
    assert.deepEqual(v.pay.usable, []);
    assert.equal(v.state.noPayment, true);
    svc.stop();
  });
});
