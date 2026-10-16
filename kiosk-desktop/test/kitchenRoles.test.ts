/**
 * "בונים" from both Windows roles, end to end over a real KioskService (temp data dir) with fake printers, a fake print
 * server and a fake cloud (test/support/kitchenFakes.ts):
 *
 *  - the kiosk: a paid BON order's bon to the shop's kitchen printers by the routing — with no internet too — and
 *    through the shop's print server on the LAN; as before when the shop has no kitchen printer;
 *  - the till: "בונים במכירה" after a counter sale (the lines no printer takes said to the cashier); the KDS release
 *    (`source: quick`) and a KDS-only shop's fallback tickets;
 *  - this device as the shop's print server / a printer's host: other devices' tickets over the LAN (the shop's secret)
 *    and from the cloud relay, each id printed once and answered.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrintDoc } from '../src/core/printDocs';
import type { KitchenDoc } from '../src/core/kitchen/doc';
import type { WireTicket } from '../src/core/kitchen/tickets';
import { saleDispatchId } from '../src/main/kiosk/kdsRelease';
import { KitchenHost, TILL_ONLY_JOB_KINDS, kitchenJobsModule } from '../src/main/kitchen/kitchenHost';
import { PrintJobsHost } from '../src/main/printer/printJobsHost';
import { KitchenService } from '../src/main/kitchen/kitchenService';

import type { PaymentProvider, SaleResult } from '../src/main/payment/provider';
import type { Transport } from '../src/main/printer/transports';
import { KioskService } from '../src/main/service';
import type { PayProgress, StartPaymentIn } from '../src/shared/bridge';
import { cloudApi, fakeRenderer, FakeCloud, FakeLanHost, FakeNetPrinter, MACHINE, patientLanCall, patientPrinterLink, printer, PRINT_KEY, tempDb, until } from './support/kitchenFakes';
import { harness, PIN } from './tillEngineHarness';

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function netPrinter(): Promise<FakeNetPrinter> {
  const p = await new FakeNetPrinter().listen();
  closers.push(() => p.close());
  return p;
}


/* ======================================================================= the kiosk */

const APPROVED: SaleResult = { answer: 'APPROVED', raw: '', card: { brand: 'visa', last4: '4242', authNum: '0123456', uid: 'u-1', payments: null, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'x' } } };

function kiosk(cloud: FakeCloud, printing: Record<string, unknown>, lan?: { onLan: boolean }) {
  const docs: PrintDoc[] = [];
  const logs: string[] = [];
  const own: number[] = [];
  const transport: Transport = {
    send: async (_t, bytes) => void own.push(bytes.length),
    status: async () => ({ health: 'ok', detail: null }),
    list: async () => [],
    dispose: () => undefined,
  };
  let seq = 0;
  const provider: PaymentProvider = {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
    newReference: () => `ref${++seq}`,
    check: async () => ({ ok: true, detail: null }),
    sale: async () => APPROVED,
    resolve: async () => ({ kind: 'unknown', message: 'no answer' }),
    abort: async () => undefined,
  };
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-kitchen-kiosk-')),
    appVersion: '0.5.2',
    deviceInfo: { platform: 'windows' },
    transport,
    fetch: cloud.fetch,
    providers: [() => provider],
    renderer: async (doc) => {
      docs.push(doc);
      return { width: 16, height: 2, rgba: new Uint8Array(16 * 2 * 4).fill(255) };
    },
    downloader: async () => {
      throw new Error('no network');
    },
    kitchen: { printerLink: patientPrinterLink, lanCall: patientLanCall, onLan: () => lan?.onLan ?? true },
    log: (m) => logs.push(m),
  });
  closers.push(() => svc.stop());
  svc.cloud.setCredentials({ serverUrl: 'http://cloud.test', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://cloud.test');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4' });
  svc.cloud.applyCatalog({
    syncType: 'full',
    serverTime: 'x',
    machineCatalog: { mode: 'all' },
    categories: [
      { id: 'c-main', name: 'עיקריות', isActive: true },
      { id: 'c-drink', name: 'שתייה', isActive: true },
    ],
    products: [
      { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, sku: '1001' },
      { id: 'p-cola', name: 'קולה', price: 10, categoryId: 'c-drink', inStock: true, isAvailable: true, sku: '2001' },
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
      payment: { methods: ['card'], receiptPolicy: 'never', tipEnabled: false },
      pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 },
      printing: { pickupSlip: false, ...printing },
    },
  });
  svc.cloud.setSettings({ settings: {}, businessInfo: { companyName: 'רויאל בר', vatNumber: '515151515' }, settingsUpdatedAt: '2026-10-16T09:00:00Z', serverTime: null });
  svc.cloud.setParameters({}, null);
  svc.applyProvider();
  const progress: PayProgress[] = [];
  svc.on('pay', (p: PayProgress) => progress.push(p));
  const inner = svc as unknown as { offlineNow: boolean; viewDirty: boolean };
  return { svc, docs, own, progress, inner, logs };
}

