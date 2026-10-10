/**
 * "גשר לדפדפן" (pos-server docs/SPEC_KIOSK.md §28): the bridge's local API, end to end — its real
 * server (main/bridge/server.ts) over its real runtime (runtime.ts, the Windows kiosk's service in
 * bridge mode), driven by the BROWSER's own client (client/src/lib/kioskBridge.ts, the copy the
 * dashboard ships). The cloud and the pinpad are fakes (the existing fake-provider pattern of
 * cardRecovery.test.ts); nothing reaches a real terminal or printer.
 */

import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BridgeAgent,
  BridgeClient,
  bridgeCardReady,
  bridgeCardReason,
  bridgeCodeFromHash,
  hashWithoutBridgeCode,
  payFlowEvent,
  type BridgeFetch,
  type BridgeKv,
  type BridgePayProgress,
  type BridgeStatus,
} from '@dash-lib/kioskBridge';
import { canonical as webCanonical } from '@dash-lib/kioskBridge';
import {
  BRIDGE_PORT,
  canonical,
  corsHeaders,
  normalizeOrigin,
  originAllowed,
  originList,
  ROLE_CAPS,
  roleOf,
} from '../src/core/bridgeProtocol';
import { BRIDGE_PORT as WEB_PORT } from '@dash-lib/kioskBridge';
import { checkCode, CODE_TTL_MS, LOCK_MS, MAX_TRIES, newCode } from '../src/core/bridgePairing';
import { browserArgs, launchable, launchUrl, parseDashboardLink, pickBrowser, relaunchDelayMs, urlForRole } from '../src/core/bridgeLauncher';
import { DRAWER_KICK } from '../src/core/escpos';
import { shellModeOf } from '../src/main/shell/mode';
import { NonceCache, verifyRequest, signCanonical, sha256Hex } from '../src/main/bridge/auth';
import { BridgeRuntime, printablePage, startPaymentInput } from '../src/main/bridge/runtime';
import { BridgeServer } from '../src/main/bridge/server';
import { decodeFrames } from '../src/main/bridge/ws';
import { BrowserLauncher } from '../src/main/bridge/launcher';
import type { PaymentProvider, Resolution, SaleResult } from '../src/main/payment/provider';
import type { Transport } from '../src/main/printer/transports';

const ORIGIN = 'http://localhost:3002';
const MACHINE = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const MANAGER_PIN_HASH = bcrypt.hashSync('2468', 4);

/* --------------------------------------------------------------- fakes */

type Res = { ok: boolean; status: number; text(): Promise<string>; headers: http.IncomingHttpHeaders };

/** fetch over node:http, with the Origin a browser would send (and an optional Host). */
function httpFetch(origin: string | null, host?: string): (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Res> {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method, headers: { ...init.headers, ...(origin ? { Origin: origin } : {}), ...(host ? { Host: host } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, text: async () => body, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      if (init.body) req.write(init.body);
      req.end();
    });
}

function memoryKv(): BridgeKv & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T,>(k: string) => (map.has(k) ? (structuredClone(map.get(k)) as T) : null),
    set: async (k: string, v: unknown) => void map.set(k, structuredClone(v)),
    del: async (k: string) => void map.delete(k),
  };
}

/** A pinpad whose answers are scripted (never a real terminal). */
function fakePinpad() {
  const asked: string[] = [];
  let seq = 0;
  const script: { sale: SaleResult; resolve: Resolution; delayMs: number } = {
    sale: { answer: 'APPROVED', raw: '', card: { brand: 'visa', last4: '4242', authNum: '0123456', uid: 'u-1', payments: null, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'x' } } },
    resolve: { kind: 'unknown', message: 'no answer' },
    delayMs: 30,
  };
  const provider: PaymentProvider = {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
    newReference: () => `ref${++seq}`,
    check: async () => ({ ok: true, detail: null }),
    sale: async () => {
      asked.push('sale');
      await new Promise((r) => setTimeout(r, script.delayMs));
      return script.sale;
    },
    resolve: async () => {
      asked.push('resolve');
      return script.resolve;
    },
    abort: async () => void asked.push('abort'),
  };
  return { provider, asked, script };
}

/** The cloud as the bridge (as the browser kiosk's machine) sees it. */
function fakeCloud(parameters: Record<string, string> = {}) {
  const state = { down: false };
  const sent: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/v1\//, '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    sent.push({ method, path: p, body, auth });
    if (state.down) return new Response('', { status: 503 });
    const m = `sync/${MACHINE}/`;
    if (p === 'machines/me') return json(200, { machineId: MACHINE, machineName: 'קיוסק דפדפן', posNumber: '7', shopName: 'סניף', companyName: 'עסק', deviceRole: 'kiosk', fiscal: true, platform: 'web' });
    if (p === 'machines/me/heartbeat') return json(200, { ok: true, zMode: 'cloud', lastTillZNumber: 0, tillZEpoch: 0 });
    if (p === `${m}settings`) return json(200, { syncType: 'full', settings: { paymentIntegration: 'nayax_lan' }, businessInfo: { companyName: 'עסק בע״מ', vatNumber: '515555555' }, settingsUpdatedAt: '2026-10-07T00:00:00Z' });
    if (p === `${m}parameters`) return json(200, { parameters });
    if (p === `${m}kiosk/sync`) {
      return json(200, {
        kiosk: true,
        name: 'קיוסק דפדפן',
        configVersion: 'v1',
        config: { pickup: { scope: 'kiosk', prefix: 'W', start: 1, max: 999 }, payment: { methods: ['card', 'cash_at_till'], receiptPolicy: 'ask' } },
        state: { paused: false },
        operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק דפדפן' },
        media: [],
        closeRequest: null,
      });
    }
    if (p === `${m}catalog`) {
      return json(200, {
        syncType: 'full',
        serverTime: '2026-10-07T00:00:00Z',
        categories: [{ id: 'c1', name: 'המבורגרים', isActive: true }],
        products: [{ id: 'p1', categoryId: 'c1', name: 'המבורגר', price: 54, isAvailable: true }],
        menu: null,
        machineCatalog: { mode: 'all' },
      });
    }
    if (p === `${m}pos-users`) {
      return json(200, { syncType: 'full', users: [{ id: 'u-mgr', username: 'dana', firstName: 'דנה', lastName: null, pinHash: MANAGER_PIN_HASH, role: 'shop_manager', isActive: true }] });
    }
    if (p === `${m}transactions`) return json(200, { results: (body?.transactions ?? []).map((t: { id: string }) => ({ id: t.id, status: 'accepted' })) });
    if (p === `${m}shifts` || p.startsWith(`${m}shifts/`) && method === 'POST') return json(200, { ok: true });
    if (p === `${m}kiosk/orders`) return json(200, { ok: true });
    return json(404, { detail: 'Not Found' });
  };
  return { fetchFn, sent, state };
}

