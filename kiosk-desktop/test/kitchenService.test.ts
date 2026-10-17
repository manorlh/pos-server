/**
 * "בונים" from the Windows kiosk and till — the kitchen queue against fake printers, a fake print server and a fake
 * cloud (test/support/kitchenFakes.ts; everything on 127.0.0.1): direct to a network printer with its status read, to the
 * shop's print server over the LAN with the shop's secret (offline too), the cloud relay, the retries, a restart, and
 * never a ticket twice (job ids). The tickets drawn are checked against the shared golden of the designs
 * (server/tests/fixtures/kitchen_ticket_designs_golden.json, the same bytes as pos-android's).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { KitchenService, jobIdOf } from '../src/main/kitchen/kitchenService';
import type { PrinterTarget, Transport } from '../src/main/printer/transports';
import type { KitchenDoc } from '../src/core/kitchen/doc';
import { saleTicket, type KitchenLine, type WireTicket } from '../src/core/kitchen/tickets';
import { layoutText, layoutTicket, TEMPLATES, type TicketStyle } from '../src/core/kitchenTicketStyle';
import { cloudApi, fakeRenderer, FakeCloud, FakeLanHost, FakeNetPrinter, MACHINE, patientLanCall, patientPrinterLink, printer, PRINT_KEY, tempDb, until } from './support/kitchenFakes';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'kitchen_ticket_designs_golden.json');

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function netPrinter(): Promise<FakeNetPrinter> {
  const p = await new FakeNetPrinter().listen();
  closers.push(() => p.close());
  return p;
}

async function lanHost(): Promise<FakeLanHost> {
  const h = await new FakeLanHost().listen();
  closers.push(() => h.close());
  return h;
}

interface Rig {
  k: KitchenService;
  cloud: FakeCloud;
  renderer: ReturnType<typeof fakeRenderer>;
  spool: Transport & { sent: Uint8Array[]; fail: string | null };
  clock: { t: number };
  logs: string[];
}

function rig(o: { params?: Record<string, unknown>; own?: PrinterTarget; onLan?: boolean; db?: ReturnType<typeof tempDb>; cloud?: FakeCloud; orderData?: KitchenServiceOrder } = {}): Rig {
  const { db, kv } = o.db ?? tempDb();
  const cloud = o.cloud ?? new FakeCloud();
  const clock = { t: Date.parse('2026-10-16T10:00:00Z') };
  const renderer = fakeRenderer();
  const logs: string[] = [];
  const spool = {
    sent: [] as Uint8Array[],
    fail: null as string | null,
    async send(_t: PrinterTarget, b: Uint8Array) {
      if (spool.fail) throw new Error(spool.fail);
      spool.sent.push(b);
    },
    status: async () => ({ health: 'ok' as const, detail: null }),
    list: async () => [],
    dispose: () => undefined,
  };
  const k = new KitchenService({
    db,
    kv,
    api: cloudApi(cloud),
    machineId: () => MACHINE,
    params: () => o.params ?? {},
    tillName: () => '2 · בר',
    ownTarget: () => o.own ?? { transport: 'spooler', queueName: 'SNBC BTP-880' },
    transport: spool,
    renderer: () => renderer,
    onLan: () => o.onLan ?? true,
    orderData: o.orderData ? () => o.orderData! : undefined,
    log: (m) => logs.push(m),
    now: () => clock.t,
    random: () => 0,
    printerLink: patientPrinterLink,
    lanCall: patientLanCall,
  });
  closers.push(() => k.stop());
  return { k, cloud, renderer, spool, clock, logs };
}

type KitchenServiceOrder = { courses: Array<{ id: string; name: string; sortOrder?: number | null }>; categories: Array<{ id: string; name?: string | null; parentId?: string | null; sortOrder?: number | null }> };

async function settings(r: Rig, body: Record<string, unknown>) {
  r.cloud.on('GET sync/m/printers', () => ({ status: 200, body: { syncType: 'full', etag: 'e1', printSecret: PRINT_KEY, ...body } }));
  expect(await r.k.pull(true)).toBe(true);
}

const L = (productId: string, categoryId: string | null, name: string, quantity = 1): KitchenLine => ({ productId, categoryId, name, quantity });

function sale(lines: KitchenLine[], over: Partial<WireTicket> = {}): WireTicket {
  return { ...saleTicket({ lines, orderRef: '20000057', waiterName: 'דנה', customerName: null, dining: 'take_away', createdAt: '2026-10-16T10:00:00.000Z' }).ticket, ...over };
}

/** Run the queue until nothing more is due now. */
async function drain(r: Rig) {
  await r.k.work();
}