const basket = (over: Partial<StartPaymentIn> = {}): StartPaymentIn => ({
  lines: [
    { key: 'L1', productId: 'p-burger', qty: 2, options: [], notes: ['מדיום'] },
    { key: 'L2', productId: 'p-cola', qty: 1, options: [], notes: [] },
  ],
  service: 'take_away',
  customerName: 'דנה',
  customerPhone: null,
  tableRef: null,
  tipPct: null,
  tipAgorot: null,
  ...over,
});

async function sell(k: ReturnType<typeof kiosk>) {
  const r = await k.svc.startPayment(basket());
  expect(r.ok).toBe(true);
  const orderId = (r as { orderId: string }).orderId;
  await until(() => !!k.progress.find((p) => p.orderId === orderId && p.phase === 'approved'));
  return orderId;
}

describe('the Windows kiosk\'s bon on the shop\'s kitchen printers', () => {
  it('with no internet: each station gets its lines, headed by the pickup number; printed, the order says so', async () => {
    const kitchen = await netPrinter();
    const bar = await netPrinter();
    const cloud = new FakeCloud();
    cloud.on('GET sync/m/printers', () => ({
      status: 200,
      body: {
        syncType: 'full',
        etag: 'e',
        printSecret: PRINT_KEY,
        printers: [printer({ id: 'kitchen', name: 'מטבח', port: kitchen.port }), printer({ id: 'bar', name: 'בר', port: bar.port })],
        categoryRoutes: { 'c-main': ['kitchen'], 'c-drink': ['bar'] },
      },
    }));
    const k = kiosk(cloud, { bonMode: 'routing', bonOnKiosk: false });
    expect(await k.svc.kitchen.pull(true)).toBe(true);
    cloud.online = false;
    k.inner.offlineNow = true;
    const orderId = await sell(k);
    await k.svc.kitchen.work();
    await until(() => kitchen.tickets().length === 1 && bar.tickets().length === 1);
    const kitchenDocs = k.docs.filter((d): d is KitchenDoc => d.kind === 'kitchen');
    const byPrinter = Object.fromEntries(kitchenDocs.map((d) => [d.printerName, d.ticket]));
    expect(byPrinter['מטבח']).toMatchObject({ source: 'sale', customerName: 'הזמנה K-1 · דנה', dining: 'take_away', waiterName: 'קיוסק Windows', lines: [{ name: 'המבורגר', quantity: 2, notes: 'מדיום' }] });
    expect(byPrinter['בר']).toMatchObject({ lines: [{ name: 'קולה', quantity: 1 }] });
    // Nothing on the kiosk's own printer: "בון מטבח במדפסת הקיוסק" is off.
    expect(k.own).toEqual([]);
    const o = k.svc.orders.get(orderId)!;
    expect(o.bonJobIds).toHaveLength(2);
    expect(o.bonStatus).toBe('printed');
    // Asked again (a restart, a second look): never a second bon.
    k.svc.printBon(orderId, false);
    await k.svc.kitchen.work();
    expect(kitchen.tickets()).toHaveLength(1);
  });

  it('through the shop\'s print server on the LAN (no internet): handed over with the shop\'s secret, the order waits for its word', async () => {
    const host = await new FakeLanHost().listen();
    closers.push(() => host.close());
    const cloud = new FakeCloud();
    cloud.on('GET sync/m/printers', () => ({
      status: 200,
      body: {
        syncType: 'full',
        etag: 'e',
        printSecret: PRINT_KEY,
        printHost: { machineId: 'android-main', name: 'קופה 1', isSelf: false, lanAddress: '127.0.0.1', port: host.port },
        printers: [printer({ id: 'kitchen', name: 'מטבח', port: 9 })],
        categoryRoutes: { 'c-main': ['kitchen'], 'c-drink': ['kitchen'] },
      },
    }));
    const k = kiosk(cloud, { bonMode: 'routing' });
    await k.svc.kitchen.pull(true);
    cloud.online = false;
    k.inner.offlineNow = true;
    const orderId = await sell(k);
    await k.svc.kitchen.work();
    const [id] = k.svc.orders.get(orderId)!.bonJobIds;
    expect(host.jobs.get(id), k.logs.join(' | ')).toMatchObject({ times: 1 });
    expect((host.jobs.get(id)!.body.ticket as WireTicket).lines.map((l) => l.name)).toEqual(['המבורגר', 'קולה']);
    expect(k.svc.orders.get(orderId)!.bonStatus).toBe('queued');
    host.print(id);
    await k.svc.kitchen.pollRelayed().catch(() => undefined);
    // Due a question only after its poll interval: asked when due.
    const job = k.svc.kitchen.job(id)!;
    expect(job.state === 'relayed' || job.state === 'done').toBe(true);
  });

  it('no kitchen printer in the shop: as before — off, no bon; "בון מטבח במדפסת הקיוסק" on, on its own printer', async () => {
    const cloud = new FakeCloud();
    cloud.on('GET sync/m/printers', () => ({ status: 200, body: { syncType: 'full', etag: 'e', printers: [], categoryRoutes: {} } }));
    const off = kiosk(cloud, { bonOnKiosk: false });
    await off.svc.kitchen.pull(true);
    const a = await sell(off);
    expect(off.svc.orders.get(a)!.bonStatus).toBe('none');
    const on = kiosk(cloud, { bonOnKiosk: true });
    await on.svc.kitchen.pull(true);
    const b = await sell(on);
    await until(() => on.docs.some((d) => d.kind === 'bon'));
    expect(on.svc.orders.get(b)!.bonJobIds).toHaveLength(1);
    expect(on.docs.some((d) => d.kind === 'kitchen')).toBe(false);
  });
});

