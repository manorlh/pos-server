/**
 * Cash stage 2 on the Windows kiosk (P:/specs/cash-paylink.md §11.15), end to end against a real cash host on the
 * loopback (its LAN API, a simulated PayLink station) and a scripted card terminal:
 *  - `ask`: "חסר עודף" — the choices offered (slip; credit online; tip where tips are on), a tip on the document,
 *    a credit's slip with its QR, the choice acknowledged at the station;
 *  - cash + card: "להשלים באשראי" — the cash part held (PARTIAL), the card charged the rest; approved → one document
 *    with both legs (`mixed`), declined → the cash back and the document voided;
 *  - a cash credit redeemed for an order (a `cash_credit` leg), released when it is taken off;
 *  - the kiosk's own "אין קשר לעמדת המזומן" alert; the cash host's remote commands and its scrubbed logs.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { KioskService } from '../src/main/service';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { CashJournal } from '../src/main/cash/journal';
import { CashHost } from '../src/main/cash/host';
import { SimulatedPaylink, type SimConfig } from '../src/main/cash/simulator';
import { deriveClientSecret } from '../src/main/cash/auth';
import { documentWire } from '../src/main/fiscal/ledger';
import { cashCreditCodeOf, creditLegsOf, refusalOf, scannedCashCreditCode } from '../src/core/cash/credit';
import { scrubLogText } from '../src/core/logScrub';
import { DeviceCommands } from '../src/main/deviceCommands';
import { RollingLog } from '../src/main/deviceLog';
import type { Api } from '../src/main/sync/api';
import type { PayProgress, StartPaymentIn } from '../src/shared/bridge';
import type { PrintDoc } from '../src/core/printDocs';
import type { Transport } from '../src/main/printer/transports';
import type { PaymentProvider, SaleResult } from '../src/main/payment/provider';

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const HOST_SECRET = 'c'.repeat(64);

const stoppers: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stoppers.splice(0).reverse()) await s();
});

const SIM: SimConfig = {
  coins: [10, 50, 100, 200, 500, 1000],
  notes: { values: [2000, 5000, 10000, 20000], bus: 'id003', escrow: true },
  hoppers: [
    { valueAgorot: 1000, count: 40 },
    { valueAgorot: 500, count: 40 },
    { valueAgorot: 100, count: 60 },
    { valueAgorot: 50, count: 40 },
    { valueAgorot: 10, count: 80 },
  ],
  autoTakeBills: true,
  piecesPerRead: 5,
};

async function cashHost(settings: Record<string, unknown> = {}, sim: SimConfig = SIM) {
  const db = openDb(':memory:');
  migrate(db);
  const device = new SimulatedPaylink(sim);
  const host = new CashHost({
    api: { get: async () => ({ kind: 'offline', reason: 'x' }), post: async () => ({ kind: 'offline', reason: 'x' }) } as unknown as Api,
    kv: new Kv(db),
    journal: new CashJournal(db),
    machineId: () => 'host-1',
    appVersion: '0.5.0',
    now: Date.now,
    newId: () => randomUUID(),
    log: () => undefined,
    lanAddress: () => '127.0.0.1',
    cloudOnline: () => true,
    createDevice: () => ({ device, driverInstalled: () => true }),
    port: 0,
    manualTimers: true,
  });
  host.apply({
    hostSecret: HOST_SECRET,
    stations: [
      {
        stationId: 'st-1',
        name: 'עמדת מזומן 1',
        location: null,
        serial: '',
        simulator: true,
        settings: { cashSettleMs: 200, cashRefundGraceSec: 10, ...settings },
        clients: [{ machineId: MACHINE, name: 'קיוסק Windows', kind: 'kiosk' }],
      },
    ],
    commands: [],
    settings: {},
    lanAlertTargets: [],
  });
  await host.start();
  const timer = setInterval(() => void host.tick(), 40);
  stoppers.push(async () => {
    clearInterval(timer);
    await host.stop();
  });
  for (let i = 0; i < 3; i++) await host.tick();
  return { host, device };
}

/** A card terminal that answers as scripted. */
function terminal() {
  const script: { sale: SaleResult; amounts: number[] } = {
    sale: { answer: 'APPROVED', raw: '', card: { brand: 'visa', last4: '4242', authNum: '0123456', uid: 'u-1', payments: null, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'v-1' } } },
    amounts: [],
  };
  let seq = 0;
  const provider: PaymentProvider = {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
    newReference: () => `ref${++seq}`,
    check: async () => ({ ok: true, detail: null }),
    sale: async (req) => {
      script.amounts.push(req.amountAgorot);
      await new Promise((r) => setTimeout(r, 50));
      return script.sale;
    },
    resolve: async () => ({ kind: 'unknown', message: 'no answer' }),
    abort: async () => undefined,
  };
  return { provider, script };
}