const printed: Uint8Array[] = [];
const fakePrinter: Transport = {
  send: async (_t, bytes) => void printed.push(bytes),
  status: async () => ({ health: 'ok', detail: null }),
  list: async () => [{ name: 'SNBC BTP-880', port: 'USB001', health: 'ok' }],
  dispose: () => undefined,
};
/** A page "drawn" as a black square (the real one is the hidden window's canvas). */
const fakeRenderer = async () => ({ width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0)) });

interface Harness {
  runtime: BridgeRuntime;
  server: BridgeServer;
  port: number;
  base: string;
  pinpad: ReturnType<typeof fakePinpad>;
  cloud: ReturnType<typeof fakeCloud>;
  client(role?: 'kiosk' | 'kds' | 'order_status_board', origin?: string | null): BridgeClient;
}

const open: Harness[] = [];

async function harness(parameters: Record<string, string> = {}): Promise<Harness> {
  const pinpad = fakePinpad();
  const cloud = fakeCloud(parameters);
  let n = 0;
  const runtime = new BridgeRuntime({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'r2m-bridge-')),
    appVersion: '0.3.0',
    deviceInfo: { model: 'Windows bridge', platform: 'windows' },
    renderer: fakeRenderer,
    transport: fakePrinter,
    providers: [() => pinpad.provider],
    fetch: cloud.fetchFn,
    // Codes 111111, 222222…: known to the test.
    randomBytes: (k) => new Uint8Array(k).fill(++n % 10),
  });
  await runtime.start();
  const server = new BridgeServer(runtime, { port: 0 });
  const port = await server.listen();
  runtime.setListening(port, null);
  const base = `http://127.0.0.1:${port}`;
  const h: Harness = {
    runtime,
    server,
    port,
    base,
    pinpad,
    cloud,
    client: (role = 'kiosk', origin = ORIGIN) => new BridgeClient({ fetchFn: httpFetch(origin) as unknown as BridgeFetch, store: memoryKv(), role, base }),
  };
  open.push(h);
  return h;
}

afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.server.close();
    h.runtime.stop();
  }
  printed.length = 0;
});

const code = (h: Harness) => h.runtime.currentCode()!;

async function paired(h: Harness, role: 'kiosk' | 'kds' | 'order_status_board' = 'kiosk') {
  const c = h.client(role);
  const r = await c.pair(code(h), { url: `${ORIGIN}/k`, device: { browser: 'Chrome', os: 'Windows' } });
  expect(r).toEqual({ ok: true });
  return c;
}

