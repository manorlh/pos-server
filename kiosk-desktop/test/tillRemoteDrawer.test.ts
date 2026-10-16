/**
 * Another till's drawer, both ways (P:/specs/bill-print-other-till.md §9ב–§9ג, §10.9) — pos-android RemoteDrawerTest's cases:
 * the cloud's `drawerHosts`, the `drawer` job (who asked, who approved, no image), its answer, the host that opens once per id
 * or says why not; and a document another till sent, printed here as it is. Tests only: a fake cloud, a fake printer.
 */

import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { drawerHostsHere, jobExpired, parameterList, rasterOfGzip, remotePrintSettingsOf, remoteWhy, type DrawerHost } from '../src/core/till/remotePrint';
import { PrintJobsHost, RemoteDrawers, hostDocumentJob, hostDrawerJob, type PendingJob } from '../src/main/till/remoteDrawer';
import { Api } from '../src/main/sync/api';
import { MANAGER_PIN, PIN, harness, type Harness, type HarnessOptions } from './tillEngineHarness';

describe('the parameters and the hosts', () => {
  it('remotePrintEnabled on by default, the timeout 20 s within 5–120, the hosts as a list', () => {
    expect(remotePrintSettingsOf({})).toEqual({ enabled: true, timeoutSec: 20, hosts: [] });
    expect(remotePrintSettingsOf({ remotePrintEnabled: 'כבוי', remotePrintTimeoutSec: '2', remotePrintHosts: '[m-1, "בר"]' })).toEqual({ enabled: false, timeoutSec: 5, hosts: ['m-1', 'בר'] });
    expect(remotePrintSettingsOf({ remotePrintTimeoutSec: 500 }).timeoutSec).toBe(120);
    expect(parameterList('a;b\nc')).toEqual(['a', 'b', 'c']);
    expect(parameterList(null)).toEqual([]);
  });

  it("the tills whose drawer may be opened from here - the cloud's drawerHosts, never this till, within remotePrintHosts", () => {
    const hosts: DrawerHost[] = [
      { machineId: 'm-1', name: 'קופה 1', label: 'קופה 1', printerId: null },
      { machineId: 'm-2', name: 'בר', label: 'בר', printerId: 'p-2' },
      { machineId: 'me', name: 'אני', label: 'אני', printerId: null },
      { machineId: 'm-1', name: 'קופה 1', label: 'קופה 1', printerId: null },
    ];
    expect(drawerHostsHere(hosts, remotePrintSettingsOf({}), 'me').map((h) => h.machineId)).toEqual(['m-1', 'm-2']);
    expect(drawerHostsHere(hosts, remotePrintSettingsOf({ remotePrintHosts: 'בר' }), 'me').map((h) => h.machineId)).toEqual(['m-2']);
    expect(drawerHostsHere(hosts, remotePrintSettingsOf({ remotePrintEnabled: 'false' }), 'me')).toEqual([]);
  });

  it('why it did not open, in words', () => {
    expect(remoteWhy('no_drawer')).toBe('אין מגירה במדפסת שם');
    expect(remoteWhy('host_has_no_drawer')).toBe('אין מגירה במדפסת שם');
    expect(remoteWhy('busy_payment')).toBe('הקופה ההיא באמצע תשלום');
    expect(remoteWhy('timeout')).toBe('לא הודפס בזמן');
    expect(remoteWhy('drawer_remote_off')).toBe('ההגדרות לא מאפשרות להדפיס שם');
    expect(remoteWhy('host_needs_update')).toBe('בקופה ההיא נדרש עדכון גרסה');
    expect(remoteWhy('weird')).toBe('תקלה');
  });

  it('a job past its time is never opened or printed', () => {
    const now = Date.parse('2026-10-16T10:00:30Z');
    expect(jobExpired({ expiresAt: '2026-10-16T10:00:20Z' }, now)).toBe(true);
    expect(jobExpired({ createdAt: '2026-10-16T10:00:00Z', timeoutSec: 20 }, now)).toBe(true);
    expect(jobExpired({ createdAt: '2026-10-16T10:00:00Z', timeoutSec: 60, expiresAt: '2026-10-16T10:01:00Z' }, now)).toBe(false);
  });

  it("a document's raster_gzip picture: exactly its size", () => {
    const rows = Buffer.alloc(2 * 3, 0xff);
    const b64 = gzipSync(rows).toString('base64');
    expect(rasterOfGzip(b64, 16, 3)).toMatchObject({ width: 16, height: 3, rowBytes: 2 });
    expect(rasterOfGzip(b64, 16, 4)).toBeNull();
    expect(rasterOfGzip('not gzip', 16, 3)).toBeNull();
  });
});