describe('a network kitchen printer, directly (TCP 9100, the status read before and after)', () => {
  it('each line to its station by category; printed, confirmed, the ticket drawn in the printer\'s design', async () => {
    const kitchen = await netPrinter();
    const bar = await netPrinter();
    const r = rig();
    await settings(r, {
      printers: [printer({ id: 'kitchen', name: 'מטבח', port: kitchen.port, beep: true }), printer({ id: 'bar', name: 'בר', port: bar.port, paperWidth: 58 })],
      categoryRoutes: { 'c-main': ['kitchen'], 'c-drink': ['bar'] },
    });
    const q = r.k.enqueue(sale([L('p-burger', 'c-main', 'המבורגר', 2), L('p-cola', 'c-drink', 'קולה')]), [L('p-burger', 'c-main', 'המבורגר', 2), L('p-cola', 'c-drink', 'קולה')]);
    expect(q.printers).toEqual(['מטבח', 'בר']);
    await drain(r);
    await until(() => kitchen.tickets().length === 1 && bar.tickets().length === 1);
    const jobs = r.k.jobs(q.jobIds);
    expect(jobs.map((j) => [j.printerName, j.state, j.relayVia])).toEqual([
      ['מטבח', 'done', 'printer'],
      ['בר', 'done', 'printer'],
    ]);
    // The bytes: INIT, raster bands, the cut — and the buzzer the kitchen printer asked for.
    const k = kitchen.tickets()[0];
    expect([...k.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(k.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true);
    expect([...k.subarray(k.length - 4)]).toEqual([0x1b, 0x42, 0x03, 0x02]);
    // Each printer's own lines, drawn at its paper (80 → 576, 58 → 384).
    // (The two printers print side by side: in either order.)
    const drawn = r.renderer.docs.map(({ doc, width }) => [(doc as KitchenDoc).printerName, (doc as KitchenDoc).paper, width, (doc as KitchenDoc).ticket.lines.map((l) => l.name)]);
    expect(drawn.sort((a, b) => String(b[0]).localeCompare(String(a[0])))).toEqual([
      ['מטבח', 80, 576, ['המבורגר']],
      ['בר', 58, 384, ['קולה']],
    ]);
  });

  it('copies: one page per copy, "עותק 2 מתוך 2" by the design', async () => {
    const kitchen = await netPrinter();
    const r = rig();
    await settings(r, { printers: [printer({ port: kitchen.port, copies: 2 })], categoryRoutes: { c: ['p-kitchen'] } });
    r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]);
    await drain(r);
    await until(() => kitchen.tickets().length === 2);
    expect(r.renderer.docs.map(({ doc }) => [(doc as KitchenDoc).copy, (doc as KitchenDoc).copies])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('no paper: nothing sent, the ticket waits ("no_paper"), and prints once when the paper is back', async () => {
    const kitchen = await netPrinter();
    kitchen.mood = 'no_paper';
    const r = rig();
    await settings(r, { printers: [printer({ port: kitchen.port })], categoryRoutes: { c: ['p-kitchen'] } });
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    expect(r.k.job(id)).toMatchObject({ state: 'pending', attempts: 1 });
    expect(r.k.job(id)!.lastError).toMatch(/^no_paper/);
    expect(kitchen.tickets()).toHaveLength(0);
    expect(r.k.attention().map((j) => j.id)).toEqual([id]);
    // Not before its backoff.
    await drain(r);
    expect(kitchen.tickets()).toHaveLength(0);
    kitchen.mood = 'ready';
    r.clock.t += 5_000;
    await drain(r);
    await until(() => kitchen.tickets().length === 1);
    expect(r.k.job(id)).toMatchObject({ state: 'done' });
    r.clock.t += 120_000;
    await drain(r);
    expect(kitchen.tickets()).toHaveLength(1);
  });

  it('the paper ran out on the ticket: "uncertain" — never sent again by itself; a person\'s retry goes marked', async () => {
    const kitchen = await netPrinter();
    kitchen.mood = 'paper_out_after';
    const r = rig();
    await settings(r, { printers: [printer({ port: kitchen.port })], categoryRoutes: { c: ['p-kitchen'] } });
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    await until(() => kitchen.tickets().length === 1);
    expect(r.k.job(id)).toMatchObject({ state: 'failed' });
    expect(r.k.job(id)!.lastError).toMatch(/^uncertain/);
    r.clock.t += 600_000;
    await drain(r);
    expect(kitchen.tickets()).toHaveLength(1);
    kitchen.mood = 'ready';
    expect(r.k.retry(id)).toBe(true);
    await drain(r);
    await until(() => kitchen.tickets().length === 2);
    const again = r.renderer.docs.at(-1)!.doc as KitchenDoc;
    expect(again.ticket.notice).toContain('הדפסה חוזרת — ייתכן שכבר הודפס');
  });

  it('a printer that is off waits (retried), and never holds another printer\'s ticket', async () => {
    const bar = await netPrinter();
    const dead = await netPrinter();
    dead.mood = 'off';
    const r = rig();
    await settings(r, { printers: [printer({ id: 'kitchen', port: dead.port }), printer({ id: 'bar', name: 'בר', port: bar.port })], categoryRoutes: { a: ['kitchen'], b: ['bar'] } });
    const k1 = r.k.enqueue(sale([L('x', 'a', 'פסטה')]), [L('x', 'a', 'פסטה')]).jobIds[0];
    const b1 = r.k.enqueue(sale([L('y', 'b', 'בירה')]), [L('y', 'b', 'בירה')]).jobIds[0];
    await drain(r);
    await until(() => bar.tickets().length === 1);
    expect(r.k.job(b1)!.state).toBe('done');
    expect(r.k.job(k1)).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('this device\'s own share (lines no printer takes, tables off) on its own receipt printer through the Windows spooler', async () => {
    const r = rig();
    await settings(r, { printers: [], categoryRoutes: {} });
    const q = r.k.enqueue(sale([L('x', null, 'פסטה')]), [L('x', null, 'פסטה')], { unroutedToTill: true });
    expect(q.printers).toEqual(['קופה']);
    await drain(r);
    expect(r.spool.sent).toHaveLength(1);
    expect(r.k.job(q.jobIds[0])).toMatchObject({ state: 'done', relayVia: null });
  });

  it('the same share on a receipt printer on a COM port (an all-in-one terminal\'s built-in printer)', async () => {
    const r = rig({ own: { transport: 'serial', comPort: 'COM3', baudRate: 19200, flow: 'none' } });
    await settings(r, { printers: [], categoryRoutes: {} });
    const q = r.k.enqueue(sale([L('x', null, 'פסטה')]), [L('x', null, 'פסטה')], { unroutedToTill: true });
    await drain(r);
    expect(r.spool.sent).toHaveLength(1);
    expect(r.k.job(q.jobIds[0])).toMatchObject({ state: 'done' });
  });
});

describe('the shop\'s print server over the LAN — with no internet', () => {
  const serverConfig = (host: FakeLanHost, kitchenPort: number) => ({
    printHost: { machineId: 'android-main', name: 'קופה 1', isSelf: false, lanAddress: '127.0.0.1', port: host.port },
    printers: [printer({ port: kitchenPort })],
    categoryRoutes: { c: ['p-kitchen'] },
  });

  it('handed to the print server with the shop\'s secret (never the cloud), then printed there — asked by its id', async () => {
    const host = await lanHost();
    const kitchen = await netPrinter();
    const r = rig();
    await settings(r, serverConfig(host, kitchen.port));
    r.cloud.online = false;
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')], { idSeed: 'sale:doc-1' }).jobIds;
    await drain(r);
    expect(host.jobs.get(id)).toMatchObject({ times: 1, status: 'pending' });
    const sent = host.jobs.get(id)!.body;
    expect(sent).toMatchObject({ id, printerId: 'p-kitchen', ticket: { source: 'sale', orderRef: '20000057', lines: [{ name: 'פסטה', quantity: 1, productId: 'x', categoryId: 'c' }] }, printer: { id: 'p-kitchen', type: 'network' } });
    expect(host.requests[0].caller).toBe(MACHINE);
    expect(host.unauthorized).toEqual([]);
    expect(kitchen.tickets()).toHaveLength(0);
    expect(r.k.job(id)).toMatchObject({ state: 'relayed', relayVia: 'lan', relayHost: `127.0.0.1:${host.port}` });
    // Asked about it: still waiting, then printed.
    r.clock.t += 5_000;
    await r.k.pollRelayed();
    expect(r.k.job(id)!.state).toBe('relayed');
    host.print(id);
    r.clock.t += 5_000;
    await r.k.pollRelayed();
    expect(r.k.job(id)).toMatchObject({ state: 'done', relayVia: 'lan' });
    expect(r.cloud.calls.filter((c) => c.path.includes('print-jobs'))).toEqual([]);
  });

  it('the print server is down: the printer itself, from here — never also the cloud', async () => {
    const host = await lanHost();
    const port = host.port;
    await host.close();
    closers.pop();
    const kitchen = await netPrinter();
    const r = rig();
    await settings(r, { ...serverConfig({ port } as FakeLanHost, kitchen.port) });
    r.cloud.online = false;
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    await until(() => kitchen.tickets().length === 1);
    expect(r.k.job(id)).toMatchObject({ state: 'done', relayVia: 'printer' });
  });

  it('the print server took it but its answer was lost: never printed here too — the cloud carries it, same id, marked', async () => {
    const host = await lanHost();
    host.mood = 'lose_answer';
    const kitchen = await netPrinter();
    const r = rig();
    await settings(r, serverConfig(host, kitchen.port));
    r.cloud.online = false;
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    expect(host.jobs.get(id)?.times).toBe(1);
    expect(kitchen.tickets()).toHaveLength(0);
    // No cloud: it waits (retried), and is not printed directly on the next tries either.
    expect(r.k.job(id)).toMatchObject({ state: 'pending', attempts: 1 });
    r.cloud.online = true;
    r.cloud.on('POST sync/m/print-jobs', (b) => ({ status: 201, body: { id: b!.id, status: 'pending' } }));
    r.clock.t += 5_000;
    await drain(r);
    expect(kitchen.tickets()).toHaveLength(0);
    const relayed = r.cloud.called('POST sync/m/print-jobs');
    expect(relayed.map((c) => c.body!.id)).toEqual([id]);
    expect((relayed[0].body!.ticket as WireTicket).notice).toBe('הדפסה חוזרת — ייתכן שכבר הודפס');
    expect(r.k.job(id)).toMatchObject({ state: 'relayed', relayVia: 'cloud' });
  });

  it('"not the print server" (any more): the settings pulled again, the ticket on by the next way', async () => {
    const host = await lanHost();
    host.mood = 'not_print_server';
    const kitchen = await netPrinter();
    const r = rig();
    await settings(r, serverConfig(host, kitchen.port));
    const pulls = () => r.cloud.called('GET sync/m/printers').length;
    const before = pulls();
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    await until(() => kitchen.tickets().length === 1 && pulls() === before + 1);
    expect(r.k.job(id)!.state).toBe('done');
  });

  it('the host lost it ("unknown"): sent again under the same id, marked "ייתכן שכבר הודפס"', async () => {
    const host = await lanHost();
    const r = rig();
    await settings(r, serverConfig(host, 9));
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    host.jobs.delete(id);
    r.clock.t += 5_000;
    await r.k.pollRelayed();
    await drain(r);
    expect(host.jobs.get(id)?.times).toBe(1);
    expect((host.jobs.get(id)!.body.ticket as WireTicket).notice).toBe('הדפסה חוזרת — ייתכן שכבר הודפס');
  });

  it('the wrong secret is refused by the host: the ticket goes on by the next way, nothing printed twice', async () => {
    const host = await new FakeLanHost('another-shop-secret').listen();
    closers.push(() => host.close());
    const kitchen = await netPrinter();
    const r = rig();
    await settings(r, serverConfig(host, kitchen.port));
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    await until(() => kitchen.tickets().length === 1);
    expect(host.unauthorized).toEqual(['/kitchen/jobs']);
    expect(host.jobs.size).toBe(0);
    expect(r.k.job(id)!.state).toBe('done');
  });
});

describe('the cloud relay (a printer another till hosts, no LAN way)', () => {
  const relayConfig = { printers: [printer({ id: 'cloud-p', name: 'המדפסת של קופה 3', type: 'cloud', host: null, hostMachineId: 'till-3', hostMachineName: 'קופה 3' })], categoryRoutes: { c: ['cloud-p'] } };

  it('offline: waits and retries; back: relayed once under its own id; asked about until printed', async () => {
    const r = rig();
    await settings(r, relayConfig);
    r.cloud.online = false;
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    expect(r.k.job(id)).toMatchObject({ state: 'pending', attempts: 1 });
    r.clock.t += 5_000;
    await drain(r);
    expect(r.k.job(id)).toMatchObject({ state: 'pending', attempts: 2 });
    r.cloud.online = true;
    let posts = 0;
    r.cloud.on('POST sync/m/print-jobs', (b) => {
      posts++;
      return posts === 1 ? { status: 500, body: {} } : { status: 201, body: { id: b!.id, status: 'pending' } };
    });
    r.clock.t += 10_000;
    await drain(r);
    expect(r.k.job(id)).toMatchObject({ state: 'pending', attempts: 3 });
    r.clock.t += 40_000;
    await drain(r);
    const relayed = r.cloud.called('POST sync/m/print-jobs');
    expect(relayed.map((c) => c.body!.id)).toEqual([id, id]);
    expect(relayed[1].body).toMatchObject({ id, printerId: 'cloud-p', ticket: { source: 'sale', lines: [{ name: 'פסטה' }] } });
    expect(r.k.job(id)).toMatchObject({ state: 'relayed', relayVia: 'cloud' });
    r.cloud.on('GET sync/m/print-jobs/status', () => ({ status: 200, body: { jobs: [{ id, status: 'done', error: null }] } }));
    r.clock.t += 5_000;
    await r.k.pollRelayed();
    expect(r.k.job(id)).toMatchObject({ state: 'done', relayVia: 'cloud' });
  });

  it('refused by the cloud (another device\'s id, an inactive printer): failed for a person, not retried', async () => {
    const r = rig();
    await settings(r, relayConfig);
    r.cloud.on('POST sync/m/print-jobs', () => ({ status: 409, body: { detail: 'printer_inactive' } }));
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    expect(r.k.job(id)).toMatchObject({ state: 'failed', lastError: 'printer_inactive' });
  });
});

describe('never twice, never lost', () => {
  it('the same ticket asked for again (a retried sale, a restart) is the same jobs — printed once', async () => {
    const kitchen = await netPrinter();
    const r = rig();
    await settings(r, { printers: [printer({ port: kitchen.port })], categoryRoutes: { c: ['p-kitchen'] } });
    const a = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')], { idSeed: 'sale:doc-7' });
    const b = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')], { idSeed: 'sale:doc-7' });
    expect(b.jobIds).toEqual(a.jobIds);
    expect(a.jobIds[0]).toBe(jobIdOf('sale:doc-7', 'p-kitchen', 'ticket'));
    await drain(r);
    await until(() => kitchen.tickets().length === 1);
    r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')], { idSeed: 'sale:doc-7' });
    await drain(r);
    expect(kitchen.tickets()).toHaveLength(1);
  });

  it('a restart: a claimed job prints once; one whose bytes were going out waits for a person', async () => {
    const kitchen = await netPrinter();
    const store = tempDb();
    const first = rig({ db: store });
    await settings(first, { printers: [printer({ port: kitchen.port })], categoryRoutes: { c: ['p-kitchen'] } });
    const [claimed] = first.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    const [sendingId] = first.k.enqueue(sale([L('y', 'c', 'סלט')]), [L('y', 'c', 'סלט')]).jobIds;
    // The app died: one claimed (nothing sent yet), one with its bytes on the way.
    store.db.run("UPDATE kitchen_jobs SET state = 'printing', updated_at = 0 WHERE id = ?", claimed);
    store.db.run("UPDATE kitchen_jobs SET state = 'sending', updated_at = 0 WHERE id = ?", sendingId);
    const second = rig({ db: store, cloud: first.cloud });
    second.k.start();
    await second.k.work();
    await until(() => kitchen.tickets().length === 1);
    expect(second.k.job(claimed)!.state).toBe('done');
    expect(second.k.job(sendingId)).toMatchObject({ state: 'failed' });
    expect(second.k.job(sendingId)!.lastError).toMatch(/^uncertain/);
    second.clock.t += 600_000;
    await second.k.work();
    expect(kitchen.tickets()).toHaveLength(1);
  });

  it('the settings and the shop\'s secret survive a restart with no cloud (the secret sealed apart)', async () => {
    const store = tempDb();
    const first = rig({ db: store });
    await settings(first, { printers: [printer({})], categoryRoutes: { c: ['p-kitchen'] } });
    expect(store.kv.getJson<Record<string, unknown>>('kitchen.config')!.printSecret).toBeNull();
    expect(store.kv.get('kitchen.secret')).toBe(PRINT_KEY);
    const second = rig({ db: store });
    second.cloud.online = false;
    expect(second.k.config().printSecret).toBe(PRINT_KEY);
    expect(second.k.config().printers.map((p) => p.id)).toEqual(['p-kitchen']);
    // An unchanged answer (ETag) keeps everything.
    second.cloud.online = true;
    second.cloud.on('GET sync/m/printers', () => ({ status: 200, body: { syncType: 'unchanged', etag: 'e1' } }));
    expect(await second.k.pull(true)).toBe(true);
    expect(second.cloud.calls.at(-1)!.path).toBe('sync/m/printers');
    expect(second.k.config().printers).toHaveLength(1);
  });

  it('"בון לא הודפס": the tickets that need a person go to the cloud, and the one a person handled', async () => {
    const off = await netPrinter();
    off.mood = 'off';
    const r = rig();
    await settings(r, { printers: [printer({ host: '127.0.0.1', port: off.port })], categoryRoutes: { c: ['p-kitchen'] } });
    const [id] = r.k.enqueue(sale([L('x', 'c', 'פסטה')]), [L('x', 'c', 'פסטה')]).jobIds;
    await drain(r);
    r.cloud.on('POST sync/m/kitchen/bon-alerts', () => ({ status: 200, body: { open: 1 } }));
    await r.k.reportBons();
    const sent = r.cloud.called('POST sync/m/kitchen/bon-alerts');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ complete: true, bons: [{ id, state: 'retrying', reason: 'offline', printerId: 'p-kitchen', title: 'הזמנה 20000057', items: 1 }] });
    r.k.discard(id, 'הודפס ידנית', 'דנה');
    await r.k.reportBons();
    expect(r.cloud.called('POST sync/m/kitchen/bon-alerts').at(-1)!.body).toMatchObject({ bons: [{ id, state: 'handled', handledBy: 'דנה', handledNote: 'הודפס ידנית' }] });
  });
});

describe('the shared golden of the designs (kitchen_ticket_designs_golden.json): what the Windows queue draws', () => {
  const gold = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n')) as Record<string, any>) : null; // eslint-disable-line @typescript-eslint/no-explicit-any

  it.skipIf(!gold)('every sample, every design, 58 and 80 mm: the ticket travels as it is and is drawn with every mandatory string', async () => {
    for (const paper of [58, 80] as const) {
      for (const template of TEMPLATES) {
        const kitchen = await netPrinter();
        const host = await lanHost();
        const r = rig({ orderData: gold!.orderData });
        await settings(r, {
          printers: [printer({ id: 'direct', name: 'מטבח', port: kitchen.port, paperWidth: paper, ticketStyle: gold!.styles[template] })],
          categoryRoutes: {},
        });
        for (const s of gold!.samples as Array<{ id: string; printerName: string; copy: number; copies: number; ticket: WireTicket; mustAppear: { all: string[]; byTemplate: Record<string, string[]> } }>) {
          const lines: KitchenLine[] = s.ticket.lines.map((l) => ({ ...l, productId: l.productId ?? 'p', categoryId: l.categoryId ?? null }));
          const { lines: _l, ...head } = s.ticket;
          r.renderer.docs.length = 0;
          r.k.enqueue({ ...head, lines: [] }, lines, { onlyPrinterId: 'direct' });
          await r.k.work();
          expect(r.renderer.docs.length, `${s.id} ${template} ${paper}`).toBe(1);
          const doc = r.renderer.docs[0].doc as KitchenDoc;
          // The printer's style as the cloud resolved it: drawn by it alone.
          expect(doc.style).toEqual(gold!.styles[template] as TicketStyle);
          expect(doc.paper).toBe(paper);
          const said = layoutText(
            layoutTicket(doc.ticket, doc.style, { paper, printerName: s.printerName, copy: s.copy, copies: s.copies, courses: doc.courses, categories: doc.categories, timeZone: gold!.timeZone }),
          );
          for (const must of [...s.mustAppear.all, ...(s.mustAppear.byTemplate[template] ?? [])]) expect(said, `${s.id} · ${template} · ${paper} mm`).toContain(must);
        }
        // Over the LAN the ticket goes as the sample is (the Android print server draws it the same way).
        const viaLan = rig();
        await settings(viaLan, {
          printHost: { machineId: 'android-main', isSelf: false, lanAddress: '127.0.0.1', port: host.port },
          printers: [printer({ id: 'served', port: 9 })],
        });
        const s0 = gold!.samples[0] as { ticket: WireTicket };
        const { lines: _sl, ...head0 } = s0.ticket;
        const [id] = viaLan.k.enqueue({ ...head0, lines: [] }, s0.ticket.lines.map((l) => ({ ...l, productId: l.productId ?? 'p', categoryId: l.categoryId ?? null })), { onlyPrinterId: 'served' }).jobIds;
        await viaLan.k.work();
        const sent = host.jobs.get(id)!.body.ticket as WireTicket;
        // Nulls, false and empty lists are the same as absent to the DTO; a line's routing keys are this test's own.
        const strip = (o: unknown): unknown =>
          Array.isArray(o)
            ? o.map(strip)
            : o && typeof o === 'object'
              ? Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== null && v !== false && !(Array.isArray(v) && v.length === 0) && k !== 'productId' && k !== 'categoryId').map(([k, v]) => [k, strip(v)]))
              : o;
        expect(strip(sent)).toEqual(strip(s0.ticket));
      }
    }
  }, 60_000);
});