async function until<T>(fn: () => Promise<T | null | undefined> | T | null | undefined, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* ------------------------------------------------------------- the rules */

describe('the protocol (pure)', () => {
  it('the browser and the bridge speak the same port and the same canonical string', () => {
    expect(WEB_PORT).toBe(BRIDGE_PORT);
    expect(webCanonical('post', '/pay/start', 1, 'n', 'AB')).toBe(canonical('POST', '/pay/start', 1, 'n', 'ab'));
  });

  it('origins: normalized, the dashboard’s by default, nothing else', () => {
    expect(normalizeOrigin('HTTPS://Pos-Cloud-App.vercel.app:443/k?x')).toBe('https://pos-cloud-app.vercel.app');
    expect(normalizeOrigin('null')).toBe(null);
    expect(normalizeOrigin('file:///c:/x.html')).toBe(null);
    expect(normalizeOrigin('https://user:pw@evil.com')).toBe(null);
    const list = originList(['https://dash.example.co.il/', 'garbage']);
    expect(list).toEqual(['https://pos-cloud-app.vercel.app', 'http://localhost:3002', 'https://dash.example.co.il']);
    expect(originAllowed('https://evil.example', list)).toBe(false);
    expect(originAllowed('http://localhost:3002', list)).toBe(true);
    expect(originAllowed('http://localhost:3003', list)).toBe(false);
  });

  it('CORS: the origin echoed; the Private Network Access answer only on a preflight that asks', () => {
    expect(corsHeaders(ORIGIN, { preflight: false })).toEqual({ 'Access-Control-Allow-Origin': ORIGIN, Vary: 'Origin, Access-Control-Request-Private-Network' });
    const pre = corsHeaders(ORIGIN, { preflight: true, privateNetwork: true });
    expect(pre['Access-Control-Allow-Private-Network']).toBe('true');
    expect(pre['Access-Control-Allow-Headers']).toContain('X-R2M-Sig');
    expect(corsHeaders(ORIGIN, { preflight: true })['Access-Control-Allow-Private-Network']).toBeUndefined();
  });

  it('roles and what each may ask', () => {
    expect(roleOf('KDS')).toBe('kds');
    expect(roleOf('pickup')).toBe('order_status_board');
    expect(roleOf('till')).toBe(null);
    expect(ROLE_CAPS.kiosk).toEqual({ card: true, print: true, drawer: true });
    expect(ROLE_CAPS.kds).toEqual({ card: false, print: true, drawer: false });
    expect(ROLE_CAPS.order_status_board).toEqual({ card: false, print: false, drawer: false });
  });

  it('the pairing code: one use, 10 minutes, five tries then locked with a new code', () => {
    const c = newCode((n) => Uint8Array.from([1, 2, 3, 4, 5, 16].slice(0, n)), 0);
    expect(c.code).toBe('123456');
    expect(checkCode(c, '123 456', 1).result).toEqual({ ok: true });
    expect(checkCode(c, '123456', CODE_TTL_MS).result).toMatchObject({ ok: false, reason: 'expired' });
    let s = c;
    for (let i = 1; i < MAX_TRIES; i++) {
      const r = checkCode(s, '000000', 10);
      expect(r.result).toMatchObject({ ok: false, reason: 'wrong', triesLeft: MAX_TRIES - i });
      s = r.next!;
    }
    const last = checkCode(s, '000000', 10);
    expect(last.result).toMatchObject({ ok: false, reason: 'locked_out' });
    // Locked: even the right code waits.
    expect(checkCode(last.next, '123456', 20).result).toMatchObject({ ok: false, reason: 'locked' });
    expect(checkCode(last.next, '123456', 10 + LOCK_MS).result).toEqual({ ok: true });
  });

  it('signatures: right once; replay, another body, an old clock, another key refused', () => {
    const secret = new Uint8Array(32).fill(7);
    const nonces = new NonceCache();
    const body = '{"a":1}';
    const now = 1_760_000_000_000;
    const sig = signCanonical(secret, canonical('POST', '/pay/start', now, 'nonce-0123456789ab', sha256Hex(body)));
    const req = (over: Partial<{ ts: string; nonce: string; sig: string; key: string; body: string }> = {}) =>
      verifyRequest({
        method: 'POST',
        path: '/pay/start',
        headers: { key: over.key ?? 'pairing-id-1', ts: over.ts ?? String(now), nonce: over.nonce ?? 'nonce-0123456789ab', sig: over.sig ?? sig },
        body: over.body ?? body,
        pairing: { pairingId: 'pairing-id-1', secret },
        nonces,
        now,
      });
    expect(req({ body: '{"a":2}' })).toEqual({ ok: false, why: 'signature' });
    expect(req()).toEqual({ ok: true });
    expect(req()).toEqual({ ok: false, why: 'replay' });
    expect(req({ key: 'someone-else' })).toEqual({ ok: false, why: 'unknown_key' });
    expect(req({ ts: String(now - 10 * 60_000), nonce: 'nonce-other-0123456' })).toEqual({ ok: false, why: 'clock' });
    expect(verifyRequest({ method: 'GET', path: '/status', headers: {}, body: '', pairing: null, nonces, now })).toEqual({ ok: false, why: 'missing' });
  });

  it('the basket a page sends is checked field by field; a page prints a bon or a slip, never a receipt', () => {
    expect(startPaymentInput({ lines: [] })).toBe(null);
    expect(startPaymentInput({ lines: [{ key: 'k', productId: 'p', qty: 0 }] })).toBe(null);
    const ok = startPaymentInput({ lines: [{ key: 'k', productId: 'p', qty: 2, options: [{ groupId: 'g', optionId: 'o' }, { bad: 1 }], notes: ['בלי בצל', 3] }], service: 'eat_in', tipPct: 10, expectedTotalAgorot: 100.4 });
    expect(ok).toMatchObject({ lines: [{ key: 'k', productId: 'p', qty: 2, options: [{ groupId: 'g', optionId: 'o', qty: 1, pre: null }], notes: ['בלי בצל'] }], service: 'eat_in', tipPct: 10, expectedTotalAgorot: 100 });
    // A choice's quantity and "מעט / הרבה / בצד", a meal's components (the service prices them from its catalog).
    const rich = startPaymentInput({
      lines: [
        { key: 'k', productId: 'p', qty: 1, options: [{ groupId: 'g', optionId: 'o', qty: 3, pre: 'extra' }, { groupId: 'g', optionId: 'x', qty: 1000, pre: 'huge' }] },
        { key: 'm', productId: 'meal', qty: 1, options: [], meal: { components: [{ slotId: 's1', productId: 'b1' }, { slotId: '', productId: 'b2' }] } },
      ],
    });
    expect(rich?.lines[0].options).toEqual([{ groupId: 'g', optionId: 'o', qty: 3, pre: 'extra' }, { groupId: 'g', optionId: 'x', qty: 1, pre: null }]);
    expect(rich?.lines[1].meal).toEqual({ components: [{ slotId: 's1', productId: 'b1' }] });
    // The order's vouchers: goods ones as legs, discount ones held for it — read field by field, and a discount's minimum and cap kept.
    const benefit = { kind: 'order_discount', discountType: 'percent', value: 1500, minPurchase: 6000, maxDiscount: 700, maxUnits: null, productIds: [], categoryIds: [], promotionPolicy: 'exclude', text: null };
    const vouchers = {
      saleRef: 's-1',
      legs: [{ redemptionId: 'r1', serial: 7, amountAgorot: 1000, eventName: null, includeExtras: false, redeemed: [{ productId: 'p-cola', tillProductId: null, name: null, quantity: 1 }] }],
      discounts: [{ reservationId: 'res-1', clientRequestId: 'c1', voucherId: 'v1', code: 'X', serial: 12, batchId: 'b', batchName: 'פסטיבל', stacking: 'unlimited', benefit, uses: 1, expiresAt: null }],
    };
    const withVouchers = startPaymentInput({ lines: [{ key: 'k', productId: 'p', qty: 1 }], vouchers });
    expect(withVouchers?.vouchers?.legs[0]).toMatchObject({ redemptionId: 'r1', serial: 7, amountAgorot: 1000 });
    expect(withVouchers?.vouchers?.discounts[0].benefit).toMatchObject({ minPurchase: 6000, maxDiscount: 700, value: 1500 });
    expect(startPaymentInput({ lines: [{ key: 'k', productId: 'p', qty: 1 }] })?.vouchers).toBeUndefined();
    // Vouchers that are not an order's are no payment at all (never charged as if there were none).
    expect(startPaymentInput({ lines: [{ key: 'k', productId: 'p', qty: 1 }], vouchers: 'x' })).toBe(null);
    expect(startPaymentInput({ lines: [{ key: 'k', productId: 'p', qty: 1 }], vouchers: { ...vouchers, saleRef: '' } })).toBe(null);
    expect(printablePage('bon', { kind: 'bon', lines: [] })).not.toBe(null);
    expect(printablePage('receipt', { kind: 'receipt' })).toBe(null);
    expect(printablePage('bon', { kind: 'slip' })).toBe(null);
  });

  it('the page’s side: the code in the fragment used once, the card tile’s rules, the flow events', () => {
    expect(bridgeCodeFromHash('#pair=AB12CD34&bridge=482913')).toBe('482913');
    expect(bridgeCodeFromHash('#bridge=12345')).toBe(null);
    expect(hashWithoutBridgeCode('#pair=AB12CD34&bridge=482913')).toBe('#pair=AB12CD34');
    expect(hashWithoutBridgeCode('#bridge=482913')).toBe('');
    expect(payFlowEvent({ phase: 'charging' })).toBe('paymentCharging');
    expect(payFlowEvent({ phase: 'unknown' })).toBe('paymentUnknown');
    expect(payFlowEvent({ phase: 'starting' })).toBe(null);
  });
});

describe('"פתיחה בהפעלה" (pure)', () => {
  const env = { programFiles: 'C:\\Program Files', programFilesX86: 'C:\\Program Files (x86)', localAppData: 'C:\\Users\\k\\AppData\\Local' };

  it('Chrome when installed, else Edge; the kiosk-mode command line with its own profile', () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    expect(pickBrowser('auto', env, (p) => p === edge)).toEqual({ kind: 'edge', exe: edge });
    expect(pickBrowser('auto', env, (p) => p === edge || p === chrome)).toEqual({ kind: 'chrome', exe: chrome });
    expect(pickBrowser('chrome', env, (p) => p === edge)).toBe(null);
    const args = browserArgs('edge', 'https://dash/k', 'C:\\p');
    expect(args).toEqual(expect.arrayContaining(['--kiosk', '--app=https://dash/k', '--user-data-dir=C:\\p', '--edge-kiosk-type=fullscreen', '--no-first-run']));
    expect(browserArgs('chrome', 'https://dash/k', 'C:\\p')).not.toContain('--edge-kiosk-type=fullscreen');
  });

  it('only an allowed site is opened; the dashboard’s link gives the page, its role and the code once', () => {
    const allowed = originList();
    expect(launchable('https://evil.example/k', allowed)).toBe(null);
    expect(launchable('http://localhost:3002/k#pair=X', allowed)).toBe('http://localhost:3002/k');
    expect(urlForRole('https://pos-cloud-app.vercel.app/whatever', 'kds')).toBe('https://pos-cloud-app.vercel.app/kds');
    expect(parseDashboardLink('https://pos-cloud-app.vercel.app/k#pair=ab12-cd34')).toEqual({ url: 'https://pos-cloud-app.vercel.app/k', pairCode: 'AB12CD34', role: 'kiosk' });
    expect(launchUrl('https://d/k', { bridgeCode: '123456', pairCode: 'AB12CD34' })).toBe('https://d/k#pair=AB12CD34&bridge=123456');
    expect(launchUrl('https://d/k#old', {})).toBe('https://d/k');
    expect([0, 1, 2, 3, 9].map(relaunchDelayMs)).toEqual([3_000, 5_000, 10_000, 60_000, 60_000]);
  });

  it('opens once, reopens after it closes, stops after "יציאה ממצב קיוסק"', async () => {
    const opened: string[][] = [];
    let exit: (() => void) | null = null;
    let now = 0;
    const phases: string[] = [];
    const l = new BrowserLauncher({
      settings: () => ({ enabled: true, browser: 'auto', url: 'http://localhost:3002/k', role: 'kiosk' }),
      url: () => 'http://localhost:3002/k',
      bridgeCode: () => '111111',
      profileDir: mkdtempSync(path.join(os.tmpdir(), 'r2m-profile-')),
      env,
      exists: (p) => p.endsWith('msedge.exe'),
      open: (_exe, args, onExit) => {
        opened.push(args);
        exit = onExit;
      },
      close: async () => exit?.(),
      running: () => false,
      report: (p) => phases.push(p),
      now: () => now,
    });
    l.start(0);
    l.stop();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('--app=http://localhost:3002/k#bridge=111111');
    expect(l.tick()).toEqual({ ok: false }); // stopped
    // Closed by someone: opened again after the back-off.
    (l as unknown as { stopped: boolean }).stopped = false;
    now = 60_000;
    exit!();
    expect(l.tick().ok).toBe(false);
    now += 5_000;
    expect(l.tick().ok).toBe(true);
    expect(opened).toHaveLength(2);
    await l.exit();
    now += 120_000;
    l.tick();
    expect(opened).toHaveLength(2);
    expect(phases).toContain('paused');
    expect(l.openNow().ok).toBe(true);
    expect(opened).toHaveLength(3);
  });

  it('the installer’s name, a flag or kiosk.json pick the bridge; --app wins', () => {
    expect(shellModeOf({ argv: [], markerExists: false, config: null })).toBe('app');
    expect(shellModeOf({ argv: [], markerExists: true, config: null })).toBe('bridge');
    expect(shellModeOf({ argv: ['--bridge'], markerExists: false, config: null })).toBe('bridge');
    expect(shellModeOf({ argv: [], markerExists: false, config: { mode: 'bridge' } })).toBe('bridge');
    expect(shellModeOf({ argv: ['--app'], markerExists: true, config: { mode: 'bridge' } })).toBe('app');
  });
});

