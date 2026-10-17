/**
 * Run with `npm test`. "דרך קופה בסניף" on the browser screen (docs/SPEC_KDS.md §17): the bon a KDS card sends (the
 * cloud's `TicketIn` — the server's tests/fixtures/kds_relay_pending_ticket.json is what the till gets), the words for
 * where it stands, the how-to per device, and the screen's printer against a pretend cloud — sent with its own id,
 * followed until the till answers, tried again with the same id while offline, a refusal said, "נסו שוב" a new job.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiReply } from './kioskWebApi';
import type { KdsOrder, KdsTask } from './kdsScreenTypes';
import { howToFor, jobPhase, jobText, kdsRelayTicket, relayLine, relayWhyText, type KdsPrintStatus } from './kdsPrint';
import { DONE_SHOWN_MS, KdsRelayPrinter, RESEND_MS, type RelayApi } from './kdsRelayPrinter';

const T0 = Date.UTC(2026, 9, 17, 10, 0, 0);

function task(id: string, extra: Partial<KdsTask> = {}): KdsTask {
  return {
    id, orderId: 'o1', roundNo: 1, stationId: 'grill', stationName: 'גריל', targetKind: 'prep', required: true, lineKey: id,
    name: 'המבורגר', mods: ["צ'דר"], removals: ['בצל'], notes: 'מידיום', allergies: ['גלוטן'], important: true, seat: '2', course: 'עיקריות',
    mealName: null, orderedQty: 2, cancelledQty: 0, preparedQty: 0, activeQty: 2, release: 'released', state: 'queued', version: 3,
    releasedAt: null, startedAt: null, readyAt: null, ...extra,
  };
}

function order(extra: Partial<KdsOrder> = {}): KdsOrder {
  return {
    id: 'o1', source: 'table', displayRef: 'שולחן 12', tableRef: '12', zoneName: 'בר', serviceType: 'eat_in', guests: 2, waiterName: 'דנה',
    pickupName: null, orderNote: 'ליד החלון', pickupNumber: null, workflowMode: 'ORDER_PROCESS', paid: false, status: 'open', priority: 0,
    groupState: 'waiting', readyAt: null, allReady: false, requireExpo: true, requireStart: false, trackHandover: true, viewOnly: false,
    firstReleasedAt: null, createdAt: null, version: 5,
    tasks: [task('t1'), task('t2', { name: 'מבוטל', cancelledQty: 1, activeQty: 0, orderedQty: 1 }), task('t3', { name: 'ממתין', release: 'hold' })],
    changes: [],
    ...extra,
  };
}

const STATION = { id: 'd1', name: 'גריל 1', role: 'station', stations: [{ id: 'grill', name: 'גריל' }] } as never;

describe('the bon a KDS card sends', () => {
  it("a table's: its title and band, the live lines only, as the cloud's TicketIn", () => {
    const t = kdsRelayTicket(order(), { device: STATION, now: new Date(T0) });
    assert.deepEqual(t, {
      source: 'table', tableName: '12', zoneName: 'בר', guests: 2, waiterName: 'דנה', createdAt: new Date(T0).toISOString(), isAddition: false,
      lines: [{ name: 'המבורגר', quantity: 2, notes: 'מידיום', mods: ["צ'דר"], removals: ['בצל'], important: true, allergies: ['גלוטן'], seat: '2', course: 'עיקריות', mealName: null }],
      orderRef: 'שולחן 12', customerName: null, dining: 'eat_in', notice: 'גריל · הערה: ליד החלון',
    });
  });

  it("a kiosk's: a sale headed by its pickup label; an expo screen has no station band", () => {
    const t = kdsRelayTicket(order({ source: 'kiosk', tableRef: null, displayRef: '41', pickupNumber: 41, pickupLabel: 'A-41', serviceType: 'take_away', orderNote: null, guests: null }), {
      device: { id: 'd2', name: 'Expo', role: 'expo', stations: [] } as never,
      now: new Date(T0),
    });
    assert.equal(t.source, 'sale');
    assert.equal(t.tableName, null);
    assert.equal(t.customerName, 'A-41');
    assert.equal(t.dining, 'take_away');
    assert.equal(t.notice, null);
  });

  it('long texts are clipped to what the cloud takes', () => {
    const t = kdsRelayTicket(order({ tasks: [task('t1', { name: 'א'.repeat(300), notes: 'ב'.repeat(900) })] }), { device: null, now: new Date(T0) });
    assert.equal(t.lines[0].name.length, 200);
    assert.equal(t.lines[0].notes?.length, 500);
  });
});

describe('the words', () => {
  it('where a bon stands', () => {
    assert.equal(jobPhase({ status: 'pending' }), 'waiting');
    assert.equal(jobPhase({ status: 'printing' }), 'waiting');
    assert.equal(jobPhase({ status: 'expired' }), 'failed');
    assert.equal(jobText('done', '1 · ראשית'), 'הודפס בקופה 1 · ראשית');
    assert.equal(jobText('waiting', '1 · ראשית'), 'ממתין למדפסת — 1 · ראשית');
    assert.equal(jobText('failed', null, 'expired'), 'לא הודפס — נסו שוב');
    assert.equal(jobText('failed', null, 'אין נייר'), 'לא הודפס — נסו שוב (אין נייר)');
  });

  it('where the bons go, and why not', () => {
    const s: KdsPrintStatus = {
      path: 'relay', effectivePath: 'relay', devicePath: 'bridge', deviceKind: 'ipad', platform: 'web', timeoutSec: 20,
      relay: { ready: true, why: null, automatic: true, hostMachineId: 'h', hostName: '1 · ראשית', hostOnline: false, printerId: null, printerName: 'המדפסת המובנית — 1 · ראשית', connection: 'till' },
    };
    assert.equal(relayLine(s), 'דרך 1 · ראשית · המדפסת המובנית — 1 · ראשית (אוטומטי) — הקופה לא מחוברת כרגע');
    assert.equal(relayLine({ ...s, relay: { ...s.relay!, ready: false, why: 'no_host' } }), 'דרך קופה בסניף — אין בסניף קופה עם מדפסת');
    assert.equal(relayLine({ ...s, effectivePath: 'none' }), 'ללא הדפסה');
    assert.equal(relayWhyText('weird'), 'לא ניתן להדפיס דרך קופה כרגע');
  });

  it('the how-to per device: an iPad only through a till (with Guided Access), Android the app, Windows the bridge or a till', () => {
    const [ipad] = howToFor('ipad');
    assert.equal(ipad.recommended, 'relay');
    assert.ok(ipad.steps.some((x) => x.includes('Guided Access')));
    assert.equal(howToFor('android_browser')[0].recommended, 'app');
    assert.ok(howToFor('windows_browser')[0].steps.some((x) => x.includes('גשר')));
    assert.equal(howToFor(null).length, 3);
  });
});

/* ------------------------------------------------------------- the screen's printer */