interface KioskOpts {
  cashSettings?: Record<string, unknown>;
  tipEnabled?: boolean;
  card?: PaymentProvider | null;
  /** The cloud's answers to the cash credits' calls. */
  cloud?: (method: string, p: string, body: unknown) => { status: number; body: unknown } | null;
}

function kiosk(port: number, opts: KioskOpts = {}) {
  const printed: PrintDoc[] = [];
  const cloudCalls: Array<{ method: string; path: string; body: unknown }> = [];
  const printer: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(`http://127.0.0.1:${port}/`)) return fetch(input, init);
    // Any other address on the LAN: nobody there.
    if (url.startsWith('http://127.0.0.1:')) throw new TypeError('fetch failed');
    const p = new URL(url).pathname.replace(/^\/api\/v1\//, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    cloudCalls.push({ method, path: p, body });
    const answer = opts.cloud?.(method, p, body);
    if (answer) return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    return new Response('{"detail":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-cash2-')),
    appVersion: '0.5.0',
    deviceInfo: { platform: 'windows' },
    transport: printer,
    fetch: fetchFn,
    providers: opts.card ? [() => opts.card!] : [],
    downloader: async () => {
      throw new Error('no media');
    },
  });
  const q = svc.printQueue as unknown as { enqueue: (kind: string, ref: string | null, doc: PrintDoc) => string };
  const enqueue = q.enqueue.bind(svc.printQueue);
  q.enqueue = (kind, ref, doc) => {
    printed.push(doc);
    return enqueue(kind, ref, doc);
  };
  stoppers.push(() => svc.stop());
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://localhost:8001');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4' });
  svc.cloud.applyCatalog({
    syncType: 'full',
    serverTime: 'x',
    machineCatalog: { mode: 'all' },
    categories: [{ id: 'c-main', name: 'עיקריות', isActive: true }],
    products: [
      { id: 'p-burger', name: 'המבורגר', price: 37.35, categoryId: 'c-main', inStock: true, isAvailable: true, sku: '1001' },
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
      general: { blockWhenOffline: false },
      payment: { methods: ['card', 'cash_device'], receiptPolicy: 'always', tipEnabled: opts.tipEnabled ?? false, tipPresets: [10] },
      pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 },
      printing: {},
    },
  });
  svc.kv.setJson('cash.clientConfig', {
    enabled: true,
    station: { stationId: 'st-1', name: 'עמדת מזומן 1', location: null, hostId: 'host-1', hostName: null, lanAddress: '127.0.0.1', port, secret: deriveClientSecret(HOST_SECRET, MACHINE) },
    settings: { cashRefundGraceSec: 10, ...(opts.cashSettings ?? {}) },
  });
  (svc.cashPay as unknown as { cfg: unknown }).cfg = svc.kv.getJson('cash.clientConfig');
  svc.applyProvider();
  const progress: PayProgress[] = [];
  svc.on('pay', (p: PayProgress) => progress.push(p));
  /** The cloud answered a heartbeat just now (a credit is offered online only). */
  const online = () => {
    (svc as unknown as { sync: { status: { lastBeatOkAt: number | null } } }).sync.status.lastBeatOkAt = Date.now();
  };
  return { svc, printed, progress, cloudCalls, online };
}

