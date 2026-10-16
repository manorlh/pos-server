/**
 * The device's ONE print-jobs poller (main/printer/printJobsHost.ts): the till's drawers and documents and the kitchen's
 * tickets on the same look, each kind to the module that prints it — never one module answering "failed" for another's
 * kind — once per id, at the pace the modules that want the jobs ask for. And on a real KioskService with the till working:
 * one poller, the kitchen's part and the till's part both on it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TILL_ONLY_JOB_KINDS, kitchenJobsModule } from '../src/main/kitchen/kitchenHost';
import { IDLE_RECHECK_MS, PrintJobsHost, type JobOutcome, type PendingJob, type PrintJobsModule } from '../src/main/printer/printJobsHost';
import { Api } from '../src/main/sync/api';
import { harness, PIN, type Harness } from './tillEngineHarness';

type Call = { method: string; path: string; body: unknown };

function fakeApi(jobs: () => unknown[]) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const c = { method: init?.method ?? 'GET', path: url.pathname.replace(/^\/api\/v1\//, '') + url.search, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const body = c.method === 'GET' && c.path === 'sync/me/print-jobs/pending' ? { jobs: jobs() } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { api: new Api('http://localhost:8001/api/v1/', () => 't', fetchFn), calls };
}

const acksOf = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => [c.path.split('/').at(-2), c.body]);
const looks = (calls: Call[]) => calls.filter((c) => c.method === 'GET').length;

/** A module that records what it was handed and answers as told. */
function module(o: { wanted?: () => boolean; everyMs?: number; kinds: string[]; answer?: (job: PendingJob) => JobOutcome; afterPoll?: () => Promise<void> }) {
  const seen: string[] = [];
  const m: PrintJobsModule = {
    wanted: o.wanted ?? (() => true),
    everyMs: o.everyMs ?? 4_000,
    handlers: Object.fromEntries(
      o.kinds.map((k) => [
        k,
        async (job: PendingJob) => {
          seen.push(`${job.kind}:${job.id}`);
          return o.answer ? o.answer(job) : { status: 'done' as const };
        },
      ]),
    ),
    afterPoll: o.afterPoll,
  };
  return { m, seen };
}

const JOBS = [
  { id: 'd-1', kind: 'drawer', drawer: {} },
  { id: 'doc-1', kind: 'document', document: {} },
  { id: 't-1', kind: 'ticket', ticket: { lines: [] }, printerId: 'k' },
  { id: 'x-1', kind: 'label' },
];