type Reply = ApiReply<unknown>;

function cloud() {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const gets: string[] = [];
  let online = true;
  const jobs = new Map<string, Record<string, unknown>>();
  let refuse: string | null = null;
  const status: KdsPrintStatus = {
    path: 'relay', effectivePath: 'relay', devicePath: 'bridge', deviceKind: 'ipad', platform: 'web', timeoutSec: 20,
    relay: { ready: true, why: null, automatic: true, hostMachineId: 'h', hostName: '1 · ראשית', hostOnline: true, printerId: null, printerName: null, connection: 'till' },
  };
  const ok = (body: unknown): Reply => ({ kind: 'ok', status: 200, body, date: null, etag: null });
  const api: RelayApi = {
    get: async (path) => {
      gets.push(path);
      if (!online) return { kind: 'offline', reason: 'x' };
      if (path === 'sync/m1/kds/print') return ok(status);
      if (path.startsWith('sync/m1/kds/print-jobs/status')) {
        const ids = new URL(`http://x/${path}`).searchParams.get('ids')!.split(',');
        return ok({ jobs: ids.map((id) => jobs.get(id)).filter(Boolean) });
      }
      return { kind: 'refused', status: 404, body: null, detail: 'Not Found' };
    },
    post: async (path, body) => {
      posts.push({ path, body: body as Record<string, unknown> });
      if (!online) return { kind: 'offline', reason: 'x' };
      if (refuse) return { kind: 'refused', status: 409, body: { detail: { code: refuse } }, detail: null };
      const id = (body as { id: string }).id;
      const job = jobs.get(id) ?? { id, kind: 'ticket', status: 'pending', error: null, targetMachineName: '1 · ראשית', taken: false };
      jobs.set(id, job);
      return ok(job);
    },
  };
  return {
    api, posts, gets, jobs, status,
    setOnline: (v: boolean) => (online = v),
    setRefuse: (c: string | null) => (refuse = c),
  };
}