/* ======================================================================= the till */

describe('the Windows till\'s counter sale ("בונים במכירה", the KDS)', () => {
  const printersAnswer = (port: number) => () => ({
    syncType: 'full',
    etag: 'e',
    printSecret: PRINT_KEY,
    printers: [printer({ id: 'kitchen', name: 'מטבח', port })],
    categoryRoutes: { 'c-main': ['kitchen'] },
  });

  async function cashSale(h: ReturnType<typeof harness>) {
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 5450 });
    return h.state().checkout;
  }

  it('the tickets after the sale, headed by its number and the cashier; the lines no printer takes said to the cashier', async () => {
    const kitchen = await netPrinter();
    const h = harness({ parameters: { kitchenTicketsOnSale: true, tablesMode: 'lan' }, answers: { 'GET sync/m/printers': printersAnswer(kitchen.port) } });
    closers.push(() => h.stop());
    const renderer = fakeRenderer();
    h.svc.printQueue.setRenderer(renderer);
    await h.svc.kitchen.pull(true);
    const c = await cashSale(h);
    expect(c.kitchenWarning).toBe('פריטים שלא נותבו למדפסת: קולה');
    await h.svc.kitchen.work();
    await until(() => kitchen.tickets().length === 1);
    const doc = renderer.docs.find((d) => d.doc.kind === 'kitchen')!.doc as KitchenDoc;
    expect(doc.ticket).toMatchObject({ source: 'sale', orderRef: c.documentRef, waiterName: 'דנה כהן', sourceName: '2 · קופה 2', lines: [{ name: 'המבורגר', quantity: 1, productId: 'p-burger', categoryId: 'c-main' }] });
  });

  it('"בונים במכירה" off (the default): no ticket', async () => {
    const kitchen = await netPrinter();
    const h = harness({ answers: { 'GET sync/m/printers': printersAnswer(kitchen.port) } });
    closers.push(() => h.stop());
    await h.svc.kitchen.pull(true);
    await cashSale(h);
    expect(h.svc.kitchen.attention()).toEqual([]);
    expect(h.svc.kitchen.jobsFor(h.state().checkout.documentId!)).toEqual([]);
  });

  it('the KDS beside the printer: the release (source quick, one id per document) and the tickets as before', async () => {
    const kitchen = await netPrinter();
    const releases: Array<Record<string, unknown>> = [];
    const h = harness({
      parameters: { kitchenTicketsOnSale: true, kdsEnabled: true, workflowTargets: 'printer,kds' },
      answers: {
        'GET sync/m/printers': printersAnswer(kitchen.port),
        'POST sync/m/kds/release': (b) => {
          releases.push(b!);
          return { accepted: true, tasksCreated: 1 };
        },
      },
    });
    closers.push(() => h.stop());
    h.svc.printQueue.setRenderer(fakeRenderer());
    await h.svc.kitchen.pull(true);
    const c = await cashSale(h);
    await h.svc.kitchenKds.run();
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ id: saleDispatchId(c.documentId!), source: 'quick', sourceRef: c.documentId, trigger: 'payment', paid: true, transactionNumber: c.documentRef, actorName: 'דנה כהן' });
    expect((releases[0].items as Array<{ name: string }>).map((i) => i.name)).toEqual(['המבורגר', 'קולה']);
    await h.svc.kitchen.work();
    await until(() => kitchen.tickets().length === 1);
    expect(h.svc.kitchenKds.entries()).toEqual([]);
  });

  it('KDS only: the tickets wait held; the KDS took it — they go; the KDS did not — printed as its fallback, flagged', async () => {
    const kitchen = await netPrinter();
    let kds: 'take' | 'refuse' = 'take';
    const h = harness({
      parameters: { kdsEnabled: true, workflowTargets: 'kds' },
      answers: {
        'GET sync/m/printers': printersAnswer(kitchen.port),
        'POST sync/m/kds/release': () => (kds === 'take' ? { accepted: true, tasksCreated: 2 } : { accepted: false, reason: 'kds_disabled' }),
      },
    });
    closers.push(() => h.stop());
    const renderer = fakeRenderer();
    h.svc.printQueue.setRenderer(renderer);
    await h.svc.kitchen.pull(true);
    const first = await cashSale(h);
    const held = h.svc.kitchen.jobsFor(first.documentId!);
    expect(held.map((j) => j.state)).toEqual(['held']);
    await h.svc.kitchenKds.run();
    expect(h.svc.kitchen.jobsFor(first.documentId!)).toEqual([]);
    await h.ok('checkout.finish');
    kds = 'refuse';
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 4200 });
    const second = h.state().checkout;
    await h.svc.kitchenKds.run();
    await h.svc.kitchen.work();
    await until(() => kitchen.tickets().length === 1);
    const doc = renderer.docs.find((d) => d.doc.kind === 'kitchen')!.doc as KitchenDoc;
    expect(doc.ticket.notice).toBe('גיבוי KDS');
    expect(h.svc.kitchen.jobsFor(second.documentId!).map((j) => j.state)).toEqual(['done']);
  });
});