describe('one poller for every kind', () => {
  it('one look hands each kind to its module: the till its drawer and document, the kitchen its ticket; an unknown kind is left alone', async () => {
    const { api, calls } = fakeApi(() => JOBS);
    const host = new PrintJobsHost({ api, machineId: () => 'me', decline: TILL_ONLY_JOB_KINDS });
    const till = module({ kinds: ['drawer', 'document'] });
    let acksSent = 0;
    const kitchen = module({
      kinds: ['ticket', 'test'],
      everyMs: 10_000,
      answer: () => ({ status: 'taken' }),
      afterPoll: async () => {
        acksSent += 1;
      },
    });
    host.register('till', till.m);
    host.register('kitchen', kitchen.m);
    expect(await host.poll()).toBe(3);
    expect(looks(calls)).toBe(1);
    expect(till.seen).toEqual(['drawer:d-1', 'document:doc-1']);
    expect(kitchen.seen).toEqual(['ticket:t-1']);
    // The ticket is the kitchen queue's to answer (once printed); nothing answers "failed" for another module's kind.
    expect(acksOf(calls)).toEqual([
      ['d-1', { status: 'done' }],
      ['doc-1', { status: 'done' }],
    ]);
    expect(acksSent).toBe(1);
  });

  it('an id handed out again is answered as it was — the drawer opened once; the kitchen ties it to its own job', async () => {
    const { api, calls } = fakeApi(() => JOBS.slice(0, 3));
    const host = new PrintJobsHost({ api, machineId: () => 'me', decline: TILL_ONLY_JOB_KINDS });
    const till = module({ kinds: ['drawer', 'document'], answer: (j) => (j.kind === 'document' ? { status: 'failed', error: 'printer_error: paper' } : { status: 'done' }) });
    const kitchen = module({ kinds: ['ticket'], answer: () => ({ status: 'taken' }) });
    host.register('till', till.m);
    host.register('kitchen', kitchen.m);
    await host.poll();
    await host.poll();
    expect(till.seen).toEqual(['drawer:d-1', 'document:doc-1']);
    expect(kitchen.seen).toEqual(['ticket:t-1', 'ticket:t-1']);
    expect(acksOf(calls)).toEqual([
      ['d-1', { status: 'done' }],
      ['doc-1', { status: 'failed', error: 'printer_error: paper' }],
      ['d-1', { status: 'done' }],
      ['doc-1', { status: 'failed', error: 'printer_error: paper' }],
    ]);
  });

  it('a device not working as a till: a drawer or a document is answered "failed" at once (the sender falls back); the kitchen still takes its ticket', async () => {
    const { api, calls } = fakeApi(() => JOBS);
    const host = new PrintJobsHost({ api, machineId: () => 'me', decline: TILL_ONLY_JOB_KINDS });
    const till = module({ kinds: ['drawer', 'document'], wanted: () => false });
    const kitchen = module({ kinds: ['ticket'], answer: () => ({ status: 'taken' }) });
    host.register('till', till.m);
    host.register('kitchen', kitchen.m);
    await host.poll();
    expect(till.seen).toEqual([]);
    expect(kitchen.seen).toEqual(['ticket:t-1']);
    expect(acksOf(calls)).toEqual([
      ['d-1', { status: 'failed', error: 'drawer not printed by this device' }],
      ['doc-1', { status: 'failed', error: 'document not printed by this device' }],
    ]);
  });

  it('a till that hosts no kitchen printer leaves a relayed ticket alone (the cloud hands it out again after its lease)', async () => {
    const { api, calls } = fakeApi(() => JOBS);
    const host = new PrintJobsHost({ api, machineId: () => 'me', decline: TILL_ONLY_JOB_KINDS });
    const till = module({ kinds: ['drawer', 'document'] });
    const kitchen = module({ kinds: ['ticket'], wanted: () => false });
    host.register('till', till.m);
    host.register('kitchen', kitchen.m);
    await host.poll();
    expect(kitchen.seen).toEqual([]);
    expect(acksOf(calls).map(([id]) => id)).toEqual(['d-1', 'doc-1']);
  });

  it('nobody wants the jobs (a kiosk hosting nothing): no call at all; offline: none either', async () => {
    const { api, calls } = fakeApi(() => JOBS);
    let online = true;
    const host = new PrintJobsHost({ api, machineId: () => 'me', active: () => online, decline: TILL_ONLY_JOB_KINDS });
    host.register('till', module({ kinds: ['drawer'], wanted: () => false }).m);
    expect(await host.poll()).toBe(0);
    host.register('kitchen', module({ kinds: ['ticket'], answer: () => ({ status: 'taken' }) }).m);
    online = false;
    expect(await host.poll()).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a module taken out is out: an older registration never removes a newer one of the same owner', async () => {
    const { api } = fakeApi(() => JOBS.slice(0, 1));
    const host = new PrintJobsHost({ api, machineId: () => 'me' });
    const a = module({ kinds: ['drawer'] });
    const b = module({ kinds: ['drawer'] });
    const offA = host.register('till', a.m);
    host.register('till', b.m);
    offA();
    await host.poll();
    expect(a.seen).toEqual([]);
    expect(b.seen).toEqual(['drawer:d-1']);
  });

  it('looks at the pace the modules want: the till every 4 s, a kitchen host alone every 10 s, nobody — no call', () => {
    const { api } = fakeApi(() => []);
    const host = new PrintJobsHost({ api, machineId: () => 'me' });
    let tillOn = true;
    let kitchenOn = true;
    host.register('till', module({ kinds: ['drawer'], wanted: () => tillOn, everyMs: 4_000 }).m);
    host.register('kitchen', module({ kinds: ['ticket'], wanted: () => kitchenOn, everyMs: 10_000 }).m);
    expect(host.pace()).toBe(4_000);
    tillOn = false;
    expect(host.pace()).toBe(10_000);
    kitchenOn = false;
    expect(host.pace()).toBe(IDLE_RECHECK_MS);
  });

  it('started, it looks by itself and stops when told', async () => {
    const { api, calls } = fakeApi(() => []);
    const host = new PrintJobsHost({ api, machineId: () => 'me', handlers: { drawer: async () => ({ status: 'done' }) } });
    host.start(20);
    try {
      for (let i = 0; i < 100 && looks(calls) < 2; i++) await new Promise((r) => setTimeout(r, 20));
      expect(looks(calls)).toBeGreaterThanOrEqual(2);
    } finally {
      host.stop();
    }
    const at = looks(calls);
    await new Promise((r) => setTimeout(r, 120));
    expect(looks(calls)).toBeLessThanOrEqual(at + 1);
  });
});

describe('on the device: one poller for the till and the kitchen', () => {
  const open: Harness[] = [];
  afterEach(() => {
    for (const h of open.splice(0)) h.stop();
  });

  it("the till's drawer handler and the kitchen's ticket handler are on the service's one poller", async () => {
    const pending = () => ({
      jobs: [
        { id: 'j-1', kind: 'drawer', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 20_000).toISOString(), timeoutSec: 20, drawer: { sourceName: 'קופה 3' } },
        { id: 't-9', kind: 'ticket', printerId: 'nope', ticket: { source: 'sale', lines: [{ name: 'טוסט', quantity: 1 }] } },
      ],
    });
    const acks: Array<[string, unknown]> = [];
    const h = harness({
      parameters: { cashDrawer: 'בתשלום מזומן' },
      answers: {
        'GET sync/m/print-jobs/pending': pending,
        'POST sync/m/print-jobs/*': (body) => {
          acks.push(['?', body]);
          return {};
        },
      },
    });
    open.push(h);
    await h.ok('session.login', { pin: PIN });
    // The drawer's module is the service's one poller's.
    expect(h.engine.drawer.host).toBe(h.svc.printJobs);
    // The kitchen hosts nothing here: its ticket is left for its lease; the drawer job opens this till's drawer.
    expect(await h.svc.printJobs.poll()).toBe(1);
    expect(acks).toEqual([['?', { status: 'done' }]]);
    // Its handlers, as the kitchen's module gives them: a ticket for a printer this device does not know is refused.
    const k = kitchenJobsModule(h.svc.kitchen);
    expect(k.wanted()).toBe(false);
    expect(await k.handlers.ticket!({ id: 't-9', kind: 'ticket', printerId: 'nope', createdAt: null, expiresAt: null, timeoutSec: null, raw: pending().jobs[1] })).toEqual({
      status: 'failed',
      error: 'printer unknown on host',
    });
  });
});