/* ------------------------------------------------------- the real server */

describe('the local API: origin, host, preflight', () => {
  it('answers the dashboard’s origin only; another site or no origin gets 403 and no CORS headers', async () => {
    const h = await harness();
    const good = await httpFetch(ORIGIN)(`${h.base}/health`, { method: 'GET', headers: {} });
    expect(good.status).toBe(200);
    expect(good.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(JSON.parse(await good.text())).toMatchObject({ bridge: 'r2m', api: 1, version: '0.3.0', paired: false, ready: { card: false, print: false, drawer: false } });
    for (const origin of ['https://evil.example', null]) {
      const bad = await httpFetch(origin)(`${h.base}/health`, { method: 'GET', headers: {} });
      expect(bad.status).toBe(403);
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    }
    // DNS rebinding: a page of another host that resolves to 127.0.0.1.
    const rebound = await httpFetch(ORIGIN, `evil.example:${h.port}`)(`${h.base}/health`, { method: 'GET', headers: {} });
    expect(rebound.status).toBe(403);
    const calls = h.runtime.recentCalls();
    expect(calls.filter((c) => c.status === 403)).toHaveLength(3);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/health' });
  });

  it('Chrome’s Private Network Access preflight: 204 with Access-Control-Allow-Private-Network', async () => {
    const h = await harness();
    const r = await httpFetch(ORIGIN)(`${h.base}/pay/start`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-r2m-sig', 'Access-Control-Request-Private-Network': 'true' },
    });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-private-network']).toBe('true');
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(String(r.headers['access-control-allow-headers'])).toContain('X-R2M-Sig');
    const evil = await httpFetch('https://evil.example')(`${h.base}/pay/start`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Private-Network': 'true' } });
    expect(evil.status).toBe(403);
    expect(evil.headers['access-control-allow-private-network']).toBeUndefined();
  });
});

describe('pairing and signed calls (the browser’s own client)', () => {
  it('pairs once with the code; a wrong code is counted; the code is used up', async () => {
    const h = await harness();
    const page = h.client();
    const wrong = await page.pair('000000', { url: null, device: {} });
    expect(wrong.ok).toBe(false);
    expect((wrong as { error: string }).error).toContain('נותרו 4');
    const c = code(h);
    expect(await page.pair(c, { url: `${ORIGIN}/k`, device: { browser: 'Chrome' } })).toEqual({ ok: true });
    expect(page.pairing).toMatchObject({ role: 'kiosk' });
    expect(page.pairing!.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The same code again (another page): refused — no code is shown while a page is paired.
    const other = await h.client().pair(c, { url: null, device: {} });
    expect(other.ok).toBe(false);
    const health = await page.health();
    expect(health).toMatchObject({ paired: true, pairingId: page.pairing!.pairingId, role: 'kiosk' });
    expect(h.runtime.view().pairing).toMatchObject({ paired: true, role: 'kiosk', origin: ORIGIN, url: `${ORIGIN}/k` });
    // "פתיחה בהפעלה" takes the page that paired.
    expect(h.runtime.launcherUrl()).toBe(`${ORIGIN}/k`);
  });

  it('every other call is signed: none, a stranger’s or a replayed one is 401; the paired page’s is answered', async () => {
    const h = await harness();
    const page = await paired(h);
    const unsigned = await httpFetch(ORIGIN)(`${h.base}/status`, { method: 'GET', headers: {} });
    expect(unsigned.status).toBe(401);
    expect(JSON.parse(await unsigned.text())).toMatchObject({ error: 'auth', why: 'missing' });
    const st = await page.request<BridgeStatus>('GET', '/status');
    expect(st.kind).toBe('ok');
    expect((st as { body: BridgeStatus }).body).toMatchObject({ api: 1, role: 'kiosk', link: null, ready: { card: false, print: true, drawer: false } });
    // A stranger with a made-up key.
    const stranger = h.client();
    stranger.pairing = { pairingId: 'abcdefghijklmnop', secret: page.pairing!.secret, role: 'kiosk', pairedAt: '', version: null };
    const r = await stranger.request('GET', '/status');
    expect(r).toMatchObject({ kind: 'refused', status: 401, error: 'auth' });
    expect(stranger.pairing).toBe(null); // the page forgets a pairing the bridge does not know
    // A replay of a captured request.
    let captured: { url: string; init: { method: string; headers: Record<string, string>; body?: string } } | null = null;
    const spy = new BridgeClient({
      fetchFn: (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
        captured = { url, init };
        return httpFetch(ORIGIN)(url, init);
      }) as unknown as BridgeFetch,
      store: memoryKv(),
      role: 'kiosk',
      base: h.base,
    });
    spy.pairing = page.pairing;
    expect((await spy.request('POST', '/flow', { flowState: 'attract', screen: 'attract', busy: false, idle: true })).kind).toBe('ok');
    const again = await httpFetch(ORIGIN)(captured!.url, captured!.init);
    expect(again.status).toBe(401);
    expect(JSON.parse(await again.text())).toMatchObject({ why: 'replay' });
    // Another body under the same signature.
    const tampered = await httpFetch(ORIGIN)(captured!.url, { ...captured!.init, body: '{"flowState":"x"}' });
    expect(JSON.parse(await tampered.text())).toMatchObject({ why: 'signature' });
  });

  it('a new pairing (another page) voids the old secret', async () => {
    const h = await harness();
    const first = await paired(h);
    h.runtime.newPairingCode();
    const second = await paired(h, 'kds');
    expect((await second.request('GET', '/status')).kind).toBe('ok');
    const old = await first.request('GET', '/status');
    expect(old).toMatchObject({ kind: 'refused', status: 401 });
    expect(first.paired).toBe(false);
  });
});

describe('what each role may ask', () => {
  it('a board asks nothing of the hardware; a KDS prints a bon but takes no card', async () => {
    const h = await harness();
    const board = await paired(h, 'order_status_board');
    expect(await board.request('POST', '/print', { test: true })).toMatchObject({ kind: 'refused', status: 403, error: 'capability' });
    expect(await board.request('POST', '/pay/start', { lines: [] })).toMatchObject({ kind: 'refused', status: 403 });
    expect((await board.request('GET', '/status')).kind).toBe('ok');

    h.runtime.newPairingCode();
    const kds = await paired(h, 'kds');
    expect(await kds.request('POST', '/pay/start', { lines: [] })).toMatchObject({ kind: 'refused', status: 403, error: 'capability' });
    expect(await kds.request('POST', '/drawer', {})).toMatchObject({ kind: 'refused', status: 403 });
    expect(await kds.request('POST', '/print', { kind: 'receipt', doc: { kind: 'receipt' } })).toMatchObject({ kind: 'refused', status: 400 });
    const bon = { kind: 'bon', pickupLabel: 'A-17', customerName: null, tableRef: null, documentNumber: '', service: 'take_away', createdAt: new Date().toISOString(), kioskName: 'KDS', posNumber: null, machineName: null, lines: [{ qty: 1, name: 'המבורגר', options: [], notes: null }], reprint: true, copy: 1, printerName: null };
    const r = await kds.request<{ ok: boolean; jobs: string[] }>('POST', '/print', { kind: 'bon', doc: bon, refId: 'order-1' });
    expect(r.kind).toBe('ok');
    await until(() => printed.length > 0);
    // ESC/POS: INIT, a raster band, the cut.
    expect(Array.from(printed[0].slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(printed[0].slice(2, 5))).toEqual([0x1d, 0x76, 0x30]);
  });

  it('the drawer only when set in the bridge', async () => {
    const h = await harness();
    const page = await paired(h);
    expect(await page.request('POST', '/drawer', {})).toMatchObject({ kind: 'refused', status: 409, error: 'drawer_off' });
    await h.runtime.windowAction({ type: 'setDrawer', on: true });
    expect((await page.request('POST', '/drawer', {})).kind).toBe('ok');
    expect(printed.some((b) => Buffer.from(b).equals(Buffer.from(DRAWER_KICK)))).toBe(true);
    expect((await page.health())?.ready.drawer).toBe(true);
  });
});

describe('a card payment through the bridge (the Windows kiosk’s ledger and card rules)', () => {
  async function linkedKiosk(parameters: Record<string, string> = {}) {
    const h = await harness(parameters);
    const page = await paired(h);
    const agent = new BridgeAgent(page, { machine: () => ({ serverUrl: 'http://cloud.test', machineId: MACHINE, accessToken: 'machine-token-123', machineName: 'קיוסק דפדפן' }), WebSocket: null });
    const s = await agent.refresh();
    expect(s).toMatchObject({ present: true, paired: true, status: { link: { machineId: MACHINE, role: 'kiosk' } } });
    expect(bridgeCardReady(agent.state, MACHINE)).toBe(true);
    expect(bridgeCardReason(agent.state, MACHINE)).toBe(null);
    // The cloud saw the browser's own machine token, never another identity.
    expect(h.cloud.sent.every((c) => c.auth === 'Bearer machine-token-123')).toBe(true);
    return { h, page, agent };
  }

  const basket = { lines: [{ key: 'l1', productId: 'p1', qty: 1, unitAgorot: 5400, options: [], notes: [] }], service: 'take_away' as const, customerName: 'דנה', customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null, expectedTotalAgorot: 5400 };

  async function pay(agent: BridgeAgent, until_: (p: BridgePayProgress) => boolean) {
    const r = await agent.startPayment(basket);
    expect(r.kind).toBe('ok');
    const out = (r as { body: { ok: boolean; orderId: string; amountAgorot: number } }).body;
    expect(out).toMatchObject({ ok: true, amountAgorot: 5400 });
    const seen: BridgePayProgress[] = [];
    await new Promise<void>((resolve) => {
      const stop = agent.followPayment(out.orderId, (p) => {
        seen.push(p);
        if (until_(p)) {
          stop();
          resolve();
        }
      });
    });
    return { orderId: out.orderId, seen };
  }

  it('approved: the pending document first, then the charge, the document completed with its number, the bon printed, the receipt on request', async () => {
    const { h, agent } = await linkedKiosk();
    const { orderId, seen } = await pay(agent, (p) => p.phase === 'approved');
    const last = seen[seen.length - 1];
    expect(last).toMatchObject({ phase: 'approved', amountAgorot: 5400, receipt: 'ask', pickupLabel: 'W-1' });
    expect(payFlowEvent(last)).toBe('paymentApproved');
    const svc = h.runtime.service!;
    const order = svc.orders.get(orderId)!;
    const doc = svc.ledger.doc(order.transactionId!)!;
    expect(doc).toMatchObject({ status: 'completed', documentType: 320, number: 1, prefix: '7' });
    expect(doc.card).toMatchObject({ last4: '4242', authNum: '0123456' });
    expect(h.pinpad.asked).toEqual(['sale']);
    // One paper (the owner, 08.10.2026): no separate number slip by default — the number is on the
    // receipt; no kitchen bon on the kiosk's own printer — "בון מטבח במדפסת הקיוסק" is off by default
    // (core/kioskBonRoute.ts; on, it prints as before: kioskPrinting.test.ts).
    expect(svc.printQueue.jobsFor(orderId, 'slip')).toHaveLength(0);
    expect(svc.printQueue.jobsFor(orderId, 'bon')).toHaveLength(0);
    expect(svc.orders.get(orderId)).toMatchObject({ bonStatus: 'none' });
    expect((await agent.receiptChoice(orderId, true)).kind).toBe('ok');
    expect(svc.printQueue.jobsFor(orderId, 'receipt')).toHaveLength(1);
    await until(() => printed.length >= 1);
    // The document reaches the cloud as this machine's (the bridge's sync).
    await svc.sync.flush();
    await until(() => h.cloud.sent.find((c) => c.path === `sync/${MACHINE}/transactions`));
    // The page's part of kiosk/sync: the shift, the card order of today.
    const st = await agent.refresh();
    expect(st.status?.statusPart).toMatchObject({ shiftOpen: true, ordersToday: 1, salesTodayAgorot: 5400 });
    expect(st.status?.shift).toMatchObject({ open: true });
  });

  it('declined: the document cancelled (its number kept), the card free for the next customer', async () => {
    const { h, agent } = await linkedKiosk();
    h.pinpad.script.sale = { answer: 'DECLINED', message: 'סירוב', raw: null, statusCode: 33 };
    const { orderId, seen } = await pay(agent, (p) => p.phase === 'declined');
    expect(seen[seen.length - 1]).toMatchObject({ phase: 'declined', message: 'סירוב' });
    const svc = h.runtime.service!;
    expect(svc.ledger.doc(svc.orders.get(orderId)!.transactionId!)).toMatchObject({ status: 'cancelled', number: 1 });
    expect((await agent.refresh()).ready.card).toBe(true);
  });

  it('unknown, the default: the reference asked, the document held, an alert for staff — the next customer pays by card', async () => {
    const { h, agent } = await linkedKiosk();
    h.pinpad.script.sale = { answer: 'UNKNOWN', message: 'timeout', raw: null };
    await pay(agent, (p) => p.phase === 'unknown');
    expect(h.pinpad.asked).toEqual(['sale', 'resolve']);
    const s = await agent.refresh();
    expect(s.status?.card?.unresolved).toHaveLength(1);
    // No global block (the owner: "אל תחסום בכללי"): card stays on, the alert is staff's.
    expect(s.ready.card).toBe(true);
    expect(bridgeCardReason(s, MACHINE)).toBe(null);
    h.pinpad.script.sale = { answer: 'APPROVED', raw: '', card: { brand: 'visa', last4: '4242', authNum: '0123457', uid: 'u-2', payments: null, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'y' } } };
    await pay(agent, (p) => p.phase === 'approved');
    // The first sale's card was never asked about on the way to the second charge.
    expect(h.pinpad.asked).toEqual(['sale', 'resolve', 'sale']);
    expect((await agent.refresh()).status?.card?.unresolved).toHaveLength(1);
  });

  it('unknown, with "חסימת אשראי כשיש תשלום לא מוכרע" on: every card blocked until staff settle it', async () => {
    const { h, agent } = await linkedKiosk({ cardLockOnUnresolved: 'true' });
    h.pinpad.script.sale = { answer: 'UNKNOWN', message: 'timeout', raw: null };
    const { seen } = await pay(agent, (p) => p.phase === 'unknown');
    expect(seen[seen.length - 1].phase).toBe('unknown');
    expect(h.pinpad.asked).toEqual(['sale', 'resolve']);
    const s = await agent.refresh();
    expect(s.ready.card).toBe(false);
    expect(bridgeCardReason(s, MACHINE)).toBe('תשלום קודם ממתין לבירור. אנא פנו לצוות.');
    expect(s.status?.card?.unresolved).toHaveLength(1);
    // A second customer is refused before anything reaches the terminal.
    const again = await agent.startPayment(basket);
    expect((again as { body: { ok: boolean; reason: string } }).body).toMatchObject({ ok: false, reason: 'unresolved' });
    expect(h.pinpad.asked.filter((a) => a === 'sale')).toHaveLength(1);
    // Staff ("בדוק שוב"): the terminal now knows it was approved.
    h.pinpad.script.resolve = { kind: 'approved', card: { brand: 'visa', last4: '4242', authNum: '1', uid: 'u', payments: null, firstPaymentAgorot: null, chargedAgorot: 5400, meta: {} } };
    const ref = s.status!.card!.unresolved[0].reference;
    // Never without a shop manager's PIN (the Windows kiosk's admin rule).
    expect(await agent.adminAction({ type: 'recheckPayment', reference: ref })).toMatchObject({ kind: 'ok', body: { ok: false, message: 'נדרש קוד מנהל' } });
    expect(await agent.adminUnlock('1111')).toMatchObject({ kind: 'ok', body: { ok: false } });
    const unlocked = await agent.adminUnlock('2468');
    expect(unlocked.kind === 'ok' ? unlocked.body : unlocked, JSON.stringify(h.runtime.service!.cloud.posUsers())).toMatchObject({ ok: true, name: 'דנה' });
    expect((await agent.adminAction({ type: 'recheckPayment', reference: ref })).kind).toBe('ok');
    expect((await agent.refresh()).ready.card).toBe(true);
  });

  it('the customer’s cancel while the card is out: an abort, the sale’s own answer awaited', async () => {
    const { h, agent } = await linkedKiosk();
    h.pinpad.script.delayMs = 400;
    h.pinpad.script.sale = { answer: 'DECLINED', message: 'בוטל', raw: null, statusCode: 126 };
    const started = agent.startPayment(basket);
    const r = await started;
    const orderId = (r as { body: { orderId: string } }).body.orderId;
    await until(async () => (await h.runtime.service!.currentPay())?.phase === 'charging');
    expect((await agent.cancelPayment()).kind).toBe('ok');
    const end = await until(() => (h.runtime.service!.currentPay()?.phase === 'declined' ? h.runtime.service!.currentPay() : null));
    expect(end.orderId).toBe(orderId);
    expect(h.pinpad.asked).toEqual(['sale', 'abort']);
  });

  it('a basket whose price moved is never charged: the new total back to the page', async () => {
    const { h, agent } = await linkedKiosk();
    const r = await agent.startPayment({ ...basket, expectedTotalAgorot: 5000 });
    expect((r as { body: unknown }).body).toMatchObject({ ok: false, reason: 'changed', totalAgorot: 5400 });
    expect(h.pinpad.asked).toEqual([]);
  });

  it('the kiosk’s machine is not switched while its documents wait for the cloud', async () => {
    const { h, page } = await linkedKiosk();
    h.cloud.state.down = true;
    await (async () => {
      const agent = new BridgeAgent(page, { WebSocket: null });
      await pay(agent, (p) => p.phase === 'approved');
    })();
    const svc = h.runtime.service!;
    svc.sync.stop();
    expect(svc.outbox.count()).toBeGreaterThan(0);
    const other = await page.request('POST', '/link', { serverUrl: 'http://cloud.test', machineId: '11111111-2222-4333-8444-555555555555', accessToken: 'other-token-123' });
    expect(other).toMatchObject({ kind: 'refused', status: 409 });
  });

  it('the event stream: a signed WebSocket from the dashboard’s origin gets the payment as it moves', async () => {
    const { h, page } = await linkedKiosk();
    const url = new URL((await page.eventsUrl())!);
    const frames: Array<{ type: string; progress?: BridgePayProgress }> = [];
    const sock = net.connect(h.port, '127.0.0.1');
    let buf: Buffer = Buffer.alloc(0);
    let upgraded = false;
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    sock.write(
      [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: 127.0.0.1:${h.port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', `Origin: ${ORIGIN}`, '', ''].join('\r\n'),
    );
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        expect(buf.subarray(0, end).toString()).toContain('101 Switching Protocols');
        expect(buf.subarray(0, end).toString()).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
        upgraded = true;
        buf = buf.subarray(end + 4);
      }
      const r = decodeFrames(buf);
      buf = r.rest;
      for (const f of r.frames) if (f.opcode === 1) frames.push(JSON.parse(f.payload.toString('utf8')));
    });
    await until(() => upgraded);
    const agent = new BridgeAgent(page, { WebSocket: null });
    await pay(agent, (p) => p.phase === 'approved');
    await until(() => frames.find((f) => f.type === 'pay' && f.progress?.phase === 'approved'));
    sock.destroy();
    // A replayed (or unsigned) upgrade is refused.
    const again = await httpFetch(ORIGIN)(`${h.base}${url.pathname}${url.search}`, { method: 'GET', headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } }).catch(() => ({ status: 0 }));
    expect([0, 401]).toContain(again.status);
  });

  it('"סגירה יחד עם ה-Z הסניפי" forwarded by the page: the shift closed once, never under a customer', async () => {
    const { h, agent } = await linkedKiosk();
    await pay(agent, (p) => p.phase === 'approved');
    agent.reportFlow({ flowState: 'ordering', screen: 'catalog', busy: false, idle: false });
    await until(async () => (h.runtime.service!.activity().screen === 'catalog' ? true : null));
    expect((await agent.closeRequest('8a2e0000-0000-4000-8000-000000000001')).kind).toBe('ok');
    expect((await agent.closeRequest('8a2e0000-0000-4000-8000-000000000001') as { body: { state: string } }).body.state).toBe('pending');
    agent.reportFlow({ flowState: 'attract', screen: 'attract', busy: false, idle: true });
    await until(async () => (h.runtime.service!.activity().idle ? true : null));
    const r = (await agent.closeRequest('8a2e0000-0000-4000-8000-000000000001')) as { body: { state: string; shiftId: string | null } };
    expect(r.body.state).toBe('done');
    expect(r.body.shiftId).toBeTruthy();
    expect(h.runtime.service!.ledger.currentShift()).toBe(null);
    // Asked again (the page's next sync): the same answer, nothing closed twice.
    expect(((await agent.closeRequest('8a2e0000-0000-4000-8000-000000000001')) as { body: { shiftId: string } }).body.shiftId).toBe(r.body.shiftId);
  });
});