/* ======================================================================= this device as the print host */

describe('this Windows device as the shop\'s print server / a printer\'s host', () => {
  function hostRig(config: Record<string, unknown>, cloud = new FakeCloud(), store = tempDb(), clock?: { t: number }) {
    const { db, kv } = store;
    const renderer = fakeRenderer();
    const logs: string[] = [];
    const k = new KitchenService({
      db,
      kv,
      api: cloudApi(cloud),
      machineId: () => 'windows-host',
      params: () => ({}),
      tillName: () => '1 · ראשית',
      ownTarget: () => ({ transport: 'none' }),
      transport: { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined },
      renderer: () => renderer,
      onLan: () => true,
      log: (m) => logs.push(m),
      printerLink: patientPrinterLink,
      lanCall: patientLanCall,
      now: clock ? () => clock.t : undefined,
    });
    cloud.on('GET sync/m/printers', () => ({ status: 200, body: { syncType: 'full', etag: 'e', printSecret: PRINT_KEY, ...config } }));
    // The host's own machine id in the cloud's paths.
    cloud.on('GET sync/windows-host/printers', () => ({ status: 200, body: { syncType: 'full', etag: 'e', printSecret: PRINT_KEY, ...config } }));
    const host = new KitchenHost({ kitchen: k, api: cloudApi(cloud), machineId: () => 'windows-host', lanAddress: () => '127.0.0.1', log: (m) => logs.push(m), hostname: '127.0.0.1', portOverride: 0 });
    closers.push(() => host.stop());
    closers.push(() => k.stop());
    return { k, host, cloud, renderer, logs };
  }

  it('takes the others\' tickets over the LAN with the shop\'s secret, prints each id once, answers their status', async () => {
    const kitchen = await netPrinter();
    const h = hostRig({ hostsLan: true, printHost: { machineId: 'windows-host', isSelf: true, lanAddress: '127.0.0.1', port: 8399 }, printers: [printer({ id: 'kitchen', port: kitchen.port, isHost: true })] });
    await h.k.pull(true);
    await h.host.apply();
    const port = h.host.listening()!;
    expect(port, `${h.logs.join(' | ')} | ${JSON.stringify(h.k.config().printHost)} ${h.host.hosting()}`).toBeGreaterThan(0);
    const target = { address: '127.0.0.1', port };
    const job = { id: 'android-job-1', printerId: 'kitchen', ticket: { source: 'table', tableName: '12', createdAt: '2026-10-16T10:00:00Z', lines: [{ name: 'פסטה', quantity: 2 }] } };
    expect((await patientLanCall(target, 'wrong', 'POST', '/kitchen/jobs', job)).status).toBe(401);
    expect((await patientLanCall(target, PRINT_KEY, 'GET', '/kitchen/ping', null)).body).toEqual({ ok: true, machineId: 'windows-host' });
    expect((await patientLanCall(target, PRINT_KEY, 'POST', '/kitchen/jobs', job)).body).toMatchObject({ id: 'android-job-1', status: 'pending' });
    // Sent again (its answer lost on the sender's side): the same job.
    await patientLanCall(target, PRINT_KEY, 'POST', '/kitchen/jobs', job);
    await h.k.work();
    await until(() => kitchen.tickets().length === 1);
    expect((await patientLanCall(target, PRINT_KEY, 'GET', '/kitchen/jobs/status?ids=android-job-1,nope', null)).body).toEqual({
      jobs: [
        { id: 'android-job-1', status: 'done', error: null },
        { id: 'nope', status: 'unknown', error: null },
      ],
    });
    // A document (another till's bill) is not printed by this build: refused, the sender prints it itself.
    expect((await patientLanCall(target, PRINT_KEY, 'POST', '/kitchen/jobs', { id: 'd1', printerId: 'kitchen', kind: 'document', document: {} })).status).toBe(404);
  });

  it('Windows to Windows: a kiosk hands its bon to the Windows print server, which prints it; the kiosk hears "done"', async () => {
    const kitchen = await netPrinter();
    const server = hostRig({ hostsLan: true, printHost: { machineId: 'windows-host', isSelf: true, lanAddress: '127.0.0.1', port: 8399 }, printers: [printer({ id: 'kitchen', port: kitchen.port, isHost: true })] });
    await server.k.pull(true);
    await server.host.apply();
    const { db, kv } = tempDb();
    const cloud = new FakeCloud();
    cloud.on('GET sync/m/printers', () => ({
      status: 200,
      body: { syncType: 'full', etag: 'e', printSecret: PRINT_KEY, printHost: { machineId: 'windows-host', isSelf: false, lanAddress: '127.0.0.1', port: server.host.listening() }, printers: [printer({ id: 'kitchen', port: kitchen.port })], categoryRoutes: { c: ['kitchen'] } },
    }));
    let t = Date.now();
    const senderLogs: string[] = [];
    const sender = new KitchenService({
      db,
      kv,
      api: cloudApi(cloud),
      machineId: () => MACHINE,
      params: () => ({}),
      tillName: () => 'קיוסק',
      ownTarget: () => ({ transport: 'none' }),
      transport: { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined },
      renderer: () => fakeRenderer(),
      onLan: () => true,
      log: (m) => senderLogs.push(m),
      now: () => t,
      lanCall: patientLanCall,
    });
    closers.push(() => sender.stop());
    await sender.pull(true);
    cloud.online = false;
    const [id] = sender.enqueue({ source: 'sale', createdAt: new Date().toISOString(), customerName: 'הזמנה K7', lines: [] }, [{ productId: 'x', categoryId: 'c', name: 'שקשוקה', quantity: 1 }]).jobIds;
    await sender.work();
    expect(sender.job(id), senderLogs.join(' | ')).toMatchObject({ state: 'relayed', relayVia: 'lan' });
    await server.k.work();
    await until(() => kitchen.tickets().length === 1);
    t += 5_000;
    await sender.pollRelayed();
    expect(sender.job(id)).toMatchObject({ state: 'done' });
  });

  it('the cloud relay\'s jobs for it: printed once, answered; handed out again (the ack lost) — answered, not printed twice', async () => {
    const kitchen = await netPrinter();
    const h = hostRig({ printers: [printer({ id: 'mine', type: 'cloud', host: '127.0.0.1', port: kitchen.port, hostMachineId: 'windows-host', isHost: true, hostConnection: 'network' })] });
    await h.k.pull(true);
    const pending = { id: 'relay-1', kind: 'ticket', printerId: 'mine', ticket: { source: 'sale', createdAt: '2026-10-16T10:00:00Z', customerName: 'הזמנה A-3', lines: [{ name: 'טוסט', quantity: 1 }] } };
    h.cloud.on('GET sync/windows-host/print-jobs/pending', () => ({ status: 200, body: { jobs: [pending] } }));
    const acks: Array<[string, unknown]> = [];
    h.cloud.on('POST sync/windows-host/print-jobs/*', (b, url) => {
      acks.push([url.pathname.split('/').at(-2)!, b!.status]);
      return { status: 200, body: {} };
    });
    // The device's one print-jobs poller, with the kitchen's part only (no till working here).
    const jobs = new PrintJobsHost({ api: cloudApi(h.cloud), machineId: () => 'windows-host', decline: TILL_ONLY_JOB_KINDS });
    jobs.register('kitchen', kitchenJobsModule(h.k));
    expect(await jobs.poll()).toBe(1);
    // Taken into the kitchen queue: answered by the queue once printed, not by the poller now.
    expect(acks).toEqual([]);
    await h.k.work();
    await until(() => kitchen.tickets().length === 1);
    await h.k.sendAcks();
    expect(acks).toEqual([['relay-1', 'done']]);
    // The cloud hands it out again (it never heard the ack): answered "done" again — not printed again.
    expect(await jobs.poll()).toBe(1);
    await h.k.work();
    expect(kitchen.tickets()).toHaveLength(1);
    expect(acks).toEqual([
      ['relay-1', 'done'],
      ['relay-1', 'done'],
    ]);
    // A document for this device, which does not work as a till: answered failed at once (the sender prints it itself).
    h.cloud.on('GET sync/windows-host/print-jobs/pending', () => ({ status: 200, body: { jobs: [{ id: 'doc-1', kind: 'document', document: { image: '' } }] } }));
    await jobs.poll();
    expect(acks.at(-1)).toEqual(['doc-1', 'failed']);
  });

  it('a host that starts again holds what it took for the others until it knows it is still their print server', async () => {
    const kitchen = await netPrinter();
    const hosting = { hostsLan: true, printHost: { machineId: 'windows-host', isSelf: true, lanAddress: '127.0.0.1', port: 8399 }, printers: [printer({ id: 'kitchen', port: kitchen.port, isHost: true })] };
    const moved = { hostsLan: false, printHost: { machineId: 'android-2', isSelf: false, lanAddress: '10.0.0.9', port: 8399 }, printers: [printer({ id: 'kitchen', port: kitchen.port, isHost: false })] };
    const job = (id: string) => ({ id, printerId: 'kitchen', ticket: { source: 'table', tableName: '4', createdAt: '2026-10-16T10:00:00Z', lines: [{ name: 'סלט', quantity: 1 }] } });
    // Taken over the LAN, then the till went down before it printed them.
    const store = tempDb();
    const before = hostRig(hosting, new FakeCloud(), store);
    await before.k.pull(true);
    expect(before.k.acceptLan(job('j-still')).status).toBe(200);
    expect(before.k.acceptLan(job('j-moved')).status).toBe(200);
    before.k.stop();

    // Back, and still the print server: printed once the settings say so — not before.
    const clock = { t: Date.now() + 1_000 };
    const still = hostRig(hosting, new FakeCloud(), store, clock);
    still.k.start();
    await still.k.work();
    expect(kitchen.tickets()).toHaveLength(0);
    await still.k.pull(true);
    await still.k.work();
    await until(() => kitchen.tickets().length === 2);
    still.k.stop();

    // Back, and the print server moved while it was down: never printed here (its sender sends it to the new one).
    const store2 = tempDb();
    const b2 = hostRig(hosting, new FakeCloud(), store2);
    await b2.k.pull(true);
    b2.k.acceptLan(job('j-x'));
    b2.k.stop();
    const after = hostRig(moved, new FakeCloud(), store2, { t: Date.now() + 1_000 });
    after.k.start();
    await after.k.pull(true);
    await after.k.work();
    expect(after.k.job('j-x')).toMatchObject({ state: 'failed', dismissed: 1, lastError: 'the print server moved while this till was down — its till sends it again' });
    expect(after.k.lanStatuses(['j-x']).jobs[0]).toMatchObject({ status: 'failed' });

    // No cloud at all: printed after the wait, as always.
    const store3 = tempDb();
    const b3 = hostRig(hosting, new FakeCloud(), store3);
    await b3.k.pull(true);
    b3.k.acceptLan(job('j-y'));
    b3.k.stop();
    const offlineClock = { t: Date.now() + 1_000 };
    const cloudless = new FakeCloud();
    cloudless.online = false;
    const alone = hostRig(hosting, cloudless, store3, offlineClock);
    alone.k.start();
    await alone.k.work();
    expect(alone.k.job('j-y')!.state).toBe('pending');
    offlineClock.t += 90_000;
    await alone.k.work();
    await until(() => kitchen.tickets().length === 3);
  });
});
