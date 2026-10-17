/**
 * "איך המסך מדפיס — דרך קופה בסניף" (pos-server app/services/kds_print.py): a kitchen screen in a browser hands its bon to
 * the cloud relay, and a till of the shop prints it. On this Windows device as that till: the pending job the cloud hands
 * out for a screen's bon (the shared fixture test/fixtures/kds_relay_pending_ticket.json — the server's
 * tests/fixtures copy has the same bytes, server tests/test_kds_relay_print.py) is an ordinary relayed ticket — taken into
 * the kitchen queue, printed once with the screen's lines and its name, answered "done"; handed out again, not printed twice.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KitchenService } from '../src/main/kitchen/kitchenService';
import { TILL_ONLY_JOB_KINDS, kitchenJobsModule } from '../src/main/kitchen/kitchenHost';
import { PrintJobsHost } from '../src/main/printer/printJobsHost';
import { cloudApi, fakeRenderer, FakeCloud, FakeNetPrinter, patientLanCall, patientPrinterLink, printer, PRINT_KEY, tempDb, until } from './support/kitchenFakes';

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const FIXTURE = path.join(__dirname, 'fixtures', 'kds_relay_pending_ticket.json');

/** The fixture with its placeholders filled: the job, the screen and the host's printer. */
function screenJob(jobId: string, printerId: string): Record<string, unknown> {
  const text = readFileSync(FIXTURE, 'utf8')
    .replaceAll('<job>', jobId)
    .replaceAll('<printer>', printerId)
    .replaceAll('<createdAt>', new Date().toISOString())
    .replaceAll('<expiresAt>', new Date(Date.now() + 20_000).toISOString());
  return JSON.parse(text) as Record<string, unknown>;
}

describe('a kitchen screen\'s bon through this till (the cloud relay)', () => {
  it('is an ordinary relayed ticket: printed once with the screen\'s lines and name, answered "done"', async () => {
    const kitchen = await new FakeNetPrinter().listen();
    closers.push(() => kitchen.close());
    const { db, kv } = tempDb();
    const cloud = new FakeCloud();
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
    });
    closers.push(() => k.stop());
    // The till hosts "המדפסת המובנית — 1 · ראשית" (here a network printer it reaches: Windows has no head of its own).
    const config = { printers: [printer({ id: 'own', type: 'cloud', host: '127.0.0.1', port: kitchen.port, hostMachineId: 'windows-host', isHost: true, hostConnection: 'network', inScope: false })] };
    cloud.on('GET sync/windows-host/printers', () => ({ status: 200, body: { syncType: 'full', etag: 'e', printSecret: PRINT_KEY, ...config } }));
    await k.pull(true);

    const job = screenJob('kds-job-1', 'own');
    expect(job.origin).toBe('kds');
    cloud.on('GET sync/windows-host/print-jobs/pending', () => ({ status: 200, body: { jobs: [job] } }));
    const acks: Array<[string, unknown]> = [];
    cloud.on('POST sync/windows-host/print-jobs/*', (b, url) => {
      acks.push([url.pathname.split('/').at(-2)!, b!.status]);
      return { status: 200, body: {} };
    });
    const jobs = new PrintJobsHost({ api: cloudApi(cloud), machineId: () => 'windows-host', decline: TILL_ONLY_JOB_KINDS });
    jobs.register('kitchen', kitchenJobsModule(k));
    expect(await jobs.poll()).toBe(1);
    await k.work();
    await until(() => kitchen.tickets().length === 1);
    await k.sendAcks();
    expect(acks).toEqual([['kds-job-1', 'done']]);
    const drawn = JSON.stringify(renderer.docs.map((d) => d.doc));
    expect(drawn).toContain('המבורגר');
    expect(drawn).toContain('מסך גריל');
    expect(drawn).toContain('בלי בצל');
    // Handed out again (the ack lost): answered as it was, not printed twice.
    expect(await jobs.poll()).toBe(1);
    await k.work();
    expect(kitchen.tickets()).toHaveLength(1);
  });
});
