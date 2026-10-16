/**
 * "קיוסק ווינדוס אמור לעבוד גם ללא אינטרנט וגם ללא מסופון אם הוגדרו כך" (the owner, 16.10.2026) — the Windows kiosk
 * end to end, by the matrix:
 *
 *  1. no internet at boot: the kiosk opens on its menu from the disk (config, catalog, operator), sells by its terminal,
 *     and rests on "אין חיבור לאינטרנט" only with "חסימת הזמנות כשאין אינטרנט";
 *  2. the internet drops mid-order / at the payment: the card goes to the pinpad, the document is numbered here, the
 *     receipt prints, a shop-scope pickup number is the local one tagged L — nothing waits on the cloud;
 *  3. no card terminal: "ללא אשראי", a terminal configured but not answering, none at all — what stays, what rests;
 *  4. no internet and no terminal: the CashMag machine on the LAN, and "תשלום בקופה" handed to the shop's LAN host
 *     (its print server, as the Android kiosk does — core/lanOpenOrders.ts);
 *  5. the documents uploaded in order when the cloud is back — the same ids and numbers resent, never renumbered;
 *  6. back online: the outbox drains, the kiosk orders go up, an order a LAN till paid goes up paid.
 */

import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { payMethodAsk } from '@dash-lib/kioskConfig';
import { openOrderWire } from '@dash-lib/kioskWebOrders';
import { formatDocNumber } from '../src/core/documentNumbers';
import { lanStatesOf, lanTargetOf, nextLanRecord, withLanState } from '../src/core/lanOpenOrders';
import { offlineNoticeShown, offlineNoticeText } from '../src/core/offlineBlock';
import type { PrintDoc } from '../src/core/printDocs';
import type { PaymentProvider, SaleResult } from '../src/main/payment/provider';
import type { Transport } from '../src/main/printer/transports';
import { KioskService } from '../src/main/service';
import type { PayProgress, StartPaymentIn } from '../src/shared/bridge';
import { FakeCashMagServer, FN, payResult } from './support/cashmagFakeServer';

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const PRINT_KEY = 'test-shop-print-key-0123';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const GOLDEN = path.join(here, 'fixtures', 'contract');