/* ------------------------------------------------------------- the wire */

type Call = { method: string; path: string; body: unknown };
function fakeApi(answer: (c: Call) => { status: number; body: unknown } | 'offline') {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const c = { method: init?.method ?? 'GET', path: url.pathname.replace(/^\/api\/v1\//, '') + url.search, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const a = answer(c);
    if (a === 'offline') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { api: new Api('http://localhost:8001/api/v1/', () => 't', fetchFn), calls };
}

const JOB = { id: '00000000-0000-4000-8000-000000000009', reason: 'manual' as const, documentType: null, documentNumber: null, amount: null, reasonCode: 'CHANGE', reasonNote: null, requestedBy: { id: 'u-1', name: 'דנה' }, approvedBy: { id: 'u-9', name: 'רון', method: 'pin' as const }, shiftId: null, sourceMachineId: 'me' };
const HOST: DrawerHost = { machineId: 'm-2', name: 'בר', label: 'בר', printerId: null };

describe('from here: the drawer job and its answer', () => {
  it('the job - its kind, who asked and who approved, no image; done is opened', async () => {
    let polls = 0;
    const { api, calls } = fakeApi((c) => {
      if (c.method === 'POST' && c.path === 'sync/me/print-jobs') return { status: 201, body: { id: JOB.id, status: 'pending' } };
      if (c.path.startsWith('sync/me/print-jobs/status')) return { status: 200, body: { jobs: [{ id: JOB.id, status: ++polls < 2 ? 'printing' : 'done' }] } };
      return { status: 404, body: {} };
    });
    const r = new RemoteDrawers({ api, machineId: () => 'me', params: () => ({}), sleep: async () => undefined });
    await r.open(HOST, JOB);
    const sent = calls[0].body as Record<string, unknown>;
    expect(sent).toEqual({ id: JOB.id, kind: 'drawer', printerId: null, targetMachineId: 'm-2', drawer: { ...JOB, id: undefined } });
    expect(sent).not.toHaveProperty('document');
  });

  it('not opened there: the host\'s reason, the cloud\'s refusal, or no answer in time — taken back', async () => {
    const failed = fakeApi((c) => (c.method === 'POST' ? { status: 201, body: {} } : { status: 200, body: { jobs: [{ id: JOB.id, status: 'failed', error: 'busy_payment' }] } }));
    await expect(new RemoteDrawers({ api: failed.api, machineId: () => 'me', params: () => ({}), sleep: async () => undefined }).open(HOST, JOB)).rejects.toThrow('busy_payment');
    const off = fakeApi(() => ({ status: 409, body: { detail: { code: 'drawer_remote_off' } } }));
    await expect(new RemoteDrawers({ api: off.api, machineId: () => 'me', params: () => ({}) }).open(HOST, JOB)).rejects.toThrow('drawer_remote_off');
    let now = 0;
    const silent = fakeApi((c) => (c.method === 'POST' && c.path.endsWith('/print-jobs') ? { status: 201, body: {} } : { status: 200, body: { jobs: [{ id: JOB.id, status: 'pending' }] } }));
    const r = new RemoteDrawers({ api: silent.api, machineId: () => 'me', params: () => ({ remotePrintTimeoutSec: '5' }), now: () => now, sleep: async () => void (now += 1_000) });
    await expect(r.open(HOST, JOB)).rejects.toThrow('timeout');
    expect(silent.calls.at(-1)).toMatchObject({ method: 'POST', path: `sync/me/print-jobs/${JOB.id}/cancel` });
  });
});

describe('here, as the host', () => {
  const job = (o: Partial<PendingJob> = {}): PendingJob => ({ id: 'j-1', kind: 'drawer', printerId: null, createdAt: '2026-10-16T10:00:00Z', expiresAt: '2026-10-16T10:00:20Z', timeoutSec: 20, drawer: { sourceName: 'קופה 3', requestedBy: { name: 'דנה' } }, ...o });
  const here = (o: { hasDrawer?: boolean; paying?: boolean; nowIso?: string } = {}) => {
    const s = { kicks: 0, notices: [] as string[] };
    return {
      s,
      h: {
        hasDrawer: () => o.hasDrawer ?? true,
        paying: () => o.paying ?? false,
        kick: async () => void (s.kicks += 1),
        now: () => Date.parse(o.nowIso ?? '2026-10-16T10:00:05Z'),
        notice: (t: string) => void s.notices.push(t),
        log: () => undefined,
      },
    };
  };

  it('the host opens only with a drawer, not in a payment of its own, not past its time — and says so', async () => {
    const ok = here();
    expect(await hostDrawerJob(job(), ok.h)).toEqual({ status: 'done' });
    expect(ok.s.kicks).toBe(1);
    expect(ok.s.notices).toEqual(['המגירה נפתחה מקופה 3 (דנה)']);
    expect(await hostDrawerJob(job(), here({ hasDrawer: false }).h)).toEqual({ status: 'failed', error: 'no_drawer' });
    expect(await hostDrawerJob(job(), here({ paying: true }).h)).toEqual({ status: 'failed', error: 'busy_payment' });
    expect(await hostDrawerJob(job(), here({ nowIso: '2026-10-16T10:01:00Z' }).h)).toEqual({ status: 'failed', error: 'expired' });
  });

  it('a drawer job opens once per id however often it is handed out, and every hand-out is answered; other kinds are left alone', async () => {
    let kicks = 0;
    const { api, calls } = fakeApi((c) =>
      c.path === 'sync/me/print-jobs/pending'
        ? { status: 200, body: { jobs: [{ id: 'j-1', kind: 'drawer', createdAt: null, expiresAt: null, drawer: {} }, { id: 't-1', kind: 'ticket', ticket: {} }] } }
        : { status: 200, body: {} },
    );
    const host = new PrintJobsHost({
      api,
      machineId: () => 'me',
      active: () => true,
      handlers: {
        drawer: async () => {
          kicks += 1;
          return { status: 'done' };
        },
      },
    });
    expect(await host.poll()).toBe(1);
    expect(await host.poll()).toBe(1);
    expect(kicks).toBe(1);
    const acks = calls.filter((c) => c.method === 'POST');
    expect(acks.map((c) => [c.path, c.body])).toEqual([
      ['sync/me/print-jobs/j-1/ack', { status: 'done' }],
      ['sync/me/print-jobs/j-1/ack', { status: 'done' }],
    ]);
  });

  it('a document another till sent prints as it is (raster_gzip), once; a broken picture is answered as such', async () => {
    const printed: unknown[] = [];
    const doc = (image: string) => job({ kind: 'document', drawer: null, document: { encoding: 'raster_gzip', widthDots: 16, heightDots: 2, image } });
    const h = { now: () => Date.parse('2026-10-16T10:00:05Z'), decodePng: async () => null, print: async (b: unknown) => void printed.push(b) };
    expect(await hostDocumentJob(doc(gzipSync(Buffer.alloc(4, 0x0f)).toString('base64')), h)).toEqual({ status: 'done' });
    expect(printed).toHaveLength(1);
    expect(await hostDocumentJob(doc('broken'), h)).toEqual({ status: 'failed', error: 'document_image_invalid' });
  });
});

/* -------------------------------------------------------------- the engine */

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

async function till(o: HarnessOptions = {}, pin = PIN) {
  const h = harness(o);
  open.push(h);
  await h.ok('session.login', { pin });
  await h.ok('shift.open', { openingCashAgorot: 0 });
  h.engine.drawer.remote.setHosts([{ machineId: 'm-2', name: 'בר', label: 'בר', printerId: null }]);
  return h;
}

const jobAnswers = (status: 'done' | 'failed' = 'done', error: string | null = null) => {
  const posted: Array<Record<string, unknown>> = [];
  return {
    posted,
    answers: {
      'POST sync/m/print-jobs': (body: Record<string, unknown> | null) => {
        posted.push(body ?? {});
        return { id: body?.id, status: 'pending' };
      },
      'GET sync/m/print-jobs/status': () => ({ jobs: posted.map((p) => ({ id: p.id, status, error })) }),
    },
  };
};

const settle = (ms = 1_300) => new Promise((r) => setTimeout(r, ms));

describe('the till: "פתיחת מגירה ב<קופה>" and a cash payment away from the drawer', () => {
  it('a device with no drawer of its own offers another till\'s; a cashier asks a manager; the job carries both, the log says remote', async () => {
    const j = jobAnswers();
    const h = await till({ parameters: {}, answers: j.answers });
    expect(h.state().drawer!.offered.remote).toBe(true);
    expect(h.state().drawer!.hosts).toEqual([{ id: 'm-2', label: 'בר' }]);
    await h.ok('drawer.openRemote', { machineId: 'm-2', reason: 'CHANGE' });
    const d = h.state().dialog!;
    expect(d.body).toBe('פתיחת מגירה בקופה אחרת — דורש אישור מנהל');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    await settle();
    expect(j.posted).toHaveLength(1);
    expect(j.posted[0]).toMatchObject({ kind: 'drawer', targetMachineId: 'm-2', drawer: { reason: 'manual', reasonCode: 'CHANGE', requestedBy: { id: 'u-cashier' }, approvedBy: { id: 'u-manager', method: 'pin' } } });
    const ev = h.engine.drawer.service.store.event(String(j.posted[0].id))!;
    expect(ev).toMatchObject({ eventType: 'REMOTE_MANUAL', permission: 'CASH_DRAWER.OPEN_REMOTE', result: 'approved', approverId: 'u-manager', details: { remote: true, remoteHost: 'm-2', remoteHostName: 'בר' } });
    expect(h.events.some((e) => e.ev === 'toast' && (e.data as { text: string }).text === 'המגירה נפתחה בבר')).toBe(true);
  });

  it('not opened there: recorded as failed, with why', async () => {
    const j = jobAnswers('failed', 'busy_payment');
    const h = await till({ parameters: {}, answers: j.answers }, MANAGER_PIN);
    await h.ok('drawer.openRemote', { machineId: 'm-2', reason: 'CHANGE' });
    await settle();
    expect(h.engine.drawer.service.store.event(String(j.posted[0].id))).toMatchObject({ result: 'failed', resultReason: 'busy_payment' });
    expect(h.events.some((e) => e.ev === 'toast' && (e.data as { text: string }).text === 'המגירה לא נפתחה בבר: הקופה ההיא באמצע תשלום')).toBe(true);
  });

  it('drawerAwayPolicy remote: the cash payment opens the drawer set — a payment job with the document', async () => {
    const j = jobAnswers();
    const h = await till({ parameters: { drawerAwayPolicy: 'remote', drawerAwayTarget: 'm-2' }, answers: j.answers }, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1_250 });
    await settle();
    expect(j.posted[0]).toMatchObject({ kind: 'drawer', drawer: { reason: 'payment', documentType: '320', amount: 12.5 } });
    expect(h.engine.drawer.service.store.event(String(j.posted[0].id))).toMatchObject({ eventType: 'REMOTE_SALE', result: 'approved' });
  });

  it('as the host: another till\'s drawer job opens this till\'s drawer and is answered', async () => {
    const acks: unknown[] = [];
    const h = await till({
      parameters: { cashDrawer: 'בתשלום מזומן' },
      answers: {
        'GET sync/m/print-jobs/pending': () => ({ jobs: [{ id: 'j-1', kind: 'drawer', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 20_000).toISOString(), timeoutSec: 20, drawer: { sourceName: 'קופה 3', requestedBy: { name: 'דנה' } } }] }),
        'POST sync/m/print-jobs/j-1/ack': (body) => {
          acks.push(body);
          return { id: 'j-1', status: 'done' };
        },
      },
    });
    await h.engine.drawer.host.poll();
    expect(acks).toEqual([{ status: 'done' }]);
    expect(h.printer.sent.filter((b) => b.length === 5 && b[0] === 0x1b && b[1] === 0x70)).toHaveLength(1);
  });
});