const basket = (over: Partial<StartPaymentIn> = {}): StartPaymentIn => ({
  lines: [{ key: 'L1', productId: 'p-cola', qty: 2, options: [], notes: [] }],
  service: 'take_away',
  customerName: null,
  customerPhone: null,
  tableRef: null,
  tipPct: null,
  tipAgorot: null,
  method: 'cash_device',
  ...over,
});

const until = async <T>(fn: () => T | null | undefined | false, ms = 15_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const textOf = (d: PrintDoc) => JSON.stringify(d);
/** Every hopper jammed: a 50 on 20 owes the whole change. */
const NO_CHANGE: SimConfig = { ...SIM, hoppers: [{ valueAgorot: 1000, count: 5 }, { valueAgorot: 100, count: 5 }] };

async function owedSale(k: ReturnType<typeof kiosk>, device: SimulatedPaylink) {
  await k.svc.cashPay.refreshStatus();
  const r = await k.svc.startPayment(basket());
  expect(r.ok).toBe(true);
  await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
  device.jam(1000);
  device.jam(100);
  expect(device.insert(5000)).toBe('escrow');
  return (r as { orderId: string }).orderId;
}

describe('ask (§11.15א): the customer chooses what to do with the change owed', () => {
  it('the choices on the pay screen; a tip goes on the document in cash, no slip; the station hears "tip"', async () => {
    const { host, device } = await cashHost({ cashChangeShortfall: 'ask', cashExactChangeBelowAgorot: 0 }, NO_CHANGE);
    const k = kiosk(host.port, { tipEnabled: true });
    const orderId = await owedSale(k, device);
    const ask = await until(() => k.progress.find((p) => p.cash?.stage === 'owed_choice'));
    expect(ask.cash!.owedChoices).toEqual(['slip', 'tip']); // offline: no credit
    expect(ask.cash!.changeOwedAgorot).toBeGreaterThan(0);
    expect(ask.cash!.owedDeadlineAt).toBeGreaterThan(Date.now());
    await k.svc.cashOwedChoice('lottery'); // not offered: nothing
    await k.svc.cashOwedChoice('tip');
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    const doc = k.svc.ledger.doc(k.svc.orders.get(orderId)!.transactionId!)!;
    expect(doc.cash!.changeOwedAs).toBe('tip');
    expect(doc.totals.tipAgorot).toBe(doc.cash!.changeOwedAgorot);
    const wire = documentWire(doc);
    expect(wire).toMatchObject({ paymentMethod: 'cash', tipPaymentMethod: 'cash' });
    expect(k.printed.some((d) => textOf(d).includes('גשו עם הפתק'))).toBe(false);
    await until(() => host.station('st-1')!.recentTxs(1)[0]?.acked);
    expect(host.station('st-1')!.recentTxs(1)[0].changeOwedAs).toBe('tip');
  });

  it('online: a credit — its slip with the code and the CC: QR; the receipt says "זיכוי להזמנה הבאה"', async () => {
    const { host, device } = await cashHost({ cashChangeShortfall: 'ask', cashExactChangeBelowAgorot: 0 }, NO_CHANGE);
    const k = kiosk(host.port);
    k.online();
    const orderId = await owedSale(k, device);
    const ask = await until(() => k.progress.find((p) => p.cash?.stage === 'owed_choice'));
    expect(ask.cash!.owedChoices).toEqual(['slip', 'credit']);
    await k.svc.cashOwedChoice('credit');
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    const doc = k.svc.ledger.doc(k.svc.orders.get(orderId)!.transactionId!)!;
    expect(doc.cash!.changeOwedAs).toBe('credit');
    const slip = await until(() => k.printed.find((d) => textOf(d).includes('הציגו את הפתק בקופה או סרקו אותו בקיוסק')));
    expect(textOf(slip)).toContain(`"t":"qr","value":"CC:${doc.cash!.slipCode}"`);
    const receipt = await until(() => k.printed.find((d) => d.kind === 'receipt' && textOf(d).includes('זיכוי להזמנה הבאה') && textOf(d).includes('שולם במזומן')));
    expect(textOf(receipt)).not.toContain('עודף חייב');
    await until(() => host.station('st-1')!.recentTxs(1)[0]?.acked);
    expect(host.station('st-1')!.recentTxs(1)[0].changeOwedAs).toBe('credit');
  });

  it('notify: never asked — the slip as in stage 1', async () => {
    const { host, device } = await cashHost({ cashExactChangeBelowAgorot: 0 }, NO_CHANGE);
    const k = kiosk(host.port, { tipEnabled: true });
    await owedSale(k, device);
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    expect(k.progress.some((p) => p.cash?.stage === 'owed_choice')).toBe(false);
    await until(() => k.printed.find((d) => textOf(d).includes('גשו עם הפתק')));
    await until(() => host.station('st-1')!.recentTxs(1)[0]?.acked);
    expect(host.station('st-1')!.recentTxs(1)[0].changeOwedAs).toBe('slip');
  });
});

describe('cash + card (§11.15ב)', () => {
  async function split(card: ReturnType<typeof terminal>) {
    const { host, device } = await cashHost();
    const k = kiosk(host.port, { card: card.provider, cashSettings: { cashSplitWithCard: true } });
    await k.svc.cashPay.refreshStatus();
    const r = await k.svc.startPayment(basket({ lines: [{ key: 'L1', productId: 'p-burger', qty: 2, options: [], notes: [] }] }));
    expect(r.ok).toBe(true);
    await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
    // Nothing in yet: not offered.
    expect(k.progress.some((p) => p.cash?.canSplit)).toBe(false);
    expect(device.insert(2000)).toBe('escrow');
    await until(() => k.progress.find((p) => p.cash?.stage === 'insert' && p.cash.insertedAgorot === 2000 && p.cash.canSplit));
    expect(await k.svc.cashSplit()).toEqual({ ok: true });
    return { host, device, k, orderId: (r as { orderId: string }).orderId };
  }

  it('approved: the cash part kept, the card charged the rest — one document, both legs, `mixed`', async () => {
    const card = terminal();
    const { host, k, orderId } = await split(card);
    const cardScreen = await until(() => k.progress.find((p) => p.cash?.stage === 'split_card'));
    expect(cardScreen.cash).toMatchObject({ splitAgorot: 2000, cardRestAgorot: 7470 - 2000 });
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    expect(card.script.amounts).toEqual([5470]);
    const doc = k.svc.ledger.doc(k.svc.orders.get(orderId)!.transactionId!)!;
    expect(doc.status).toBe('completed');
    const wire = documentWire(doc);
    expect(wire.paymentMethod).toBe('mixed');
    expect((wire.payments as Array<Record<string, unknown>>).map((l) => [l.method, l.amount])).toEqual([
      ['cash', 20],
      ['card', 54.7],
    ]);
    await until(() => host.station('st-1')!.recentTxs(1)[0]?.acked);
    const tx = host.station('st-1')!.recentTxs(1)[0];
    expect([tx.state, tx.outcome, tx.splitAgorot, tx.documentId]).toEqual(['DONE', 'paid', 2000, doc.id]);
    await until(() => k.svc.cashPay.pending().length === 0);
  });

  it('declined: the cash back at the station, the document voided, the customer told', async () => {
    const card = terminal();
    card.script.sale = { answer: 'DECLINED', message: 'סירוב', raw: null, statusCode: 5 };
    const { host, k, orderId } = await split(card);
    const declined = await until(() => k.progress.find((p) => p.phase === 'declined'));
    expect(declined.message).toContain('סירוב');
    expect(declined.message).toContain('הכסף הוחזר');
    const doc = k.svc.ledger.doc(k.svc.orders.get(orderId)!.transactionId!)!;
    expect(doc.status).toBe('cancelled');
    await until(() => host.station('st-1')!.recentTxs(1)[0]?.acked);
    const tx = host.station('st-1')!.recentTxs(1)[0];
    expect([tx.state, tx.outcome, tx.refundPaidAgorot]).toEqual(['DONE', 'refunded', 2000]);
  });
});

describe('cash credits at the kiosk (§11.15א)', () => {
  it('a code taken online for the goods, a `cash_credit` leg on the document; taken off — released', async () => {
    const { host } = await cashHost();
    const redeemed: unknown[] = [];
    const k = kiosk(host.port, {
      card: terminal().provider,
      cloud: (method, p, body) => {
        if (method === 'GET' && p === `sync/${MACHINE}/cash/credits/C-K7Q3MX`) return { status: 200, body: { credit: { code: 'C-K7Q3MX', amountAgorot: 1300, remainingAgorot: 1300, status: 'open' } } };
        if (method === 'GET' && p.startsWith(`sync/${MACHINE}/cash/credits/`)) return { status: 404, body: { detail: { code: 'credit_not_found', message: 'הזיכוי לא נמצא.' } } };
        if (method === 'POST' && p === `sync/${MACHINE}/cash/credits/C-K7Q3MX/redeem`) {
          redeemed.push(body);
          const b = body as { redemptionId: string; amountAgorot: number };
          return { status: 200, body: { ok: true, redemption: { id: b.redemptionId, amountAgorot: b.amountAgorot }, credit: { code: 'C-K7Q3MX', remainingAgorot: 1300 - b.amountAgorot } } };
        }
        if (method === 'POST' && p.includes('/cash/credits/redemptions/')) return { status: 200, body: { ok: true } };
        return null;
      },
    });
    const id = randomUUID();
    const r = await k.svc.redeemCashCredit({ code: 'ck7q3mx', dueAgorot: 2000, clientRequestId: id });
    expect(r).toEqual({ ok: true, credit: { redemptionId: id, code: 'C-K7Q3MX', amountAgorot: 1300, remainingAgorot: 0 } });
    expect(redeemed).toEqual([{ redemptionId: id, amountAgorot: 1300 }]);
    expect(await k.svc.redeemCashCredit({ code: 'C-AAAAAA', dueAgorot: 2000, clientRequestId: randomUUID() })).toEqual({ ok: false, error: 'הזיכוי לא נמצא' });
    expect((await k.svc.redeemCashCredit({ code: 'nope', dueAgorot: 2000, clientRequestId: randomUUID() })).ok).toBe(false);
    // Paid by card for the rest: the credit's leg first.
    const pay = await k.svc.startPayment(basket({ method: 'card', credits: [{ redemptionId: id, code: 'C-K7Q3MX', amountAgorot: 1300 }] }));
    expect(pay.ok && pay.amountAgorot).toBe(700);
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    const doc = k.svc.ledger.doc(k.svc.orders.get((pay as { orderId: string }).orderId)!.transactionId!)!;
    expect((documentWire(doc).payments as Array<Record<string, unknown>>).map((l) => [l.method, l.amount])).toEqual([
      ['cash_credit', 13],
      ['card', 7],
    ]);
    // More than the goods, or malformed: refused before anything.
    expect(await k.svc.startPayment(basket({ method: 'card', credits: [{ redemptionId: randomUUID(), code: 'C-K7Q3MX', amountAgorot: 2500 }] }))).toMatchObject({ ok: false, reason: 'error' });
    expect(await k.svc.startPayment(basket({ method: 'card', credits: [{ redemptionId: 'x', code: 'C-K7Q3MX', amountAgorot: 100 }] as never }))).toMatchObject({ ok: false, reason: 'error' });
    // Taken off an order that was not paid: released (and retried until the cloud answers).
    const other = randomUUID();
    await k.svc.releaseCashCredit(other);
    await until(() => k.cloudCalls.find((c) => c.path === `sync/${MACHINE}/cash/credits/redemptions/${other}/release`));
  });

  it('the codes: typed, scanned, the payment field; refusals in either shape', () => {
    expect(['C-K7Q3MX', 'c-k7q3mx', 'CK7Q3MX', ' CC:C-K7Q3MX '].map(cashCreditCodeOf)).toEqual(['C-K7Q3MX', 'C-K7Q3MX', 'C-K7Q3MX', 'C-K7Q3MX']);
    expect(['', 'K7Q3MX', 'C-K7Q', 'PV:ABCDEFGHJKMNPQRS', null].map(cashCreditCodeOf)).toEqual([null, null, null, null, null]);
    expect(scannedCashCreditCode(']Q1CC:C-K7Q3MX\r')).toBe('C-K7Q3MX');
    expect(scannedCashCreditCode('C-K7Q3MX')).toBeNull();
    const id = randomUUID();
    expect(creditLegsOf([{ redemptionId: id, code: 'ck7q3mx', amountAgorot: 100 }])).toEqual([{ redemptionId: id, code: 'C-K7Q3MX', amountAgorot: 100 }]);
    expect(creditLegsOf(undefined)).toEqual([]);
    expect(creditLegsOf([{ redemptionId: id, code: 'C-K7Q3MX', amountAgorot: 0 }])).toBeNull();
    expect(creditLegsOf([{ redemptionId: id, code: 'C-K7Q3MX', amountAgorot: 1 }, { redemptionId: id, code: 'C-K7Q3MX', amountAgorot: 1 }])).toBeNull();
    expect(refusalOf({ detail: { code: 'credit_used', message: 'נוצל' } })).toMatchObject({ code: 'credit_used', message: 'נוצל' });
    expect(refusalOf({ error: 'not_holder', message: 'x', position: 2 })).toMatchObject({ code: 'not_holder', extra: { position: 2 } });
    expect(refusalOf({ detail: 'Not Found' })).toMatchObject({ code: null, message: 'Not Found' });
  });
});

describe('the kiosk’s own cash alert (§11.15ג)', () => {
  it('the station silent a minute on the LAN: kind cash, naming the station; gone once it answers', async () => {
    const { host } = await cashHost();
    let now = Date.now();
    const k = kiosk(host.port);
    (k.svc.cashPay as unknown as { now: () => number }).now = () => now;
    await k.svc.cashPay.refreshStatus();
    expect(k.svc.cashPay.unreachableAlert()).toBeNull();
    // The station goes away.
    (k.svc.cashPay as unknown as { cfg: { station: { port: number } } }).cfg.station.port = 1;
    (k.svc.cashPay as unknown as { lan: unknown }).lan = null;
    await k.svc.cashPay.refreshStatus();
    expect(k.svc.cashPay.unreachableAlert()).toBeNull(); // not a minute yet
    now += 61_000;
    await k.svc.cashPay.refreshStatus();
    expect(k.svc.cashPay.unreachableAlert()).toEqual({
      kind: 'cash',
      key: 'cash:unreachable',
      reason: 'unreachable',
      text: 'אין קשר לעמדת המזומן עמדת מזומן 1',
      detail: { stationId: 'st-1', stationName: 'עמדת מזומן 1' },
    });
    // Back: gone.
    (k.svc.cashPay as unknown as { cfg: { station: { port: number } } }).cfg.station.port = host.port;
    (k.svc.cashPay as unknown as { lan: unknown }).lan = null;
    await k.svc.cashPay.refreshStatus();
    expect(k.svc.cashPay.unreachableAlert()).toBeNull();
  });
});

describe('the cash host’s remote commands (§11.15ד)', () => {
  function fakeApi(commands: Array<Record<string, unknown>>) {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const api = {
      get: async (p: string) => (p.endsWith('/device-commands') ? { kind: 'ok', status: 200, body: { commands }, headers: new Headers() } : { kind: 'offline', reason: 'x' }),
      post: async (p: string, body: Record<string, unknown>) => {
        posts.push({ path: p, body });
        if (p.endsWith('/device-logs')) return { kind: 'ok', status: 200, body: { id: 'log-1' }, headers: new Headers() };
        return { kind: 'ok', status: 200, body: {}, headers: new Headers() };
      },
    } as unknown as Api;
    return { api, posts };
  }

  it('a restart waits for no open payment; logs of the window, scrubbed, gzip + base64; anything else refused', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-logs-'));
    const logs = new RollingLog(dir);
    logs.write('I', 'tx 1 paid · card 4111 1111 1111 1111 · {"password": "hunter2"} · 052-1234567 · dana@example.com');
    let busy: string | null = 'payment_in_progress';
    let restarts = 0;
    const f = fakeApi([
      { id: 'c1', action: 'restart_app', status: 'delivered' },
      { id: 'c2', action: 'upload_logs', status: 'pending', params: { minutes: 30 } },
      { id: 'c3', action: 'lock', status: 'delivered' },
    ]);
    const dc = new DeviceCommands({ api: f.api, machineId: () => 'host-1', log: () => undefined, logs, appVersion: '0.5.0', busy: () => busy, restart: () => void restarts++ });
    await dc.poll();
    const acks = f.posts.filter((p) => p.path.includes('/ack')).map((p) => [p.path.split('/')[3], p.body.status, p.body.detail ?? null]);
    expect(acks).toEqual([
      ['c1', 'refused', 'payment_in_progress'],
      ['c2', 'done', null],
      ['c3', 'refused', 'not_supported'],
    ]);
    const upload = f.posts.find((p) => p.path.endsWith('/device-logs'))!.body;
    expect(upload).toMatchObject({ reason: 'remote', command_id: 'c2', content_encoding: 'gzip+base64', line_count: 1 });
    const text = gunzipSync(Buffer.from(String(upload.content), 'base64')).toString('utf8');
    expect(text).toContain('tx 1 paid');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('4111 1111 1111 1111');
    expect(text).toContain('************1111');
    expect(text).toContain('052-***-XX67');
    expect(text).toContain('d***@example.com');
    expect(f.posts.find((p) => p.path.endsWith('/c2/ack'))!.body.result).toEqual({ log_id: 'log-1' });
    // Answered commands are never answered twice; a new restart at rest goes through.
    f.posts.length = 0;
    await dc.poll();
    expect(f.posts.filter((p) => p.path.includes('/ack'))).toEqual([]);
    busy = null;
    const g = fakeApi([{ id: 'c4', action: 'restart_app', status: 'delivered' }]);
    const dc2 = new DeviceCommands({ api: g.api, machineId: () => 'host-1', log: () => undefined, logs, appVersion: '0.5.0', busy: () => busy, restart: () => void restarts++ });
    await dc2.poll();
    await new Promise((r) => setTimeout(r, 600));
    expect(g.posts.map((p) => p.body.status)).toEqual(['done']);
    expect(restarts).toBe(1);
  });

  it('scrubbing is idempotent and leaves ordinary numbers alone', () => {
    const once = scrubLogText('Authorization: Bearer abc.def · token=XYZ · order 57 · total 12345 · 4580123456789012');
    expect(once).not.toContain('abc.def');
    expect(once).toContain('token=***');
    expect(once).toContain('order 57 · total 12345');
    expect(scrubLogText(once)).toBe(once);
  });
});