function rig() {
  const c = cloud();
  let t = T0;
  let n = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  const p = new KdsRelayPrinter({
    api: c.api,
    machineId: () => 'm1',
    now: () => t,
    uuid: () => `job-${++n}`,
    timers: {
      set: (fn, ms) => {
        const id = timers.length + 1;
        timers.push({ at: t + ms, fn, id });
        return id;
      },
      clear: (id) => {
        const i = timers.findIndex((x) => x.id === id);
        if (i >= 0) timers[i].at = Number.POSITIVE_INFINITY;
      },
    },
  });
  /** Moves the clock and runs what is due. */
  const advance = async (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t)) {
      x.at = Number.POSITIVE_INFINITY;
      x.fn();
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { c, p, advance };
}

const TICKET = kdsRelayTicket(order(), { device: STATION, now: new Date(T0) });

describe("the screen's printer", () => {
  it('sends with its own id, says "ממתין למדפסת", then "הודפס בקופה …", and the line goes by itself', async () => {
    const { c, p, advance } = rig();
    await p.refresh();
    assert.equal(p.canPrint(), true);
    assert.deepEqual(await p.print(TICKET, 'שולחן 12'), { ok: true });
    assert.equal(c.posts[0].path, 'sync/m1/kds/print-jobs');
    assert.deepEqual(c.posts[0].body, { id: 'job-1', ticket: TICKET });
    assert.equal(p.items()[0].text, 'ממתין למדפסת — 1 · ראשית');
    c.jobs.set('job-1', { ...c.jobs.get('job-1'), status: 'done' });
    await advance(2_000);
    assert.equal(p.items()[0].text, 'הודפס בקופה 1 · ראשית');
    await advance(DONE_SHOWN_MS);
    assert.equal(p.items().length, 0);
  });

  it('offline: tried again with the same id; past the wait — "לא הודפס"', async () => {
    const { c, p, advance } = rig();
    await p.refresh();
    c.setOnline(false);
    await p.print(TICKET, 'שולחן 12');
    assert.equal(p.items()[0].phase, 'sending');
    await advance(RESEND_MS);
    assert.deepEqual(c.posts.map((x) => x.body.id), ['job-1', 'job-1']);
    c.setOnline(true);
    await advance(RESEND_MS);
    assert.equal(c.posts.length, 3);
    assert.equal(c.posts[2].body.id, 'job-1');
    assert.equal(p.items()[0].phase, 'waiting');

    const r2 = rig();
    await r2.p.refresh();
    r2.c.setOnline(false);
    await r2.p.print(TICKET, 'שולחן 12');
    for (let i = 0; i < 8; i++) await r2.advance(RESEND_MS);
    assert.equal(r2.p.items()[0].text, 'לא הודפס — נסו שוב (אין חיבור)');
  });

  it('a refusal is said at once; the status is read again', async () => {
    const { c, p } = rig();
    await p.refresh();
    c.setRefuse('host_not_allowed');
    const r = await p.print(TICKET, 'שולחן 12');
    assert.deepEqual(r, { ok: false, message: 'הקופה לא ברשימת הקופות שמותר לשלוח אליהן' });
    assert.equal(p.items()[0].phase, 'failed');
    assert.equal(c.gets.filter((g) => g === 'sync/m1/kds/print').length, 2);
  });

  it('expired at the till: "לא הודפס — נסו שוב"; "נסו שוב" is a new job with the same bon', async () => {
    const { c, p, advance } = rig();
    await p.refresh();
    await p.print(TICKET, 'שולחן 12');
    c.jobs.set('job-1', { ...c.jobs.get('job-1'), status: 'expired', error: 'expired' });
    await advance(2_000);
    const [failed] = p.items();
    assert.equal(failed.text, 'לא הודפס — נסו שוב');
    await p.retry(failed.id);
    assert.deepEqual(c.posts.map((x) => x.body.id), ['job-1', 'job-2']);
    assert.deepEqual(c.posts[1].body.ticket, TICKET);
    assert.deepEqual(p.items().map((i) => i.id), ['job-2']);
  });

  it('a test print sends no ticket', async () => {
    const { c, p } = rig();
    await p.refresh();
    await p.print(null, 'הדפסת בדיקה', { test: true });
    assert.deepEqual(c.posts[0].body, { id: 'job-1', test: true });
    assert.equal(p.items()[0].test, true);
  });
});
