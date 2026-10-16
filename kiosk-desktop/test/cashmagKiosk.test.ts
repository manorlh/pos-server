/**
 * "מזומן" at a CashMag machine, end to end on the Windows kiosk (P:/specs/cashmag-windows.md): the kiosk's own
 * payment (service.startPayment, `method: 'cash_device'`, CashMag turned on by the cloud's `cashmag*` parameters)
 * against the in-process fake CashMag server — the tile, "הכנס מזומן", the document with its `cash` leg
 * (`hostId` cashmag), the change owed through the kiosk's own choice (a slip or a tip — no credit for CashMag yet),
 * a cancel, a fault for the staff ("טופל"), the busy machine; and CashMag off: the cash station's path as before.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KioskService } from '../src/main/service';
import { documentWire } from '../src/main/fiscal/ledger';
import type { PayProgress, StartPaymentIn } from '../src/shared/bridge';
import type { PrintDoc } from '../src/core/printDocs';
import type { Transport } from '../src/main/printer/transports';
import type { CashMagLocalConfig } from '../src/main/kiosk/cashmagPay';
import { FakeCashMagServer, FN, payResult, type FakeConn, type FakeServerOptions, type ReceivedCall } from './support/cashmagFakeServer';

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';

const stoppers: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stoppers.splice(0).reverse()) await s();
});

const until = async <T>(fn: () => T | null | undefined | false, ms = 10_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function server(o: FakeServerOptions = {}) {
  const s = new FakeCashMagServer(o);
  await s.listen();
  stoppers.push(() => s.close());
  return s;
}

function kiosk(opts: { params?: Record<string, unknown>; local?: CashMagLocalConfig | null; tipEnabled?: boolean } = {}) {
  const printed: PrintDoc[] = [];
  const knocks: string[] = [];
  const printer: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
  // The cloud: a fake that knows nothing (404).
  const fetchFn: typeof fetch = async () => new Response('{"detail":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-cashmag-')),
    appVersion: '0.5.0',
    deviceInfo: { platform: 'windows' },
    transport: printer,
    fetch: fetchFn,
    providers: [],
    downloader: async () => {
      throw new Error('no media');
    },
    cashmagLocal: opts.local ?? null,
    cashmagPollMs: 100,
    cashmagDriverOptions: {
      connectTimeoutMs: 2_000,
      reconnectGraceMs: 300,
      reconnectBaseMs: 50,
      knock: async (host, port) => {
        knocks.push(`${host}:${port}`);
        const net = await import('node:net');
        return new Promise<boolean>((resolve) => {
          const s = net.connect({ host, port });
          s.once('connect', () => (s.destroy(), resolve(true)));
          s.once('error', () => resolve(false));
        });
      },
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
    config: { general: { blockWhenOffline: false }, payment: { methods: ['card', 'cash_device'], receiptPolicy: 'always', tipEnabled: opts.tipEnabled ?? false, tipPresets: [10] }, pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 }, printing: {} },
  });
  svc.cloud.setParameters({ ...(opts.params ?? {}) }, null);
  svc.applyProvider();
  const progress: PayProgress[] = [];
  svc.on('pay', (p: PayProgress) => progress.push(p));
  const online = () => {
    (svc as unknown as { sync: { status: { lastBeatOkAt: number | null } } }).sync.status.lastBeatOkAt = Date.now();
  };
  const fresh = () => {
    (svc as unknown as { viewDirty: boolean }).viewDirty = true;
    return svc.view();
  };
  return { svc, printed, progress, knocks, online, fresh };
}

const ON = (port: number, more: Record<string, unknown> = {}) => ({ cashmagEnabled: true, cashmagHost: '127.0.0.1', cashmagPort: port, cashmagOwedCredit: true, ...more });

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

const textOf = (d: PrintDoc) => JSON.stringify(d);

function heldPay(s: FakeCashMagServer) {
  const box: { call: ReceivedCall | null; conn: FakeConn | null } = { call: null, conn: null };
  s.setHandler(FN.pay, (call, conn) => {
    box.call = call;
    box.conn = conn;
  });
  return box;
}

describe('the Windows kiosk pays at a CashMag machine', () => {
  it('the tile: offered once the server answers a knock; gone when it does not — the card stays', async () => {
    const s = await server();
    const k = kiosk({ params: ON(s.port) });
    expect(k.fresh().pay.usable).not.toContain('cash_device');
    await k.svc.cashMag.probe();
    expect(k.fresh().pay.usable).toContain('cash_device');
    expect(k.fresh().pay.cashOff).toBeNull();
    await s.close();
    // Silent past three knocks' time: off, and why.
    (k.svc.cashMag as unknown as { lastOkAt: number }).lastOkAt = Date.now() - 10 * 60_000;
    await k.svc.cashMag.probe();
    expect(k.fresh().pay.usable).not.toContain('cash_device');
    expect(k.fresh().pay.cashOff).toBe('אין חיבור לשרת CashMag');
    // Knocks only: never a WebSocket while idle.
    expect(s.connections).toBe(0);
  });

  it('a sale: 37.35 collected as 37.40 from a 50 note — "הכנס מזומן", the document, its cash leg (cashmag), the receipt', async () => {
    const s = await server();
    const box = heldPay(s);
    const k = kiosk({ params: ON(s.port, { cashmagUserCode: '4321' }) });
    const r = await k.svc.startPayment(basket());
    expect(r.ok).toBe(true);
    const orderId = (r as { orderId: string }).orderId;
    const insert = await until(() => k.progress.find((p) => p.cash?.stage === 'insert'));
    await until(() => box.call);
    expect(insert).toMatchObject({ phase: 'charging', message: 'הכנס מזומן', canCancel: true, cash: { device: 'cashmag', stationName: 'CashMag', dueAgorot: 3740, insertedAgorot: 0 } });
    expect(box.call!.params).toEqual({ adc_transaction_amount: 37.4, as_transaction_currency: 'ILS' });
    box.conn!.signal('signalDeposits', { deposits: [{ idc_value: '50', ii_qty: 1, ie_fund_type: 3 }] });
    await until(() => k.progress.find((p) => p.cash?.stage === 'insert' && p.cash.insertedAgorot === 5000));
    box.conn!.result(box.call!.jobId, FN.pay, 0, payResult({ balance: '0', deposits: [['50', 1]], dispensed: [['10', 1, 2], ['2', 1, 2], ['0.50', 1, 2], ['0.10', 1, 2]] }));
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    const doc = k.svc.ledger.doc(k.svc.orders.get(orderId)!.transactionId!)!;
    expect(doc.status).toBe('completed');
    expect(doc.cash).toMatchObject({ stationId: `cashmag:127.0.0.1:${s.port}`, hostId: 'cashmag', receivedAgorot: 5000, changeAgorot: 1260, changeOwedAgorot: 0, roundingAgorot: 5, slipCode: null });
    const wire = documentWire(doc);
    expect(wire.paymentMethod).toBe('cash');
    expect(wire.payments).toEqual([expect.objectContaining({ method: 'cash', amount: 37.35, cashDevice: expect.objectContaining({ hostId: 'cashmag', receivedAgorot: 5000, changeAgorot: 1260 }) })]);
    const receipt = await until(() => k.printed.find((d) => d.kind === 'receipt' && textOf(d).includes('שולם במזומן')));
    expect(textOf(receipt)).toContain('עודף');
    // The journal closed with the document; the machine let go (GOODBYE).
    await until(() => k.svc.cashMag.journal().length === 0);
    await until(() => s.steps.some((x) => x.step === 'GOODBYE'));
    expect(s.calls.map((c) => c.fn)).toEqual([FN.user, FN.start, FN.pay]);
  });

  it('change owed: the kiosk asks — offline a slip or a tip (no credit); the slip printed with its code', async () => {
    const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '-2.60', deposits: [['50', 1]], dispensed: [['10', 1, 2]] })) } });
    const k = kiosk({ params: ON(s.port), tipEnabled: true });
    const r = await k.svc.startPayment(basket());
    const ask = await until(() => k.progress.find((p) => p.cash?.stage === 'owed_choice'));
    expect(ask.cash).toMatchObject({ device: 'cashmag', changeOwedAgorot: 260, owedChoices: ['slip', 'tip'] });
    // A sync meanwhile settles nothing the pay screen is still finishing (no document behind the customer's back).
    await k.svc.settleCashMag();
    expect(k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!.status).toBe('pending');
    await k.svc.cashOwedChoice('credit'); // not offered: nothing
    await k.svc.cashOwedChoice('slip');
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    const doc = k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!;
    expect(doc.cash).toMatchObject({ hostId: 'cashmag', receivedAgorot: 5000, changeAgorot: 1000, changeOwedAgorot: 260, changeOwedAs: 'slip' });
    expect(doc.cash!.slipCode).toMatch(/^C-/);
    const slip = await until(() => k.printed.find((d) => textOf(d).includes('גשו עם הפתק') && textOf(d).includes(doc.cash!.slipCode!)));
    expect(textOf(slip)).toContain('"label":"עמדה","value":"CashMag"');
  });

  it('change owed online: "זיכוי להזמנה הבאה" — the credit slip with its code and the CC: QR, the leg says credit', async () => {
    const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '-2.60', deposits: [['50', 1]], dispensed: [['10', 1, 2]] })) } });
    const k = kiosk({ params: ON(s.port) });
    k.online();
    const r = await k.svc.startPayment(basket());
    const ask = await until(() => k.progress.find((p) => p.cash?.stage === 'owed_choice'));
    expect(ask.cash!.owedChoices).toEqual(['slip', 'credit']);
    await k.svc.cashOwedChoice('credit');
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    const doc = k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!;
    expect(doc.cash).toMatchObject({ hostId: 'cashmag', changeOwedAgorot: 260, changeOwedAs: 'credit' });
    const wire = documentWire(doc);
    expect(wire.payments).toEqual([expect.objectContaining({ method: "cash", cashDevice: expect.objectContaining({ hostId: "cashmag", changeOwedAgorot: 260, changeOwedAs: "credit", slipCode: doc.cash!.slipCode }) })]);
    const slip = await until(() => k.printed.find((d) => textOf(d).includes('הציגו את הפתק בקופה או סרקו אותו בקיוסק')));
    expect(textOf(slip)).toContain(`"t":"qr","value":"CC:${doc.cash!.slipCode}"`);
    const receipt = await until(() => k.printed.find((d) => d.kind === 'receipt' && textOf(d).includes('זיכוי להזמנה הבאה') && textOf(d).includes('שולם במזומן')));
    expect(textOf(receipt)).not.toContain('עודף חייב');
  });

  it('`cashmagOwedCredit` off (or a cloud that does not send it): no credit, online too', async () => {
    for (const params of [{ cashmagOwedCredit: false }, { cashmagOwedCredit: undefined }]) {
      const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '-2.60', deposits: [['50', 1]], dispensed: [['10', 1, 2]] })) } });
      const k = kiosk({ params: ON(s.port, params), tipEnabled: true });
      k.online();
      await k.svc.startPayment(basket());
      const ask = await until(() => k.progress.find((p) => p.cash?.stage === 'owed_choice'));
      expect(ask.cash!.owedChoices).toEqual(['slip', 'tip']);
      await k.svc.cashOwedChoice('slip');
      await until(() => k.progress.find((p) => p.phase === 'approved'));
    }
  });

  it('"ביטול" while inserting: dialogCancel, the money back, the document voided — no fault', async () => {
    const s = await server();
    const box = heldPay(s);
    s.setHandler(FN.cancel, (call, conn) => {
      conn.result(call.jobId, call.fn, 0);
      conn.result(box.call!.jobId, FN.pay, 0, payResult({ balance: '37.40', deposits: [['20', 1]], dispensed: [['20', 1]] }));
    });
    const k = kiosk({ params: ON(s.port) });
    const r = await k.svc.startPayment(basket());
    await until(() => box.call);
    await k.svc.cancelPayment();
    const declined = await until(() => k.progress.find((p) => p.phase === 'declined'));
    expect(declined.message).toBe('התשלום בוטל — הכסף הוחזר (20 ₪)');
    const doc = k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!;
    expect(doc.status).toBe('cancelled');
    expect(k.svc.cashMag.unresolved()).toEqual([]);
  });

  it('a fault (money kept, not paid): no document, the fault slip, the tile off until a manager marks "טופל"', async () => {
    const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '17.40', deposits: [['20', 1]] })) } });
    const k = kiosk({ params: ON(s.port) });
    await k.svc.cashMag.probe();
    const r = await k.svc.startPayment(basket());
    const fault = await until(() => k.progress.find((p) => p.phase === 'unknown'));
    expect(fault.cash).toMatchObject({ stage: 'fault', device: 'cashmag', insertedAgorot: 2000 });
    const doc = k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!;
    expect(doc.status).toBe('cancelled');
    expect(doc.voidMeta).toMatchObject({ outcome: 'held', heldAgorot: 2000 });
    const faultSlip = await until(() => k.printed.find((d) => textOf(d).includes('תקלה במזומן — פנו לצוות')));
    expect(textOf(faultSlip)).toContain('"label":"הוכנסו","value":"20.00"');
    expect(k.fresh().pay.usable).not.toContain('cash_device');
    expect(await k.svc.startPayment(basket())).toMatchObject({ ok: false, reason: 'terminal', message: 'תשלום קודם במכשיר המזומן ממתין לבירור. אנא פנו לצוות.' });
    // The manager's screen: the payment to look at, then "טופל".
    (k.svc as unknown as { adminUntil: number }).adminUntil = Date.now() + 60_000;
    const info = k.svc.adminInfo().cashmag!;
    expect(info).toMatchObject({ address: `127.0.0.1:${s.port}`, protocol: 'json (מהענן: jar)', userCodeSet: false, sources: { host: 'cloud', port: 'cloud', terminal: 'default', userCode: 'default' } });
    expect(info.unresolved).toMatchObject([{ outcome: 'held', heldAgorot: 2000, reason: 'HELD' }]);
    expect(await k.svc.adminAction({ type: 'cashmagAcknowledge', txId: info.unresolved[0].txId })).toMatchObject({ ok: true });
    expect(k.svc.adminInfo().cashmag!.unresolved).toEqual([]);
    expect(k.fresh().pay.usable).toContain('cash_device');
  });

  it('the machine another customer’s (claim): the busy screen with "חזרה", then the payment by itself', async () => {
    const s = await server({
      onWelcome: (conn) => conn.signal('signalClaimStateChanged', { ie_claim_state: 3 }),
      handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '0', deposits: [['20', 1], ['10', 1, 2], ['5', 1, 2], ['2', 1, 2], ['0.10', 4, 2]] })) },
    });
    const k = kiosk({ params: ON(s.port) });
    const r = await k.svc.startPayment(basket());
    const busy = await until(() => k.progress.find((p) => p.cash?.stage === 'busy'));
    expect(busy).toMatchObject({ phase: 'starting', canCancel: true, message: 'עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום' });
    expect(s.calls.filter((c) => c.fn === FN.pay)).toHaveLength(0);
    s.live()!.signal('signalClaimStateChanged', { ie_claim_state: 1 });
    await until(() => k.progress.find((p) => p.phase === 'approved'));
    expect(k.svc.ledger.doc(k.svc.orders.get((r as { orderId: string }).orderId)!.transactionId!)!.status).toBe('completed');
  });

  it('the kiosk’s own kiosk.json address wins over the cloud’s', async () => {
    const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '0', deposits: [['37.40', 1]] })) } });
    const k = kiosk({ params: ON(1, { cashmagHost: '10.255.255.1' }), local: { host: '127.0.0.1', port: s.port, terminal: 'קיוסק ליד המכונה' } });
    await k.svc.cashMag.probe();
    expect(k.knocks).toEqual([`127.0.0.1:${s.port}`]);
    await k.svc.startPayment(basket());
    await until(() => k.progress.find((p) => p.phase === 'approved'));
  });

  it('CashMag off (the default): the cash station’s path as before — no knock, no CashMag connection', async () => {
    const s = await server();
    const k = kiosk({ params: { cashmagHost: '127.0.0.1', cashmagPort: s.port } });
    k.svc.cashMag.start();
    await k.svc.cashMag.probe();
    expect(k.knocks).toEqual([]);
    expect(k.svc.cashMag.enabled()).toBe(false);
    // No cash station configured either: the tile is off for the station's own reason.
    expect(k.fresh().pay.cashOff).toBe('מזומן לא מוגדר לקיוסק');
    expect(await k.svc.startPayment(basket())).toMatchObject({ ok: false, reason: 'terminal' });
    expect(s.connections).toBe(0);
    (k.svc as unknown as { adminUntil: number }).adminUntil = Date.now() + 60_000;
    expect(k.svc.adminInfo().cashmag).toBeNull();
  });
});