/** A golden payload (test/fixtures/contract, the server's bytes too); written once or with UPDATE_GOLDEN=1. */
function golden(name: string, value: unknown) {
  const file = path.join(GOLDEN, `${name}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
  }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text));
}

const stoppers: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stoppers.splice(0).reverse()) await s();
});

const until = async <T>(fn: () => T | null | undefined | false, ms = 8_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/* ------------------------------------------------------------------ the cloud, switchable */

type Sent = { method: string; path: string; body: Record<string, unknown> | null };
type Answer = { status: number; body?: unknown } | 'offline';

/** The cloud: answers while `online`, else no network at all (fetch throws, as with the cable out). Every attempt recorded. */
function cloud() {
  const state = { online: false };
  const sent: Sent[] = [];
  const answers: Record<string, (b: Record<string, unknown> | null) => Answer> = {};
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/v1\//, '').replace(MACHINE, 'm');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, path: p, body });
    if (!state.online) throw new TypeError('fetch failed');
    const answer = answers[`${method} ${p}`]?.(body) ?? { status: 404, body: { detail: 'Not Found' } };
    if (answer === 'offline') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
  };
  return { state, sent, answers, fetchFn };
}

/* ------------------------------------------------------------------ the pinpad */

const APPROVED: SaleResult = { answer: 'APPROVED', raw: '', card: { brand: 'visa', last4: '4242', authNum: '0123456', uid: 'u-1', payments: null, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'x' } } };

/** A Nayax pinpad on the LAN: it reaches the acquirer itself (online, or its own deferred approval) — the cloud never matters. */
function pinpad() {
  let seq = 0;
  const script: { sale: SaleResult[]; check: boolean } = { sale: [], check: true };
  const sales: number[] = [];
  const provider: PaymentProvider = {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
    newReference: () => `ref${++seq}`,
    check: async () => ({ ok: script.check, detail: script.check ? null : 'connect ETIMEDOUT 10.0.0.5:8080' }),
    sale: async (req) => {
      sales.push(req.amountAgorot);
      return script.sale.shift() ?? APPROVED;
    },
    resolve: async () => ({ kind: 'unknown', message: 'no answer' }),
    abort: async () => undefined,
  };
  return { provider, script, sales };
}

/* ------------------------------------------------------------------ the kiosk */

interface KioskOpts {
  dataDir?: string;
  terminal?: ReturnType<typeof pinpad> | null;
  integration?: string | null;
  methods?: string[];
  general?: Record<string, unknown>;
  pickup?: Record<string, unknown>;
  params?: Record<string, unknown>;
  secretBox?: { seal(s: string): string; open(s: string): string };
  seed?: boolean;
}

function kiosk(c: ReturnType<typeof cloud>, o: KioskOpts = {}) {
  const printed: PrintDoc[] = [];
  const paper: number[] = [];
  const transport: Transport = {
    send: async (_t, bytes) => void paper.push(bytes.length),
    status: async () => ({ health: 'ok', detail: null }),
    list: async () => [],
    dispose: () => undefined,
  };
  const svc = new KioskService({
    dataDir: o.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'kd-offline-')),
    appVersion: '0.5.2',
    deviceInfo: { platform: 'windows' },
    transport,
    fetch: c.fetchFn,
    providers: o.terminal ? [() => o.terminal!.provider] : [],
    secretBox: o.secretBox,
    // A page is drawn (any pixels): the queue sends it to the printer — no Electron here.
    renderer: async (doc) => {
      printed.push(doc);
      return { width: 8, height: 1, rgba: new Uint8Array(32) };
    },
    downloader: async () => {
      throw new Error('no network');
    },
    platform: { networkUp: () => c.state.online },
  });
  stoppers.push(() => svc.stop());
  if (o.seed !== false) {
    svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
    svc.api.setBase('http://localhost:8001');
    svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4' });
    svc.cloud.applyCatalog({
      syncType: 'full',
      serverTime: 'x',
      machineCatalog: { mode: 'all' },
      categories: [{ id: 'c-main', name: 'עיקריות', isActive: true }],
      products: [
        { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, sku: '1001' },
        { id: 'p-cola', name: 'קולה', price: 10, categoryId: 'c-main', inStock: true, isAvailable: true, sku: '2001' },
      ],
      menu: null,
    });
    svc.cloud.setPromotions([], null);
    svc.cloud.setKioskSnapshot({
      kiosk: true,
      configVersion: 'v1',
      operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק Windows' },
      config: {
        general: { blockWhenOffline: false, ...(o.general ?? {}) },
        payment: { methods: o.methods ?? ['card'], receiptPolicy: 'always', tipEnabled: false },
        pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99, ...(o.pickup ?? {}) },
        printing: { pickupSlip: false },
      },
    });
    svc.cloud.setSettings({ settings: o.integration ? { paymentIntegration: o.integration } : {}, businessInfo: { companyName: 'רויאל בר', vatNumber: '515151515' }, settingsUpdatedAt: '2026-10-16T09:00:00Z', serverTime: null });
    svc.cloud.setParameters({ ...(o.params ?? {}) }, null);
    svc.applyProvider();
  }
  const progress: PayProgress[] = [];
  svc.on('pay', (p: PayProgress) => progress.push(p));
  const inner = svc as unknown as { offlineNow: boolean; viewDirty: boolean; tick5(): void; tick30(): Promise<void> };
  /** What the screens get now. */
  const fresh = () => {
    inner.viewDirty = true;
    return svc.view();
  };
  /** The kiosk counts itself offline (core/kioskHealth.ts OfflineTracker said so: the cloud silent past the grace). */
  const offline = (v: boolean) => {
    inner.offlineNow = v;
    inner.viewDirty = true;
  };
  return { svc, printed, paper, progress, fresh, offline, inner };
}

const basket = (over: Partial<StartPaymentIn> = {}): StartPaymentIn => ({
  lines: [{ key: 'L1', productId: 'p-burger', qty: 1, options: [], notes: [] }],
  service: 'take_away',
  customerName: null,
  customerPhone: null,
  tableRef: null,
  tipPct: null,
  tipAgorot: null,
  ...over,
});

const textOf = (d: PrintDoc) => JSON.stringify(d);

/** A card sale to its end: the order's id and the pay screen's last word. */
async function sell(k: ReturnType<typeof kiosk>, over: Partial<StartPaymentIn> = {}) {
  const r = await k.svc.startPayment(basket(over));
  expect(r.ok).toBe(true);
  const orderId = (r as { orderId: string }).orderId;
  const last = await until(() => k.progress.find((p) => p.orderId === orderId && (p.phase === 'approved' || p.phase === 'declined' || p.phase === 'unknown')));
  return { orderId, last };
}

/* ======================================================================= 1. boot */

describe('1. no internet at boot', () => {
  it('opens on the menu from the disk — config, catalog, operator — and sells by its terminal; no spinner, no "offline" rest', async () => {
    const c = cloud();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-offline-boot-'));
    // Yesterday, online: paired and synced (the copies on the disk).
    const before = kiosk(c, { dataDir: dir });
    const was = before.fresh();
    before.svc.stop();

    // This morning: no network at all, the PC just started.
    const terminal = pinpad();
    const k = kiosk(c, { dataDir: dir, terminal, seed: false });
    await k.svc.start();
    const v = k.fresh();
    expect(v.phase).toBe('kiosk');
    expect(v.config).not.toBeNull();
    expect(v.configVersion).toBe(was.configVersion);
    expect(v.catalog.products.map((p) => p.name)).toEqual(was.catalog.products.map((p) => p.name));
    expect(v.machine).toMatchObject({ machineId: MACHINE, posNumber: '4' });
    expect(k.svc.operator()).toEqual({ id: `kiosk:${MACHINE}`, name: 'קיוסק Windows' });
    expect(v.pay.usable).toEqual(['card']);
    expect(v.state.noPayment).toBe(false);
    // And it sells, with nothing from the cloud.
    k.offline(true);
    const { last } = await sell(k);
    expect(last.phase).toBe('approved');
    expect(terminal.sales).toEqual([4200]);
    expect(c.sent.some((s) => s.path === 'sync/m/kiosk/basket-check')).toBe(false);
  });

  it('counts itself offline after the grace (a cloud silent since yesterday, no network) — and rests only with "חסימת הזמנות כשאין אינטרנט"', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));
    const c = cloud();
    const k = kiosk(c, { terminal: pinpad(), general: { blockWhenOffline: false } });
    (k.svc.sync.status as { lastBeatOkAt: number | null }).lastBeatOkAt = Date.parse('2026-10-15T22:00:00Z');
    k.inner.tick5();
    expect(k.fresh().state.offline).toBe(false); // a blip never flashes: 25 s of grace
    vi.setSystemTime(new Date('2026-10-16T08:00:30Z'));
    k.inner.tick5();
    const v = k.fresh();
    expect(v.state.offline).toBe(true);
    expect(v.state.offlineSince).toBe(Date.parse('2026-10-16T08:00:00Z'));
    // The default: no internet never stops the kiosk (SPEC_KIOSK §17).
    expect(v.pay.usable).toEqual(['card']);
    expect(v.state.noPayment).toBe(false);

    const blocked = kiosk(c, { terminal: pinpad(), general: { blockWhenOffline: true } });
    blocked.offline(true);
    expect(blocked.fresh().pay.usable).toEqual([]);
    expect(blocked.fresh().state).toMatchObject({ noPayment: true, noPaymentReason: 'offline' });
  });
});

/* ======================================================================= 2. drops mid-order */

describe('2. the internet drops mid-order / at the payment', () => {
  it('the card goes to the pinpad; the document numbered here; the receipt printed; a shop pickup number is the local one tagged L, at once', async () => {
    const c = cloud();
    c.state.online = true;
    const k = kiosk(c, { terminal: pinpad(), pickup: { scope: 'shop', prefix: 'K' } });
    // Mid-order the cable goes; the kiosk notices (the grace over).
    c.state.online = false;
    k.offline(true);
    const t0 = Date.now();
    const { orderId, last } = await sell(k);
    expect(Date.now() - t0).toBeLessThan(2_000); // never the cloud's 3 s for the shop's number
    expect(last).toMatchObject({ phase: 'approved', pickupLabel: 'KL-1' });
    expect(c.sent.some((s) => s.path === 'sync/m/kiosk/pickup-number')).toBe(false);
    const order = k.svc.orders.get(orderId)!;
    const doc = k.svc.ledger.doc(order.transactionId!)!;
    expect(doc.status).toBe('completed');
    expect(last.documentNumber).toBe(formatDocNumber(doc.prefix, String(doc.number)));
    // The receipt: drawn and sent to the printer, offline.
    const receipt = await until(() => k.printed.find((d) => d.kind === 'receipt'));
    expect(textOf(receipt)).toContain(last.documentNumber!);
    await until(() => k.paper.length > 0);
    // Waiting for the cloud: the shift's open and the document.
    expect(k.svc.outbox.all().map((r) => r.kind).sort()).toEqual(['shift_open', 'transaction']);
    expect(k.fresh().staff.pendingUploads).toBeGreaterThanOrEqual(2);
  });

  it('a kiosk-scope number is the kiosk’s own sequence as always (no tag)', async () => {
    const c = cloud();
    const k = kiosk(c, { terminal: pinpad() });
    k.offline(true);
    expect((await sell(k)).last.pickupLabel).toBe('K-1');
    expect((await sell(k)).last.pickupLabel).toBe('K-2');
  });
});

/* ======================================================================= 3. no terminal */

describe('3. no card terminal', () => {
  it('"ללא אשראי": no card tile; "תשלום בקופה" and the cash device take the order; card alone — the "no payment" rest, never a dead end', () => {
    const c = cloud();
    const none = kiosk(c, { integration: 'none', methods: ['card', 'cash_at_till'] }).fresh();
    expect(none.pay.methods).toEqual(['cash_at_till']);
    expect(none.pay.usable).toEqual(['cash_at_till']);
    expect(none.pay.cardOff).toBe('הקיוסק מוגדר ללא אשראי');
    expect(none.state.noPayment).toBe(false);
    // Card only and "ללא אשראי": "קיוסק — כשאין מסופון אשראי" (`pay_at_till`, the default) offers the till — the kiosk sells.
    const cardOnly = kiosk(c, { integration: 'none', methods: ['card'] }).fresh();
    expect(cardOnly.pay).toMatchObject({ methods: ['cash_at_till'], usable: ['cash_at_till'], tillFallback: true });
    expect(payMethodAsk(cardOnly.pay.methods, cardOnly.pay.usable, 'off').fallback).toBe('cash_at_till');
    // `block`: nothing to take — the screens rest on "התשלום אינו זמין כרגע" (KioskApp: payAsk.fallback null).
    const blocked = kiosk(c, { integration: 'none', methods: ['card'], params: { kioskNoTerminalFallback: 'block' } }).fresh();
    expect(blocked.pay.usable).toEqual([]);
  });

  it('none set up at all: the card shown off with why; the till takes it; card alone rests on "no payment" (terminal)', () => {
    const c = cloud();
    const v = kiosk(c, { methods: ['card', 'cash_at_till'] }).fresh();
    expect(v.pay.methods).toEqual(['card', 'cash_at_till']);
    expect(v.pay.usable).toEqual(['cash_at_till']);
    expect(v.pay.cardOff).toBe('לא הוגדר מסופון אשראי לקיוסק');
    // The screens sell by what is usable (KioskApp: kioskPayChooser's fallback) — the till here; the staff's pill says
    // "המסופון לא זמין" (state.noPayment, the terminal's fault — not the "no payment" rest).
    expect(payMethodAsk(v.pay.methods, v.pay.usable, 'required').fallback).toBe('cash_at_till');
    expect(v.state.noPaymentReason).toBe('terminal');
    // Card alone, none set up: the till offered for it (`pay_at_till`, the default) — the card's tile says so, the staff's
    // pill still says the terminal is missing.
    const fallback = kiosk(c, { methods: ['card'] }).fresh();
    expect(fallback.pay).toMatchObject({ methods: ['card', 'cash_at_till'], usable: ['cash_at_till'], cardOff: 'האשראי לא זמין כרגע — אפשר לשלם בקופה', tillFallback: true });
    expect(payMethodAsk(fallback.pay.methods, fallback.pay.usable, 'off')).toEqual({ asks: true, optional: false, fallback: 'cash_at_till' });
    expect(fallback.state).toMatchObject({ noPayment: true, noPaymentReason: 'terminal' });
    // `block`: as before — the "no payment" rest.
    const alone = kiosk(c, { methods: ['card'], params: { kioskNoTerminalFallback: 'block' } }).fresh();
    expect(alone.pay.usable).toEqual([]);
    expect(payMethodAsk(alone.pay.methods, alone.pay.usable, 'required').fallback).toBeNull();
    expect(alone.state).toMatchObject({ noPayment: true, noPaymentReason: 'terminal' });
  });

  it('configured but not answering: tried on the press (the owner, 08.10) — a clear refusal, the number kept, back to choose the till', async () => {
    const c = cloud();
    const terminal = pinpad();
    terminal.script.check = false;
    const k = kiosk(c, { terminal, methods: ['card', 'cash_at_till'] });
    k.offline(true);
    await k.svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    await k.svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    const v = k.fresh();
    expect(v.state.terminal).toBe('unreachable');
    // Not blocked in advance: the tile stays, the till too.
    expect(v.pay.usable).toEqual(['card', 'cash_at_till']);
    terminal.script.sale.push({ answer: 'NOT_SENT', message: 'connect ETIMEDOUT 10.0.0.5:8080' });
    const { orderId, last } = await sell(k);
    expect(last).toMatchObject({ phase: 'declined', message: 'connect ETIMEDOUT 10.0.0.5:8080' });
    // Nothing charged, nothing pending: the document cancelled with its number (uploaded as such), never a hole.
    const doc = k.svc.ledger.doc(k.svc.orders.get(orderId)!.transactionId!)!;
    expect(doc.status).toBe('cancelled');
    expect(k.svc.pay.blocked()).toBe(false);
  });
});

/* ======================================================================= 4. no internet + no terminal */

/** The shop's print server on the LAN as the Android till runs it (KitchenLan.kt + KioskLanOpenOrders): the bearer, the board. */
async function lanHost() {
  const board = new Map<string, Record<string, unknown>>();
  const got: Array<{ auth: string | undefined; length: string | undefined; chunked: boolean; body: Record<string, unknown> }> = [];
  let down = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (b: Buffer) => chunks.push(b));
    req.on('end', () => {
      if (down) {
        req.socket.destroy();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      got.push({ auth: req.headers.authorization, length: req.headers['content-length'], chunked: req.headers['transfer-encoding'] === 'chunked', body });
      const reply = (status: number, b: unknown) => {
        const text = JSON.stringify(b);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (req.headers.authorization !== `Bearer ${PRINT_KEY}`) return reply(401, { detail: 'unauthorized' });
      if (req.method !== 'POST' || req.url !== '/kiosk/open-orders') return reply(404, { detail: 'not found' });
      const states: Record<string, unknown> = {};
      for (const o of (body.orders ?? []) as Array<Record<string, unknown>>) {
        const id = String(o.localId);
        if (!board.has(id)) board.set(id, { state: 'open', paidBy: null, transactionId: null, transactionNumber: null, paidAt: null, closeReason: null, order: o });
        const { order: _o, ...s } = board.get(id)!;
        states[id] = s;
      }
      reply(200, { ok: true, states });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  stoppers.push(() => new Promise<void>((r) => server.close(() => r())));
  return {
    port: (server.address() as AddressInfo).port,
    board,
    got,
    setDown: (v: boolean) => {
      down = v;
    },
    /** The host's till takes the money for it (its own document). */
    pay: (id: string) => Object.assign(board.get(id)!, { state: 'paid', paidBy: 'דנה (קופה 1)', transactionId: 'tx-host-9', transactionNumber: '30000012', paidAt: '2026-10-16T09:30:00.000Z' }),
  };
}

/** The cloud's printers answer for this kiosk: the shop's print server and the secret (`GET /sync/{m}/printers`). */
const printersAnswer = (port: number, more: Record<string, unknown> = {}) => ({
  status: 200,
  body: { syncType: 'full', etag: 'e1', machineId: MACHINE, printers: [], printHost: { machineId: 'host-1', name: '1 · קופה ראשית', isSelf: false, lanAddress: '127.0.0.1', port, ...more }, printSecret: PRINT_KEY },
});

const openOrderBody = (b: Record<string, unknown> | null) => ({ status: 200, body: { accepted: ((b?.orders ?? []) as Array<{ localId: string }>).map((o) => o.localId), rejected: [], states: {} } });

describe('4. no internet and no terminal', () => {
  it('"תשלום בקופה" goes to the shop’s LAN host (its print server): listed at its till at once; the customer not told "waiting to sync"', async () => {
    const host = await lanHost();
    const c = cloud();
    c.state.online = true;
    c.answers['GET sync/m/printers'] = () => printersAnswer(host.port);
    const k = kiosk(c, { integration: 'none', methods: ['card', 'cash_at_till'], pickup: { scope: 'shop', prefix: 'K' } });
    // Online, the kiosk learnt where the host is (every 5 minutes after a good beat).
    await k.svc.pullLanHost(true);
    expect(k.svc.lanTarget()).toMatchObject({ address: '127.0.0.1', port: host.port, secret: PRINT_KEY, name: '1 · קופה ראשית' });

    // The internet goes; no terminal at all ("ללא אשראי").
    c.state.online = false;
    k.offline(true);
    const v = k.fresh();
    expect(v.pay.usable).toEqual(['cash_at_till']);
    const sentBefore = c.sent.length;
    const r = await k.svc.placeOpenOrder({ ...basket(), customerName: 'דנה', expectedTotalAgorot: 4200, vouchers: [] });
    expect(r).toMatchObject({ ok: true, pickupLabel: 'KL-1', pending: false, dueAgorot: 4200 });
    // Nothing waited on the cloud (not even tried: it is known to be away).
    expect(c.sent.slice(sentBefore).map((s) => s.path)).toEqual([]);
    // The host has it — the cloud's shape, the basket's codec for the till, when it was taken; the shop's secret, a length.
    expect(host.got).toHaveLength(1);
    expect(host.got[0]).toMatchObject({ auth: `Bearer ${PRINT_KEY}`, chunked: false });
    expect(Number(host.got[0].length)).toBeGreaterThan(0);
    expect(host.got[0].body).toMatchObject({ kioskMachineId: MACHINE, kioskName: 'קיוסק Windows' });
    const o = (host.got[0].body.orders as Array<Record<string, unknown>>)[0];
    expect(o).toMatchObject({ localId: (r as { localId: string }).localId, pickupLabel: 'KL-1', customerName: 'דנה', totalAgorot: 4200, dueAgorot: 4200, state: 'open' });
    expect(typeof o.createdAtMs).toBe('number');
    expect(typeof (o.cart as { codec: unknown }).codec).toBe('string');
    expect(k.svc.payAtTill.pending()).toBe(1); // still owed to the cloud
    // A till can find it: no "waiting to sync" paper (the pickup slip is off here, as by default).
    await new Promise((r) => setTimeout(r, 100));
    expect(k.printed).toEqual([]);
  });

  it('the host down at the order: "waiting to sync" — handed over by the 30 s tick once it answers; an independent kiosk (no LAN address) never tries', async () => {
    const host = await lanHost();
    const c = cloud();
    c.state.online = true;
    c.answers['GET sync/m/printers'] = () => printersAnswer(host.port);
    const k = kiosk(c, { methods: ['cash_at_till'] });
    await k.svc.pullLanHost(true);
    c.state.online = false;
    k.offline(true);
    host.setDown(true);
    const r = await k.svc.placeOpenOrder({ ...basket(), expectedTotalAgorot: 4200, vouchers: [] });
    expect(r).toMatchObject({ ok: true, pending: true });
    // No till can see it yet: the customer takes it on paper — the number, what to pay, the items, the QR, "ממתינה לסנכרון".
    const slip = textOf(await until(() => k.printed.find((d) => d.kind === 'receipt')));
    for (const s of ['לתשלום בקופה', 'K-1', '1 × המבורגר', `KO:${(r as { localId: string }).localId}`, 'הזמנה ממתינה לסנכרון', 'ההזמנה תוכן לאחר התשלום']) expect(slip).toContain(s);
    host.setDown(false);
    await k.inner.tick30();
    expect(host.board.has((r as { localId: string }).localId)).toBe(true);
    expect(k.svc.payAtTill.lanDelivered((r as { localId: string }).localId)).toBe(true);

    // "קופה עצמאית" kiosk: the cloud gives its print server no LAN address — nothing kept, nothing tried.
    const c2 = cloud();
    c2.state.online = true;
    c2.answers['GET sync/m/printers'] = () => printersAnswer(host.port, { lanAddress: null });
    const away = kiosk(c2, { methods: ['cash_at_till'] });
    await away.svc.pullLanHost(true);
    expect(away.svc.lanTarget()).toBeNull();
    c2.state.online = false;
    away.offline(true);
    const before = host.got.length;
    expect(await away.svc.placeOpenOrder({ ...basket(), expectedTotalAgorot: 4200, vouchers: [] })).toMatchObject({ ok: true, pending: true });
    expect(host.got.length).toBe(before);
  });

  it('the shop’s secret is sealed on the disk (DPAPI on Windows), never kept plain', async () => {
    const host = await lanHost();
    const c = cloud();
    c.state.online = true;
    c.answers['GET sync/m/printers'] = () => printersAnswer(host.port);
    const box = { seal: (s: string) => `sealed:${Buffer.from(s).toString('base64')}`, open: (s: string) => Buffer.from(s.slice(7), 'base64').toString() };
    const k = kiosk(c, { methods: ['cash_at_till'], secretBox: box });
    await k.svc.pullLanHost(true);
    expect(JSON.stringify(k.svc.kv.getJson('lan.host'))).not.toContain(PRINT_KEY);
    expect(k.svc.lanTarget()?.secret).toBe(PRINT_KEY);
    // Unchanged in the cloud (ETag): the kept one stands.
    c.answers['GET sync/m/printers'] = () => ({ status: 200, body: { syncType: 'unchanged', etag: 'e1' } });
    await k.svc.pullLanHost(true);
    expect(c.sent.filter((s) => s.path === 'sync/m/printers')).toHaveLength(2);
    expect(k.svc.lanTarget()?.secret).toBe(PRINT_KEY);
  });

  it('a kiosk that does not offer the till (`kioskNoTerminalFallback` = block) never asks the cloud for the LAN host', async () => {
    const c = cloud();
    c.state.online = true;
    const k = kiosk(c, { terminal: pinpad(), methods: ['card'], params: { kioskNoTerminalFallback: 'block' } });
    await k.svc.pullLanHost(true);
    expect(c.sent.some((s) => s.path === 'sync/m/printers')).toBe(false);
    // `pay_at_till` (the default): the till may be offered when the terminal goes — the host is known before the cloud goes.
    const card = kiosk(c, { terminal: pinpad(), methods: ['card'] });
    await card.svc.pullLanHost(true);
    expect(c.sent.some((s) => s.path === 'sync/m/printers')).toBe(true);
  });

  it('CashMag on the LAN, "ללא אשראי", offline with the block on: the cash device stays and the sale is written here', async () => {
    const s = new FakeCashMagServer({ handlers: { [FN.pay]: (call, conn) => conn.result(call.jobId, call.fn, 0, payResult({ balance: '0', deposits: [['20', 1], ['20', 1], ['2', 1]] })) } });
    await s.listen();
    stoppers.push(() => s.close());
    const c = cloud();
    const k = kiosk(c, {
      integration: 'none',
      methods: ['card', 'cash_device'],
      general: { blockWhenOffline: true },
      params: { cashmagEnabled: true, cashmagHost: '127.0.0.1', cashmagPort: s.port },
    });
    await k.svc.cashMag.probe();
    k.offline(true);
    const v = k.fresh();
    expect(v.pay.methods).toEqual(['cash_device']);
    expect(v.pay.usable).toEqual(['cash_device']);
    expect(v.state.noPayment).toBe(false);
    const r = await k.svc.startPayment(basket({ method: 'cash_device' }));
    expect(r.ok).toBe(true);
    const done = await until(() => k.progress.find((p) => p.phase === 'approved'));
    expect(done.pickupLabel).toBe('K-1');
    const doc = k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!;
    expect(doc.status).toBe('completed');
    expect(doc.cash).toMatchObject({ hostId: 'cashmag', receivedAgorot: 4200 });
    expect(k.svc.outbox.count('transaction')).toBe(1);
  });
});

/* ======================================================================= 5 + 6. back online */

describe('5–6. the cloud back: numbering, uploads, recovery', () => {
  it('three sales offline (one declined): numbers strictly sequential; uploaded in order once the cloud answers — resent as is after a lost answer, never twice in the books', async () => {
    const c = cloud();
    const terminal = pinpad();
    const k = kiosk(c, { terminal });
    k.offline(true);
    terminal.script.sale.push(APPROVED, { answer: 'DECLINED', message: 'כרטיס נדחה', raw: null, statusCode: 3 }, APPROVED);
    const a = await sell(k);
    const b = await sell(k);
    const d = await sell(k);
    expect([a.last.phase, b.last.phase, d.last.phase]).toEqual(['approved', 'declined', 'approved']);
    const docs = [a, b, d].map((x) => k.svc.ledger.doc(k.svc.orders.get(x.orderId)!.transactionId!)!);
    expect(docs.map((x) => x.number)).toEqual([1, 2, 3]);
    expect(docs.map((x) => x.status)).toEqual(['completed', 'cancelled', 'completed']);
    // Paid offline: the success screens said K-1 and K-2 (a declined order draws no number).
    expect([a.last.pickupLabel, d.last.pickupLabel]).toEqual(['K-1', 'K-2']);

    // The cloud is back. The first answer is lost on the way (the cloud wrote them): the same ids and numbers again.
    const books = new Map<string, string>();
    let lose = true;
    c.answers['POST sync/m/shifts'] = () => ({ status: 200, body: {} });
    c.answers['POST sync/m/transactions'] = (body) => {
      const txs = (body?.transactions ?? []) as Array<{ id: string; transactionNumber: string }>;
      const results = txs.map((t) => ({ id: t.id, status: books.has(t.id) ? 'duplicate' : 'accepted' }));
      for (const t of txs) if (!books.has(t.id)) books.set(t.id, t.transactionNumber);
      if (lose) {
        lose = false;
        return 'offline';
      }
      return { status: 200, body: { results } };
    };
    c.answers['POST sync/m/kiosk/orders'] = (body) => ({ status: 200, body: { accepted: ((body?.orders ?? []) as Array<{ localId: string }>).map((o) => o.localId) } });
    c.answers['POST machines/me/heartbeat'] = () => ({ status: 200, body: { zMode: 'cloud' } });
    c.state.online = true;
    // The first good beat clears "אין אינטרנט" at once (no grace on the way back).
    expect(await k.svc.sync.heartbeat()).toBe(true);
    k.inner.tick5();
    expect(k.fresh().state).toMatchObject({ offline: false, offlineSince: null });
    await k.svc.sync.flush();
    expect(k.svc.outbox.count('transaction')).toBe(3); // the answer was lost: still owed
    await k.svc.sync.flush();
    expect(k.svc.outbox.count()).toBe(0);
    const posts = c.sent.filter((s) => s.path === 'sync/m/transactions').map((s) => (s.body!.transactions as Array<{ id: string; transactionNumber: string; status: string }>));
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]); // resent as is: never renumbered
    expect(posts[1].map((t) => [t.transactionNumber, t.status])).toEqual([
      ['1', 'completed'],
      ['2', 'cancelled'],
      ['3', 'completed'],
    ]);
    expect([...books.values()]).toEqual(['1', '2', '3']);
    // The shift's open went first, once.
    const order = c.sent.filter((s) => s.path === 'sync/m/shifts' || s.path === 'sync/m/transactions').map((s) => s.path);
    expect(order[0]).toBe('sync/m/shifts');
    // A third flush sends nothing.
    await k.svc.sync.flush();
    expect(c.sent.filter((s) => s.path === 'sync/m/transactions')).toHaveLength(2);
    // The kiosk orders (the dashboard's list) follow.
    expect(await k.svc.orders.push(k.svc.api, MACHINE)).toBe(true);
    expect(k.svc.orders.all().filter((o) => o.paid && o.syncedHash === null)).toHaveLength(0);
    // Recovery seen by the staff and the cloud: nothing pending, online.
    expect(k.fresh().state.offline).toBe(false);
    expect(k.fresh().staff.pendingUploads).toBe(0);
  });

  it('"תשלום בקופה" handed over the LAN and paid at the host’s till: asked again offline, then uploaded paid — never listed open in the cloud', async () => {
    const host = await lanHost();
    const c = cloud();
    c.state.online = true;
    c.answers['GET sync/m/printers'] = () => printersAnswer(host.port);
    const k = kiosk(c, { methods: ['cash_at_till'] });
    await k.svc.pullLanHost(true);
    c.state.online = false;
    k.offline(true);
    const r = (await k.svc.placeOpenOrder({ ...basket(), expectedTotalAgorot: 4200, vouchers: [] })) as { ok: true; localId: string };
    // The host's till takes the money; the kiosk learns it on its next offline round.
    host.pay(r.localId);
    await k.inner.tick30();
    expect(k.svc.payAtTill.lanRecord(r.localId)).toMatchObject({ state: 'paid', paidBy: 'דנה (קופה 1)', transactionNumber: '30000012' });
    // Back online: the order goes up as that till left it.
    c.answers['POST sync/m/kiosk/open-orders'] = openOrderBody;
    c.state.online = true;
    k.offline(false);
    await k.svc.payAtTill.flush();
    const up = c.sent.filter((s) => s.path === 'sync/m/kiosk/open-orders').pop()!;
    expect((up.body!.orders as Array<Record<string, unknown>>)[0]).toMatchObject({
      localId: r.localId,
      state: 'paid',
      paidByName: 'דנה (קופה 1)',
      paidTransactionId: 'tx-host-9',
      paidTransactionNumber: '30000012',
      paidAt: '2026-10-16T09:30:00.000Z',
    });
    expect(k.svc.payAtTill.pending()).toBe(0);
    // The golden payload (stable id and times) — the same bytes in server/tests/fixtures/kiosk_desktop, validated there
    // by the server's KioskOpenOrderIn (tests/test_kiosk_desktop_contract.py).
    const order = k.svc.payAtTill.order(r.localId)!;
    const stable = { ...order, localId: 'open-order-lan-1', createdAtMs: Date.parse('2026-10-16T09:25:00Z'), businessDate: '2026-10-16' };
    golden('open_order_lan_paid', withLanState(openOrderWire(stable), k.svc.payAtTill.lanRecord(r.localId)));
  });

  it('still open at the host when the cloud is back: its state asked first, then uploaded open (the cloud lists it to every till)', async () => {
    const host = await lanHost();
    const c = cloud();
    c.state.online = true;
    c.answers['GET sync/m/printers'] = () => printersAnswer(host.port);
    const k = kiosk(c, { methods: ['cash_at_till'] });
    await k.svc.pullLanHost(true);
    c.state.online = false;
    k.offline(true);
    const r = (await k.svc.placeOpenOrder({ ...basket(), expectedTotalAgorot: 4200, vouchers: [] })) as { ok: true; localId: string };
    const handed = host.got.length;
    c.answers['POST sync/m/kiosk/open-orders'] = openOrderBody;
    c.state.online = true;
    k.offline(false);
    await k.svc.payAtTill.flush();
    expect(host.got.length).toBe(handed + 1); // asked the host first
    const up = c.sent.filter((s) => s.path === 'sync/m/kiosk/open-orders').pop()!;
    expect((up.body!.orders as Array<Record<string, unknown>>)[0]).toMatchObject({ localId: r.localId, state: 'open' });
    expect((up.body!.orders as Array<Record<string, unknown>>)[0]).not.toHaveProperty('paidByName');
  });
});

/* ======================================================================= the rules */

describe('the rules', () => {
  it('the LAN host from the cloud: the print server with an address and the secret — never this device, never off the LAN', () => {
    const body = (h: Record<string, unknown> | null, secret: unknown = 's') => ({ printHost: h, printSecret: secret });
    expect(lanTargetOf(body({ machineId: 'h', name: 'בר', isSelf: false, lanAddress: '192.168.0.20', port: 8399 }))).toEqual({ address: '192.168.0.20', port: 8399, secret: 's', machineId: 'h', name: 'בר' });
    expect(lanTargetOf(body({ isSelf: false, lanAddress: '192.168.0.20' }))?.port).toBe(8399);
    expect(lanTargetOf(body({ isSelf: true, lanAddress: '192.168.0.20' }))).toBeNull();
    expect(lanTargetOf(body({ isSelf: false, lanAddress: null }))).toBeNull();
    expect(lanTargetOf(body({ isSelf: false, lanAddress: '10.0.0.1', offLan: true }))).toBeNull();
    expect(lanTargetOf(body({ isSelf: false, lanAddress: '10.0.0.1' }, null))).toBeNull();
    expect(lanTargetOf(body(null))).toBeNull();
    expect(lanTargetOf(null)).toBeNull();
  });

  it('the host’s word: paid / cancelled kept for good, anything else open; to the cloud only within the schema', () => {
    const states = lanStatesOf({ ok: true, states: { a: { state: 'paid', paidBy: 'x', transactionId: 't', transactionNumber: '9', paidAt: 'not a time', closeReason: null }, b: { state: 'expired' } } });
    expect(states.get('a')!.state).toBe('paid');
    expect(states.get('b')!.state).toBe('open');
    const paid = nextLanRecord(null, states.get('a')!, 5);
    expect(nextLanRecord(paid, states.get('b')!, 9)).toEqual(paid);
    const wire = withLanState({ localId: 'a', state: 'open' }, { ...paid, paidBy: 'x'.repeat(300) });
    expect(wire).toMatchObject({ state: 'paid', paidTransactionId: 't', paidTransactionNumber: '9', paidAt: null });
    expect((wire.paidByName as string).length).toBe(200);
    expect(withLanState({ localId: 'b', state: 'open' }, nextLanRecord(null, states.get('b')!, 1))).toEqual({ localId: 'b', state: 'open' });
  });

  it('"הודעה ללקוח כשאין אינטרנט": offline and still selling, on the ordering screens only — never on a rest screen or over the payment', () => {
    const on = { enabled: true, offline: true, sells: true };
    expect(offlineNoticeShown({ ...on, screen: 'attract' })).toBe(true);
    expect(offlineNoticeShown({ ...on, screen: 'catalog' })).toBe(true);
    expect(offlineNoticeShown({ ...on, screen: 'pay' })).toBe(false);
    expect(offlineNoticeShown({ ...on, screen: 'no_payment' })).toBe(false);
    expect(offlineNoticeShown({ ...on, sells: false, screen: 'attract' })).toBe(false);
    expect(offlineNoticeShown({ ...on, enabled: false, screen: 'attract' })).toBe(false);
    expect(offlineNoticeShown({ ...on, offline: false, screen: 'attract' })).toBe(false);
    expect(offlineNoticeText(true)).toBe('אין כרגע חיבור לאינטרנט. ההזמנה והתשלום במסופון ממשיכים כרגיל.');
    expect(offlineNoticeText(false)).not.toContain('מסופון');
  });
});

/* ======================================================================= 7. "גם אם אין מסופון שיעלה" */

/**
 * "קיוסק — כשאין מסופון אשראי" (`kioskNoTerminalFallback`, core/noTerminalFallback.ts; the owner, 16.10.2026): a card-only
 * kiosk with no terminal (none set up, or one that does not answer) comes up on its menu and takes the order to the till —
 * the cloud, the shop's LAN host offline, else the "לתשלום בקופה" slip — never a tax document here. `block`: as before.
 */
describe('7. no terminal: "תשלום בקופה" instead (kioskNoTerminalFallback)', () => {
  const FALLBACK_TEXT = 'האשראי לא זמין כרגע — אפשר לשלם בקופה';
  /**
   * The terminal's alert in the kiosk's status (`status.alerts`): kept while the till is offered instead — the cloud makes it
   * the exception "תקלת מסוף אשראי בקיוסק" (`kiosk_terminal`, the managers' push) — and gone once the card works again.
   */
  const terminalAlerts = (k: ReturnType<typeof kiosk>) =>
    ((k.svc as unknown as { kioskStatus(): { alerts: Array<Record<string, unknown>> } }).kioskStatus().alerts ?? []).filter((a) => a.kind === 'terminal');
  const PINPAD = { address: 'https://10.0.0.5:8080/SPICy' };
  /** Where KioskApp rests with this view: it sells while "איך תרצו לשלם?" has a way to pay (kioskPayChooser's fallback). */
  const sells = (v: { pay: { methods: Parameters<typeof payMethodAsk>[0]; usable: Parameters<typeof payMethodAsk>[1] } }) => payMethodAsk(v.pay.methods, v.pay.usable, 'off').fallback !== null;

  it('none set up, card only: the menu opens, the card tile says why, "תשלום בקופה" takes it — no document on the kiosk', async () => {
    const c = cloud();
    c.state.online = true;
    c.answers['POST sync/m/kiosk/open-orders'] = openOrderBody;
    const k = kiosk(c, { methods: ['card'] });
    const v = k.fresh();
    expect(v.pay).toMatchObject({ methods: ['card', 'cash_at_till'], usable: ['cash_at_till'], cardOff: FALLBACK_TEXT, tillFallback: true });
    expect(sells(v)).toBe(true);
    // Still told: "המסופון לא מוגדר" in the status (the cloud's `kiosk_terminal`, pushed to the managers).
    expect(terminalAlerts(k)).toEqual([{ kind: 'terminal', key: 'terminal', reason: 'not_configured' }]);
    // "איך תרצו לשלם?" is asked (a card-only kiosk's step is off: with the card off, the till must be chosen).
    expect(payMethodAsk(v.pay.methods, v.pay.usable, 'off')).toEqual({ asks: true, optional: false, fallback: 'cash_at_till' });
    // The card is still refused before anything is written.
    expect(await k.svc.startPayment(basket())).toMatchObject({ ok: false, reason: 'terminal' });
    const r = await k.svc.placeOpenOrder({ ...basket(), expectedTotalAgorot: 4200, vouchers: [] });
    expect(r).toMatchObject({ ok: true, pickupLabel: 'K-1', pending: false, dueAgorot: 4200 });
    expect(c.sent.some((s) => s.method === 'POST' && s.path === 'sync/m/kiosk/open-orders')).toBe(true);
    // Fiscal: the till that takes the money writes the document — none here, nothing to upload as a sale.
    expect(k.svc.outbox.count('transaction')).toBe(0);
  });

  it('`block`: today\'s rest on "התשלום אינו זמין כרגע", the order to the till refused', async () => {
    const c = cloud();
    const k = kiosk(c, { methods: ['card'], params: { kioskNoTerminalFallback: 'block' } });
    const v = k.fresh();
    expect(v.pay).toEqual({ methods: ['card'], usable: [], cardOff: 'לא הוגדר מסופון אשראי לקיוסק', cashOff: null });
    expect(sells(v)).toBe(false);
    expect(v.state).toMatchObject({ noPayment: true, noPaymentReason: 'terminal' });
    expect(await k.svc.placeOpenOrder({ ...basket(), expectedTotalAgorot: 4200, vouchers: [] })).toMatchObject({ ok: false, reason: 'error', message: 'תשלום בקופה אינו מוגדר לקיוסק' });
  });

  it('an old cloud (no parameter, nothing in the config): `pay_at_till` all the same; the config\'s word when the parameter is absent', () => {
    const c = cloud();
    expect(kiosk(c, { methods: ['card'] }).fresh().pay.tillFallback).toBe(true);
    // The Android bundle's way (the cloud puts `block` in the config): honoured here too when no parameter came.
    expect(kiosk(c, { methods: ['card'], general: { noTerminalFallback: 'block' } }).fresh().pay.usable).toEqual([]);
    // The parameter wins over the config.
    expect(kiosk(c, { methods: ['card'], general: { noTerminalFallback: 'block' }, params: { kioskNoTerminalFallback: 'pay_at_till' } }).fresh().pay.tillFallback).toBe(true);
    // The kiosk set to take the till itself: nothing added for the terminal.
    expect(kiosk(c, { methods: ['card', 'cash_at_till'] }).fresh().pay.tillFallback).toBeUndefined();
  });

  it('set up but not answering: the card stays (tried on the press) with "תשלום בקופה" beside it; back when it answers', async () => {
    const c = cloud();
    const terminal = pinpad();
    terminal.script.check = false;
    const k = kiosk(c, { terminal, methods: ['card'] });
    expect(k.fresh().pay).toMatchObject({ methods: ['card'], usable: ['card'], cardOff: null });
    await k.svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    await k.svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    const v = k.fresh();
    expect(v.state.terminal).toBe('unreachable');
    expect(v.pay).toMatchObject({ methods: ['card', 'cash_at_till'], usable: ['card', 'cash_at_till'], cardOff: null, tillFallback: true });
    expect(terminalAlerts(k)).toEqual([{ kind: 'terminal', key: 'terminal', reason: 'unreachable', detail: PINPAD }]);
    // Two ways to pay: "איך תרצו לשלם?" is asked (KioskApp: fallbackPayConfig), the card first.
    expect(payMethodAsk(v.pay.methods, v.pay.usable, 'required')).toEqual({ asks: true, optional: false, fallback: 'card' });
    // `block`: the card alone, as before.
    const blocked = kiosk(c, { terminal, methods: ['card'], params: { kioskNoTerminalFallback: 'block' } });
    await blocked.svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    await blocked.svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    expect(blocked.fresh().pay).toMatchObject({ methods: ['card'], usable: ['card'] });
    // The terminal answers again: the till goes, and so does the alert.
    terminal.script.check = true;
    await k.svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    expect(k.fresh().pay.methods).toEqual(['card']);
    expect(terminalAlerts(k)).toEqual([]);
  });

  it('a charge that never reached the terminal: the customer is told to pay at the till, and it is offered at once', async () => {
    const c = cloud();
    const terminal = pinpad();
    const k = kiosk(c, { terminal, methods: ['card'] });
    terminal.script.sale.push({ answer: 'NOT_SENT', message: 'connect ETIMEDOUT 10.0.0.5:8080' });
    const { orderId, last } = await sell(k);
    expect(last).toMatchObject({ phase: 'declined', message: FALLBACK_TEXT });
    expect(k.svc.ledger.doc(k.svc.orders.get(orderId)!.transactionId!)!.status).toBe('cancelled');
    expect(k.fresh().pay).toMatchObject({ methods: ['card', 'cash_at_till'], usable: ['card', 'cash_at_till'], tillFallback: true });
    // Told at once, before any check: "אין תקשורת למסופון האשראי".
    expect(terminalAlerts(k)).toEqual([{ kind: 'terminal', key: 'terminal', reason: 'unreachable', detail: PINPAD }]);
    // A check that answers: the card alone again, no alert.
    await k.svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    expect(k.fresh().pay.methods).toEqual(['card']);
    expect(terminalAlerts(k)).toEqual([]);
    // A card the terminal declines is the card's answer: nothing offered for it.
    terminal.script.sale.push({ answer: 'DECLINED', message: 'כרטיס נדחה', raw: null, statusCode: 3 });
    expect((await sell(k)).last).toMatchObject({ phase: 'declined', message: 'כרטיס נדחה' });
    expect(k.fresh().pay.methods).toEqual(['card']);
  });

  it('offline and no terminal: to the shop’s LAN host (its print server); the host down — the "לתשלום בקופה" slip', async () => {
    const host = await lanHost();
    const c = cloud();
    c.state.online = true;
    c.answers['GET sync/m/printers'] = () => printersAnswer(host.port);
    const k = kiosk(c, { methods: ['card'] });
    // Online, the card-only kiosk learnt where the host is: the till may be offered for its terminal.
    await k.svc.pullLanHost(true);
    expect(k.svc.lanTarget()).toMatchObject({ address: '127.0.0.1', port: host.port });
    c.state.online = false;
    k.offline(true);
    expect(k.fresh().pay).toMatchObject({ methods: ['card', 'cash_at_till'], usable: ['cash_at_till'] });
    const r = await k.svc.placeOpenOrder({ ...basket(), expectedTotalAgorot: 4200, vouchers: [] });
    expect(r).toMatchObject({ ok: true, pending: false, dueAgorot: 4200 });
    expect(host.board.has((r as { localId: string }).localId)).toBe(true);
    // The host down: the customer takes it to the till on paper.
    host.setDown(true);
    const slipped = await k.svc.placeOpenOrder({ ...basket(), expectedTotalAgorot: 4200, vouchers: [] });
    expect(slipped).toMatchObject({ ok: true, pending: true });
    const slip = textOf(await until(() => k.printed.find((d) => d.kind === 'receipt')));
    for (const s of ['לתשלום בקופה', '1 × המבורגר', `KO:${(slipped as { localId: string }).localId}`, 'הזמנה ממתינה לסנכרון']) expect(slip).toContain(s);
    expect(k.svc.outbox.count('transaction')).toBe(0);
    // "חסימת הזמנות כשאין אינטרנט" still holds what it holds: offline with it on (`all`), the "offline" rest.
    const held = kiosk(c, { methods: ['card'], general: { blockWhenOffline: true } });
    held.offline(true);
    expect(held.fresh()).toMatchObject({ pay: { usable: [] }, state: { noPayment: true, noPaymentReason: 'offline' } });
  });
});
