/**
 * "מזומן" end to end on the Windows kiosk (P:/specs/cash-paylink.md §11.6–§11.7): the kiosk's own
 * payment (service.startPayment with `method: 'cash_device'`) against a real cash host on the
 * loopback (its LAN API, a simulated PayLink station): the tile, the queue, the insert screen, the
 * document with its `cash` leg (and `cashDevice`), the receipt lines, the change-owed slip, a
 * cancel (the money back, the document voided), a held payment (the fault slip), a restart that
 * settles from the station's word, and cash with no internet (§13).
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KioskService } from '../src/main/service';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { CashJournal } from '../src/main/cash/journal';
import { CashHost } from '../src/main/cash/host';
import { SimulatedPaylink, type SimConfig } from '../src/main/cash/simulator';
import { deriveClientSecret } from '../src/main/cash/auth';
import { documentWire, xDocOf } from '../src/main/fiscal/ledger';
import { offlineRests, offlineUsable } from '../src/core/offlineBlock';
import type { Api } from '../src/main/sync/api';
import type { PayProgress, StartPaymentIn } from '../src/shared/bridge';
import type { PrintDoc } from '../src/core/printDocs';
import type { Transport } from '../src/main/printer/transports';

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const OTHER = '11111111-1111-4111-8111-111111111111';
const HOST_SECRET = 'b'.repeat(64);

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

async function cashHost(sim: SimConfig = SIM, settings: Record<string, unknown> = {}) {
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
        clients: [
          { machineId: MACHINE, name: 'קיוסק Windows', kind: 'kiosk' },
          { machineId: OTHER, name: 'קיוסק 2', kind: 'kiosk' },
        ],
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

function kiosk(port: number, opts: { methods?: string[]; dataDir?: string; cloudOffline?: boolean; block?: boolean } = {}) {
  const printed: PrintDoc[] = [];
  const printer: Transport = {
    send: async () => undefined,
    status: async () => ({ health: 'ok', detail: null }),
    list: async () => [],
    dispose: () => undefined,
  };
  // The cash host on the loopback answers for real; the cloud is a fake that knows nothing (404) — or is gone.
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(`http://127.0.0.1:${port}/`)) return fetch(input, init);
    if (opts.cloudOffline) throw new TypeError('fetch failed');
    return new Response('{"detail":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  const svc = new KioskService({
    dataDir: opts.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'kd-cash-')),
    appVersion: '0.5.0',
    deviceInfo: { platform: 'windows' },
    transport: printer,
    fetch: fetchFn,
    providers: [],
    downloader: async () => {
      throw new Error('no media');
    },
  });
  // What reached the printer, as pages.
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
    config: { general: { blockWhenOffline: opts.block ?? false }, payment: { methods: opts.methods ?? ['card', 'cash_device'], receiptPolicy: 'always' }, pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 }, printing: {} },
  });
  // The cloud's answer to GET /sync/{m}/cash, as kept (§11.2).
  svc.kv.setJson('cash.clientConfig', {
    enabled: true,
    station: { stationId: 'st-1', name: 'עמדת מזומן 1', location: null, hostId: 'host-1', hostName: null, lanAddress: '127.0.0.1', port, secret: deriveClientSecret(HOST_SECRET, MACHINE) },
    settings: { cashRefundGraceSec: 10 },
  });
  // The kiosk read it (the constructor read the kv before).
  (svc.cashPay as unknown as { cfg: unknown }).cfg = svc.kv.getJson('cash.clientConfig');
  svc.applyProvider();
  const progress: PayProgress[] = [];
  svc.on('pay', (p: PayProgress) => progress.push(p));
  return { svc, printed, progress };
}

const basket = (over: Partial<StartPaymentIn> = {}): StartPaymentIn => ({
  lines: [{ key: 'L1', productId: 'p-burger', qty: 1, options: [], notes: [] }],
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

describe('the Windows kiosk pays at the cash station', () => {
  it('the tile: offered only while the station answers ready', async () => {
    const { host } = await cashHost();
    const k = kiosk(host.port);
    expect(k.svc.view().pay.usable).not.toContain('cash_device');
    await k.svc.cashPay.refreshStatus();
    (k.svc as unknown as { viewDirty: boolean }).viewDirty = true;
    expect(k.svc.view().pay.methods).toContain('cash_device');
    expect(k.svc.view().pay.usable).toContain('cash_device');
  });

  it('a sale: 37.35 collected as 37.40 from a 50 note — the document, its cash leg, the receipt, the change', async () => {
    const { host, device } = await cashHost();
    const k = kiosk(host.port);
    await k.svc.cashPay.refreshStatus();
    const r = await k.svc.startPayment(basket());
    expect(r.ok).toBe(true);
    const orderId = (r as { orderId: string }).orderId;
    // The insert screen: "הוכנסו 0 מתוך 37.40".
    const insert = await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
    expect(insert.phase).toBe('charging');
    expect(insert.cash!.dueAgorot).toBe(3740);
    expect(device.insert(5000)).toBe('escrow');
    const approved = await until(() => k.progress.find((p) => p.phase === 'approved'));
    expect(approved.orderId).toBe(orderId);
    const order = k.svc.orders.get(orderId)!;
    const doc = k.svc.ledger.doc(order.transactionId!)!;
    expect(doc.status).toBe('completed');
    expect(doc.cash).toMatchObject({ stationId: 'st-1', hostId: 'host-1', receivedAgorot: 5000, changeAgorot: 1260, changeOwedAgorot: 0, roundingAgorot: 5 });
    const wire = documentWire(doc);
    expect(wire.paymentMethod).toBe('cash');
    expect(wire.payments).toEqual([expect.objectContaining({ method: 'cash', amount: 37.35, cashDevice: expect.objectContaining({ txId: doc.cash!.txId, receivedAgorot: 5000, changeAgorot: 1260 }) })]);
    // The X counts it as cash.
    expect(xDocOf(doc).payments).toEqual([{ method: 'cash', amountAgorot: 3735 }]);
    // The receipt: "מזומן", "שולם במזומן", "עודף", the rounding.
    const receipt = await until(() => k.printed.find((d) => d.kind === 'receipt' && textOf(d).includes('שולם במזומן')));
    expect(textOf(receipt)).toContain('עודף');
    expect(textOf(receipt)).toContain('עיגול מזומן');
    // Acknowledged at the station, with the order's number; the station free again.
    await until(() => host.station('st-1')!.recentTxs(1)[0]?.acked);
    expect(host.station('st-1')!.recentTxs(1)[0].documentId).toBe(doc.id);
    expect(host.busy()).toBe(false);
    expect(k.svc.cashPay.pending()).toEqual([]);
  });

  it('change the station cannot pay: owed — the slip with its code, the receipt says it', async () => {
    const { host, device } = await cashHost({ ...SIM, hoppers: [{ valueAgorot: 1000, count: 5 }, { valueAgorot: 100, count: 5 }] }, { cashExactChangeBelowAgorot: 0 });
    const k = kiosk(host.port);
    await k.svc.cashPay.refreshStatus();
    const r = await k.svc.startPayment(basket({ lines: [{ key: 'L1', productId: 'p-cola', qty: 2, options: [], notes: [] }] }));
    expect(r.ok).toBe(true);
    await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
    device.jam(1000);
    device.jam(100);
    expect(device.insert(5000)).toBe('escrow');
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    const doc = k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!;
    expect(doc.cash!.changeOwedAgorot).toBeGreaterThan(0);
    expect(doc.cash!.slipCode).toMatch(/^C-/);
    const slip = await until(() => k.printed.find((d) => d.kind === 'receipt' && textOf(d).includes('עודף חייב') && textOf(d).includes('גשו עם הפתק')));
    expect(textOf(slip)).toContain(doc.cash!.slipCode!);
  });

  it('cancel: the money comes back at the station, the document is voided', async () => {
    const { host, device } = await cashHost();
    const k = kiosk(host.port);
    await k.svc.cashPay.refreshStatus();
    const r = await k.svc.startPayment(basket());
    await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
    device.insert(1000);
    await until(() => k.progress.find((p) => (p.cash?.insertedAgorot ?? 0) >= 1000));
    await k.svc.cancelPayment();
    const declined = await until(() => k.progress.find((p) => p.phase === 'declined'));
    expect(declined.message).toBe('הכסף הוחזר');
    const doc = k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!;
    expect(doc.status).toBe('cancelled');
    expect(host.station('st-1')!.recentTxs(1)[0]).toMatchObject({ outcome: 'refunded', refundPaidAgorot: 1000 });
  });

  it('the queue: a second kiosk holds the station — "ממתין… (מקום 1)" until it is free', async () => {
    const { host } = await cashHost();
    const k = kiosk(host.port);
    await k.svc.cashPay.refreshStatus();
    // Another kiosk holds the unit.
    const other = host.station('st-1')!.lease(OTHER, {});
    expect((other.body as { state: string }).state).toBe('granted');
    const renew = setInterval(() => host.station('st-1')!.lease(OTHER, {}), 500);
    stoppers.push(() => clearInterval(renew));
    await k.svc.startPayment(basket());
    const queued = await until(() => k.progress.find((p) => p.cash?.stage === 'queued'));
    expect(queued.message).toContain('מכשיר המזומן תפוס — ממתין… (מקום 1)');
    expect(queued.canCancel).toBe(true);
    clearInterval(renew);
    host.station('st-1')!.release(OTHER, (other.body as { leaseId: string }).leaseId);
    await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
    await k.svc.cancelPayment();
    await until(() => k.progress.find((p) => p.phase === 'declined'));
  });

  it('a power cut at the station mid-payment: HELD — the fault slip, no document', async () => {
    const { host, device } = await cashHost();
    const k = kiosk(host.port);
    await k.svc.cashPay.refreshStatus();
    const r = await k.svc.startPayment(basket());
    await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
    device.insert(2000);
    await until(() => k.progress.find((p) => (p.cash?.insertedAgorot ?? 0) >= 2000));
    device.powerCut();
    const fault = await until(() => k.progress.find((p) => p.phase === 'unknown'));
    expect(fault.message).toBe('תקלה — פנה לצוות');
    expect(fault.cash!.stage).toBe('fault');
    const slip = await until(() => k.printed.find((d) => textOf(d).includes('תקלה במזומן')));
    expect(textOf(slip)).toContain('הוכנסו');
    const doc = k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!;
    expect(doc.status).toBe('cancelled');
    const held = await until(() => host.station('st-1')!.recentTxs(1).find((t) => t.state === 'HELD' && t.acked));
    expect(held).toMatchObject({ heldReason: 'power_loss', heldAgorot: 2000 });
  });

  it('a kiosk restarted mid-payment: the station said paid — the document written then (no paper), acknowledged', async () => {
    const { host, device } = await cashHost();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'kd-cash-restart-'));
    const k1 = kiosk(host.port, { dataDir });
    await k1.svc.cashPay.refreshStatus();
    const r = await k1.svc.startPayment(basket({ lines: [{ key: 'L1', productId: 'p-cola', qty: 1, options: [], notes: [] }] }));
    const orderId = (r as { orderId: string }).orderId;
    await until(() => k1.progress.find((p) => p.cash?.stage === 'insert'));
    // The kiosk dies here (its loop stops); the customer pays at the station anyway.
    const pend = k1.svc.cashPay.pending();
    expect(pend).toHaveLength(1);
    k1.svc.stop();
    device.insert(1000);
    await until(() => host.station('st-1')!.recentTxs(1)[0]?.state === 'DONE');
    // The kiosk comes back on the same disk.
    const k2 = kiosk(host.port, { dataDir });
    expect(k2.svc.cashPay.pending().map((p) => p.txId)).toEqual([pend[0].txId]);
    await k2.svc.settleCash();
    const doc = k2.svc.ledger.doc(k2.svc.orders.get(orderId)!.transactionId!)!;
    expect(doc.status).toBe('completed');
    expect(doc.cash!.txId).toBe(pend[0].txId);
    expect(k2.svc.cashPay.pending()).toEqual([]);
    expect(host.station('st-1')!.recentTxs(1)[0].acked).toBe(true);
  });

  it('no internet (§13): the block keeps cash — no "offline" rest while the station is usable', async () => {
    expect(offlineUsable(['card', 'cash_at_till', 'cash_device'], true, 'all')).toEqual(['cash_device']);
    expect(offlineUsable(['card', 'cash_at_till', 'cash_device'], true, 'all', true)).toEqual([]);
    expect(offlineUsable(['card', 'cash_at_till', 'cash_device'], true, 'pay_at_till')).toEqual(['card', 'cash_device']);
    expect(offlineRests(true, 'all', ['cash_device'])).toBe(false);
    expect(offlineRests(true, 'all', [])).toBe(true);
    const { host, device } = await cashHost();
    const k = kiosk(host.port, { cloudOffline: true, block: true });
    await k.svc.cashPay.refreshStatus();
    const inner = k.svc as unknown as { offlineNow: boolean; viewDirty: boolean };
    inner.offlineNow = true;
    inner.viewDirty = true;
    const view = k.svc.view();
    expect(view.pay.usable).toEqual(['cash_device']);
    expect(view.state.noPayment).toBe(false);
    // And it sells: the document waits in the outbox for the cloud.
    const r = await k.svc.startPayment(basket());
    expect(r.ok).toBe(true);
    await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
    device.insert(5000);
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    expect(k.svc.outbox.count('transaction')).toBeGreaterThan(0);
  });
});
