/**
 * "הדפסה בקופה אחרת" — the sender's side (P:/specs/bill-print-other-till.md §3–§5, §7א, §10.3–§10.6): pos-android
 * RemotePrintPolicyTest, RemoteDocumentFlowTest, RemoteDocumentImageTest and RemoteDestinationChoiceTest's cases, and the
 * Windows till's wiring — a receipt that goes to another till's printer by the cloud's settings, as an image, by the same id
 * on the LAN and through the cloud; the fallback here. Tests only: a fake cloud, a fake LAN, a fake printer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { decodeMonoPng, encodeMonoPng } from '../src/core/monoPng';
import { parsePrinter, type KitchenPrinter } from '../src/core/kitchen/config';
import {
  REMOTE_DOC_TEXT,
  RemoteDocumentFlow,
  documentJobOf,
  pageCategory,
  remoteAllows,
  remoteDestinationsOf,
  remoteDocSettingsOf,
  remoteFallbackOf,
  remoteImageWidthDots,
  remoteJobStateOf,
  remoteRouteOf,
  type DocumentJob,
  type RemoteDestination,
  type RemoteDocSettings,
  type RemoteDocumentTransport,
  type RemoteHandOver,
  type RemoteHost,
  type RemoteJobState,
  type RemotePrintFeedback,
} from '../src/core/till/remoteDocuments';
import { remoteWhy } from '../src/core/till/remotePrint';
import type { LanCall } from '../src/main/kitchen/kitchenNet';
import { DEFAULT_PRINTER_KEY, TILL_PRINTER_KEY } from '../src/main/till/tillRemotePrint';
import { PIN, harness, type Harness } from './tillEngineHarness';

const settings = (over: Partial<RemoteDocSettings> = {}): RemoteDocSettings => ({ ...remoteDocSettingsOf({}), ...over });

describe('the parameters (§7א)', () => {
  it('no parameter set - the defaults, which change nothing', () => {
    expect(remoteDocSettingsOf({})).toEqual({ enabled: true, timeoutSec: 20, hosts: [], documents: 'bill', fallback: 'ask', notice: true, fromDashboard: true });
  });

  it('each parameter as the parameters pull keeps it', () => {
    const s = remoteDocSettingsOf({
      remotePrintEnabled: 'false',
      remotePrintDocuments: 'bill_receipts',
      remotePrintFallback: 'local',
      remotePrintTimeoutSec: '45',
      remotePrintNotice: 'false',
      remotePrintHosts: '[m-bar,m-counter]',
      remotePrintFromDashboard: 'false',
    });
    expect(s).toEqual({ enabled: false, documents: 'bill_receipts', fallback: 'local', timeoutSec: 45, notice: false, hosts: ['m-bar', 'm-counter'], fromDashboard: false });
    expect(remoteDocSettingsOf({ remotePrintDocuments: 'ALL' }).documents).toBe('all');
    expect(remoteDocSettingsOf({ remotePrintFallback: 'none' }).fallback).toBe('none');
  });

  it('unknown values fall back, the timeout is kept between 5 and 120 seconds', () => {
    expect(remoteDocSettingsOf({ remotePrintDocuments: 'everything' }).documents).toBe('bill');
    expect(remoteDocSettingsOf({ remotePrintFallback: '?' }).fallback).toBe('ask');
    expect(remoteDocSettingsOf({ remotePrintEnabled: 'maybe' }).enabled).toBe(true);
    expect(remoteDocSettingsOf({ remotePrintTimeoutSec: '1' }).timeoutSec).toBe(5);
    expect(remoteDocSettingsOf({ remotePrintTimeoutSec: '600' }).timeoutSec).toBe(120);
    expect(remoteDocSettingsOf({ remotePrintTimeoutSec: '30.0' }).timeoutSec).toBe(30);
    expect(remoteDocSettingsOf({ remotePrintTimeoutSec: 'soon' }).timeoutSec).toBe(20);
  });

  it('remotePrintDocuments - which documents may go to another till', () => {
    const bill = settings({ documents: 'bill' });
    expect(remoteAllows(bill, 'bill')).toBe(true);
    expect(remoteAllows(bill, 'bill', true)).toBe(true);
    for (const k of ['receipt', 'credit', 'report', 'other'] as const) expect(remoteAllows(bill, k)).toBe(false);
    const receipts = settings({ documents: 'bill_receipts' });
    expect(remoteAllows(receipts, 'receipt')).toBe(true);
    expect(remoteAllows(receipts, 'receipt', true)).toBe(false);
    expect(remoteAllows(receipts, 'credit')).toBe(false);
    expect(remoteAllows(receipts, 'report')).toBe(false);
    const all = settings({ documents: 'all' });
    for (const k of ['bill', 'receipt', 'credit', 'report', 'other'] as const) expect(remoteAllows(all, k)).toBe(true);
    expect(remoteAllows(all, 'receipt', true)).toBe(true);
    const off = settings({ enabled: false, documents: 'all' });
    for (const k of ['bill', 'receipt', 'credit', 'report', 'other'] as const) expect(remoteAllows(off, k)).toBe(false);
  });

  it("the category the cloud checks, the image's width, the fallback, a status and the reasons", () => {
    expect(pageCategory({ kind: 'bill', copy: true })).toBe('bill');
    expect(pageCategory({ kind: 'receipt' })).toBe('receipt');
    expect(pageCategory({ kind: 'receipt', copy: true })).toBe('other');
    expect(pageCategory({ kind: 'credit' })).toBe('other');
    expect(remoteImageWidthDots(58)).toBe(384);
    expect(remoteImageWidthDots(80)).toBe(576);
    expect(remoteImageWidthDots(0)).toBe(576);
    expect(remoteFallbackOf('ask', true)).toBe('ask');
    expect(remoteFallbackOf('local', true)).toBe('print_here');
    expect(remoteFallbackOf('none', true)).toBe('notice');
    for (const m of ['ask', 'local', 'none'] as const) expect(remoteFallbackOf(m, false)).toBe('notice');
    expect(remoteJobStateOf('done', null, true)).toEqual({ kind: 'printed' });
    expect(remoteJobStateOf('failed', 'no_paper', false)).toEqual({ kind: 'failed', reason: 'no_paper' });
    expect(remoteJobStateOf('expired', null, false)).toEqual({ kind: 'failed', reason: 'expired' });
    expect(remoteJobStateOf('pending', null, true)).toEqual({ kind: 'waiting' });
    expect(remoteJobStateOf('printing', 'no_paper', false)).toEqual({ kind: 'waiting' });
    expect(remoteJobStateOf(null, null, false)).toEqual({ kind: 'waiting' });
    expect(remoteJobStateOf('unknown', null, true)).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(remoteJobStateOf('unknown', null, false)).toEqual({ kind: 'waiting' });
    expect(remoteWhy('no_paper: מדפסת הקופה')).toBe('אין נייר במדפסת');
    expect(remoteWhy('document_not_remote')).toBe('ההגדרות לא מאפשרות להדפיס שם');
    expect(remoteWhy('document_too_large')).toBe('המסמך גדול מדי');
    expect(remoteWhy('not_sent')).toBe('הקופה לא הושגה');
    expect(REMOTE_DOC_TEXT.askTitle('בר')).toBe('לא הודפס בבר — להדפיס כאן?');
    expect(REMOTE_DOC_TEXT.dest('בר')).toBe('המדפסת של בר');
  });
});

/* ------------------------------------------------------------------ the image */

describe('the page as the host gets it (MonoPng)', () => {
  it('a 1-bit grey PNG of the dots, and back — the padding white', () => {
    const width = 13;
    const height = 3;
    const rowBytes = 2;
    const data = Uint8Array.of(0b10100000, 0b00001000, 0xff, 0xf8, 0, 0);
    const png = encodeMonoPng({ width, height, rowBytes, data });
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    // IHDR: the size, bit depth 1, grey.
    expect(png.readUInt32BE(16)).toBe(13);
    expect(png.readUInt32BE(20)).toBe(3);
    expect(png[24]).toBe(1);
    expect(png[25]).toBe(0);
    const back = decodeMonoPng(png);
    expect(back).toEqual({ width, height, rowBytes, data });
  });

  it('a long receipt is a few kilobytes', () => {
    const width = 576;
    const height = 3000;
    const rowBytes = 72;
    const data = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y += 24) data.fill(0xff, y * rowBytes, y * rowBytes + rowBytes);
    expect(encodeMonoPng({ width, height, rowBytes, data }).length).toBeLessThan(20_000);
  });

  it('only a 1-bit grey PNG is read', () => {
    expect(() => decodeMonoPng(Buffer.from('not a png'))).toThrow();
  });
});

/* ------------------------------------------------------------------ the destinations */

const cloudPrinter = (over: Record<string, unknown> = {}): KitchenPrinter =>
  parsePrinter({ id: 'p-bar', name: 'מדפסת בר', purpose: 'receipt', type: 'cloud', hostMachineId: 'm-bar', hostMachineName: 'בר', paperWidth: 80, scope: 'shop', isHost: false, inScope: false, ...over })!;

describe('the destinations (remoteDestinationsOf)', () => {
  it("another till's cloud receipt printers, never this one's, within remotePrintHosts, not a host needing an update", () => {
    const printers = [
      cloudPrinter(),
      cloudPrinter({ id: 'p-mine', hostMachineId: 'me', hostMachineName: 'אני' }),
      cloudPrinter({ id: 'p-old', hostMachineId: 'm-old', hostMachineName: 'ישנה', hostDocumentRelay: false }),
      cloudPrinter({ id: 'p-host', isHost: true }),
      cloudPrinter({ id: 'p-kitchen', purpose: 'kitchen' }),
      cloudPrinter({ id: 'p-net', type: 'network', host: '10.0.0.9' }),
      cloudPrinter({ id: 'p-58', hostMachineId: 'm-58', hostMachineName: 'דלפק', paperWidth: 58, scope: 'machine', cashDrawer: true }),
    ];
    const d = remoteDestinationsOf(printers, settings(), 'me');
    expect(d.map((x) => x.id)).toEqual(['p-58', 'p-bar']);
    expect(d[0]).toMatchObject({ name: 'המדפסת של דלפק', assigned: true, host: { paperWidth: 58, drawer: true, machineId: 'm-58' } });
    expect(d[1].assigned).toBe(false);
    expect(remoteDestinationsOf(printers, settings({ hosts: ['בר'] }), 'me').map((x) => x.id)).toEqual(['p-bar']);
    expect(remoteDestinationsOf(printers, settings({ enabled: false }), 'me')).toEqual([]);
  });

  const host = (id: string, assigned: boolean): RemoteDestination => ({ id, name: `המדפסת של ${id}`, assigned, host: { printerId: id, machineId: `m-${id}`, machineName: id, paperWidth: 80, lanAddress: null, lanPort: null, drawer: null } });

  it("a till with a printer of its own: another till's printer never brings the question by itself", () => {
    const shop = [host('a', false), host('b', false)];
    expect(remoteRouteOf({ hasOwn: true, destinations: shop, eligible: true })).toEqual({ kind: 'local' });
    // The cloud assigned one to this very till: there.
    expect(remoteRouteOf({ hasOwn: true, destinations: [host('a', false), host('m', true)], eligible: true })).toMatchObject({ kind: 'remote', destination: { id: 'm' } });
    // Not eligible (remotePrintDocuments): as before, even when assigned or chosen.
    expect(remoteRouteOf({ hasOwn: true, destinations: [host('m', true)], eligible: false, tillChoice: 'm' })).toEqual({ kind: 'local' });
    // This till's own choice over the cloud's assignment; "מדפסת הקופה"; "לשאול בכל פעם".
    expect(remoteRouteOf({ hasOwn: true, destinations: [host('a', false), host('m', true)], eligible: true, tillChoice: 'a' })).toMatchObject({ kind: 'remote', destination: { id: 'a' } });
    expect(remoteRouteOf({ hasOwn: true, destinations: [host('m', true)], eligible: true, tillChoice: 'local' })).toEqual({ kind: 'local' });
    expect(remoteRouteOf({ hasOwn: true, destinations: shop, eligible: true, tillChoice: 'ask' })).toEqual({ kind: 'ask', choices: [{ id: 'local', name: 'מדפסת הקופה' }, ...shop.map((d) => ({ id: d.id, name: d.name }))] });
    // A remembered default: there; one remembered local keeps the till's own over an assigned one.
    expect(remoteRouteOf({ hasOwn: true, destinations: shop, eligible: true, defaultId: 'b' })).toMatchObject({ kind: 'remote', destination: { id: 'b' } });
    expect(remoteRouteOf({ hasOwn: true, destinations: [host('m', true)], eligible: true, defaultId: 'local' })).toEqual({ kind: 'local' });
    // A chosen printer that is gone: as if nothing were chosen.
    expect(remoteRouteOf({ hasOwn: true, destinations: shop, eligible: true, tillChoice: 'gone' })).toEqual({ kind: 'local' });
  });

  it('a till with no printer of its own: its choice, else the one assigned to it, else asked', () => {
    const shop = [host('a', false), host('b', false)];
    expect(remoteRouteOf({ hasOwn: false, destinations: shop, eligible: true })).toEqual({ kind: 'ask', choices: shop.map((d) => ({ id: d.id, name: d.name })) });
    expect(remoteRouteOf({ hasOwn: false, destinations: [host('a', false), host('m', true)], eligible: true })).toMatchObject({ kind: 'remote', destination: { id: 'm' } });
    expect(remoteRouteOf({ hasOwn: false, destinations: shop, eligible: true, defaultId: 'b' })).toMatchObject({ kind: 'remote', destination: { id: 'b' } });
    expect(remoteRouteOf({ hasOwn: false, destinations: [host('m', true)], eligible: true, tillChoice: 'ask' }).kind).toBe('ask');
    expect(remoteRouteOf({ hasOwn: false, destinations: shop, eligible: false })).toEqual({ kind: 'local' });
  });

  it('the job: the image, the reference, the target', () => {
    const target: RemoteHost = { printerId: null, machineId: 'm-bar', machineName: 'בר', paperWidth: 58, lanAddress: null, lanPort: null, drawer: null };
    const job = documentJobOf('j-1', target, { width: 384, height: 40 }, 'AAA', { kind: 'receipt', number: '1043', title: 'חשבונית מס קבלה 1043' }, 'm-me');
    expect(job).toEqual({
      id: 'j-1',
      kind: 'document',
      printerId: null,
      targetMachineId: 'm-bar',
      document: { category: 'receipt', type: 'receipt', number: '1043', copy: false, title: 'חשבונית מס קבלה 1043', paperWidth: 58, widthDots: 384, heightDots: 40, encoding: 'png', image: 'AAA', sourceMachineId: 'm-me' },
    });
  });
});

/* ------------------------------------------------------------------ the flow (RemoteDocumentFlowTest) */

const HOST: RemoteHost = { printerId: 'p-bar', machineId: 'm-bar', machineName: 'בר', paperWidth: 80, lanAddress: null, lanPort: null, drawer: null };
const JOB: DocumentJob = documentJobOf('j-1', HOST, { width: 8, height: 1 }, 'AQID', { kind: 'bill' }, 'm-me');

class Transport implements RemoteDocumentTransport {
  sent: DocumentJob[] = [];
  asked = 0;
  withdrawCalls = 0;
  constructor(
    public states: RemoteJobState[] = [{ kind: 'printed' }],
    public refuse: Error | null = null,
    public withdrawn = false,
  ) {}
  async handOver(_t: RemoteHost, job: DocumentJob): Promise<RemoteHandOver> {
    if (this.refuse) throw this.refuse;
    this.sent.push(job);
    return { id: job.id, via: 'lan', endpoint: { address: '10.0.0.5', port: 8399 } };
  }
  async state(): Promise<RemoteJobState> {
    return this.states[Math.min(this.asked++, this.states.length - 1)];
  }
  async withdraw(): Promise<boolean> {
    this.withdrawCalls++;
    return this.withdrawn;
  }
}

class Feedback implements RemotePrintFeedback {
  said: string[] = [];
  constructor(public answer = true) {}
  sent(h: string) {
    this.said.push(`sent:${h}`);
  }
  printed(h: string) {
    this.said.push(`printed:${h}`);
  }
  printedHere(h: string, r: string | null) {
    this.said.push(`here:${h}:${r}`);
  }
  failed(h: string, r: string | null) {
    this.said.push(`failed:${h}:${r}`);
  }
  async askPrintHere(h: string, r: string | null) {
    this.said.push(`ask:${h}:${r}`);
    return this.answer;
  }
}

class Clock {
  sleeps: number[] = [];
  constructor(public now = 1_000_000) {}
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.now += ms;
  };
}

const flow = (t: Transport, f: Feedback, c: Clock) => new RemoteDocumentFlow(t, f, () => c.now, c.sleep, 1_000);
const local = (ok = true) => {
  const l = { pages: 0, print: async () => (l.pages++, ok) };
  return l;
};

describe('the way of one document (RemoteDocumentFlow)', () => {
  it('handed over and printed - sent, then printed, nothing printed here', async () => {
    const t = new Transport([{ kind: 'waiting' }, { kind: 'printed' }]);
    const f = new Feedback();
    const c = new Clock();
    const l = local();
    const fl = flow(t, f, c);
    const handed = await fl.handOver(HOST, JOB, settings());
    expect(handed.ok).toBe(true);
    expect(t.sent).toEqual([JOB]);
    expect(await fl.follow((handed as { handed: RemoteHandOver }).handed, HOST, settings(), c.now, l.print)).toBe('printed');
    expect(f.said).toEqual(['sent:בר', 'printed:בר']);
    expect(l.pages).toBe(0);
    expect(t.withdrawCalls).toBe(0);
  });

  it('remotePrintNotice off - no sent, no printed, a failure is still said', async () => {
    const s = settings({ notice: false, fallback: 'none' });
    const f = new Feedback();
    const c = new Clock();
    const ok = flow(new Transport(), f, c);
    const handed = await ok.handOver(HOST, JOB, s);
    const h = (handed as { handed: RemoteHandOver }).handed;
    expect(await ok.follow(h, HOST, s, c.now, null)).toBe('printed');
    expect(f.said).toEqual([]);
    expect(await flow(new Transport([{ kind: 'failed', reason: 'no_paper' }]), f, c).follow(h, HOST, s, c.now, null)).toBe('not_printed');
    expect(f.said).toEqual(['failed:בר:no_paper']);
  });

  it('failed there, ask - yes prints here, no leaves it', async () => {
    const s = settings({ fallback: 'ask' });
    const handed: RemoteHandOver = { id: 'j-1', via: 'cloud' };
    const yes = new Feedback(true);
    const l = local();
    const c = new Clock();
    expect(await flow(new Transport([{ kind: 'failed', reason: 'no_paper' }]), yes, c).follow(handed, HOST, s, c.now, l.print)).toBe('printed_here');
    expect(l.pages).toBe(1);
    expect(yes.said).toEqual(['ask:בר:no_paper', 'here:בר:no_paper']);
    const no = new Feedback(false);
    const untouched = local();
    expect(await flow(new Transport([{ kind: 'failed', reason: 'cover_open' }]), no, c).follow(handed, HOST, s, c.now, untouched.print)).toBe('not_printed');
    expect(untouched.pages).toBe(0);
    expect(no.said).toEqual(['ask:בר:cover_open']);
  });

  it("failed there, local - printed here by itself; this till's printer failing too is said", async () => {
    const s = settings({ fallback: 'local' });
    const f = new Feedback();
    const l = local();
    const c = new Clock();
    expect(await flow(new Transport([{ kind: 'failed', reason: 'printer_error' }]), f, c).follow({ id: 'j', via: 'lan' }, HOST, s, c.now, l.print)).toBe('printed_here');
    expect(l.pages).toBe(1);
    expect(f.said).toEqual(['here:בר:printer_error']);
    const f2 = new Feedback();
    expect(await flow(new Transport([{ kind: 'failed', reason: 'no_paper' }]), f2, c).follow({ id: 'j', via: 'cloud' }, HOST, s, c.now, local(false).print)).toBe('not_printed');
    expect(f2.said).toEqual(['failed:בר:no_paper']);
  });

  it('failed there, none - only said, nothing printed here', async () => {
    const f = new Feedback();
    const l = local();
    const c = new Clock();
    expect(await flow(new Transport([{ kind: 'failed', reason: 'no_paper' }]), f, c).follow({ id: 'j', via: 'cloud' }, HOST, settings({ fallback: 'none' }), c.now, l.print)).toBe('not_printed');
    expect(l.pages).toBe(0);
    expect(f.said).toEqual(['failed:בר:no_paper']);
  });

  it('not printed within remotePrintTimeoutSec - taken back, then the fallback', async () => {
    const s = settings({ timeoutSec: 20, fallback: 'local' });
    const t = new Transport([{ kind: 'waiting' }], null, true);
    const f = new Feedback();
    const l = local();
    const c = new Clock();
    const started = c.now;
    expect(await flow(t, f, c).follow({ id: 'j', via: 'cloud' }, HOST, s, started, l.print)).toBe('printed_here');
    expect(t.asked).toBe(20);
    expect(c.now).toBe(started + 20_000);
    expect(t.withdrawCalls).toBe(1);
    expect(l.pages).toBe(1);
    expect(f.said).toEqual(['here:בר:timeout']);
  });

  it('the timeout counts from the send, and a page that printed just then is not printed twice', async () => {
    const s = settings({ timeoutSec: 5, fallback: 'local' });
    const t = new Transport([{ kind: 'waiting' }, { kind: 'waiting' }, { kind: 'printed' }], null, false);
    const f = new Feedback();
    const l = local();
    const c = new Clock();
    expect(await flow(t, f, c).follow({ id: 'j', via: 'lan' }, HOST, s, c.now - 3_000, l.print)).toBe('printed');
    expect(l.pages).toBe(0);
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(2_000);
    expect(f.said).toEqual(['printed:בר']);
  });

  it('nobody took it - the fallback at once; a till with no printer of its own is only told', async () => {
    const t = new Transport([], new Error('no LAN, no cloud'));
    const f = new Feedback(true);
    const l = local();
    const c = new Clock();
    const fl = flow(t, f, c);
    expect((await fl.handOver(HOST, JOB, settings())).ok).toBe(false);
    expect(f.said).toEqual([]);
    expect(await fl.fallback(HOST, settings(), 'not_sent', l.print)).toBe('printed_here');
    expect(f.said).toEqual(['ask:בר:not_sent', 'here:בר:not_sent']);
    const told = new Feedback(true);
    for (const m of ['ask', 'local', 'none'] as const) expect(await flow(new Transport(), told, c).fallback(HOST, settings({ fallback: m }), 'no_paper', null)).toBe('not_printed');
    expect(told.said).toEqual(['failed:בר:no_paper', 'failed:בר:no_paper', 'failed:בר:no_paper']);
  });

  it('nobody stands here - ask is only said', async () => {
    const f = new Feedback(true);
    const c = new Clock();
    const l = local();
    expect(await flow(new Transport(), f, c).fallback(HOST, settings({ fallback: 'ask' }), 'no_paper', l.print, false)).toBe('not_printed');
    expect(l.pages).toBe(0);
    expect(f.said).toEqual(['failed:בר:no_paper']);
  });
});

/* ------------------------------------------------------------------ on the Windows till */

const PRINTERS = {
  syncType: 'full',
  etag: 'e1',
  machineId: 'm',
  printers: [{ id: '22222222-0000-4000-8000-000000000001', name: 'מדפסת בר', purpose: 'receipt', type: 'cloud', hostMachineId: 'm-bar', hostMachineName: 'בר', hostLanAddress: '10.0.0.7', hostLanPort: 8399, paperWidth: 58, scope: 'machine', isHost: false, inScope: false, hostDocumentRelay: true }],
  printSecret: 'shop-secret',
  printHost: null,
};

type LanSeen = { method: string; path: string; body: unknown; address: string; port: number; secret: string };

function rig(o: { parameters?: Record<string, unknown>; lan?: (c: LanSeen) => { status: number; body: unknown } | 'down'; cloud?: Record<string, (b: Record<string, unknown> | null) => unknown>; hasOwnPrinter?: boolean } = {}) {
  const lanSeen: LanSeen[] = [];
  const lanCall: LanCall = async (target, secret, method, path, body) => {
    const c = { method, path, body, address: target.address, port: target.port, secret };
    lanSeen.push(c);
    const a = o.lan ? o.lan(c) : 'down';
    if (a === 'down') {
      const { LanNotReached } = await import('../src/main/kitchen/kitchenNet');
      throw new LanNotReached('no route');
    }
    return a;
  };
  const clock = { now: Date.parse('2026-10-16T10:00:00Z') };
  const h: Harness = harness({
    parameters: { remotePrintDocuments: 'bill_receipts', remotePrintTimeoutSec: '5', ...(o.parameters ?? {}) },
    answers: { 'GET sync/m/printers': () => PRINTERS, ...(o.cloud ?? {}) },
    remotePrint: {
      lanCall,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
        await new Promise((r) => setImmediate(r));
      },
      pollMs: 1_000,
      draw: async (_doc, width) => ({ width, height: 4, rowBytes: width / 8, data: new Uint8Array((width / 8) * 4).fill(0x0f) }),
    },
  });
  // This till's own receipt printer (a Windows queue) — "להדפיס כאן" is possible.
  if (o.hasOwnPrinter !== false) h.svc.setLocalSettings({ printer: { transport: 'spooler', queueName: 'SNBC BTP-880' } });
  return { h, lanSeen, clock };
}

async function settle(h: Harness, ms = 30) {
  for (let i = 0; i < ms; i++) await new Promise((r) => setImmediate(r));
  await h.engine.call({ id: 9_999, op: 'session.activity', args: {}, clientOpId: `act-${Math.random()}` });
}

async function cashSale(h: Harness) {
  await h.ok('session.login', { pin: PIN });
  await h.ok('shift.open', { openingCashAgorot: 0 });
  await h.ok('sell.add', { productId: 'p-cola' });
  await h.ok('checkout.start');
  await h.ok('checkout.cash', { amountAgorot: 2_000 });
}

describe('on the Windows till', () => {
  let current: Harness | null = null;
  afterEach(() => {
    current?.stop();
    current = null;
  });

  it("a receipt the cloud's printer assigned to this till takes - over the LAN as a 58 mm image, printed there, said; nothing printed here", async () => {
    const { h, lanSeen } = rig({
      lan: (c) => (c.path === '/kitchen/jobs' ? { status: 201, body: { ok: true } } : c.path.startsWith('/kitchen/jobs/status') ? { status: 200, body: { jobs: [{ id: (c.path.split('ids=')[1] ?? ''), status: 'done' }] } } : { status: 404, body: null }),
    });
    current = h;
    await h.svc.kitchen.pull(true);
    await cashSale(h);
    await settle(h, 60);
    const post = lanSeen.find((c) => c.method === 'POST' && c.path === '/kitchen/jobs')!;
    expect(post).toMatchObject({ address: '10.0.0.7', port: 8399, secret: 'shop-secret' });
    const body = post.body as Record<string, unknown> & { document: Record<string, unknown> };
    expect(body.kind).toBe('document');
    expect(body.printerId).toBe(PRINTERS.printers[0].id);
    expect(body.document).toMatchObject({ category: 'receipt', paperWidth: 58, widthDots: 384, heightDots: 4, encoding: 'png', copy: false, timeoutSec: 5, sourceName: 'קופה 2' });
    expect(decodeMonoPng(Buffer.from(String(body.document.image), 'base64')).width).toBe(384);
    // Not printed here: no receipt job in the local queue.
    expect(h.svc.printQueue.jobsFor(h.state().checkout.documentId ?? '', 'receipt')).toEqual([]);
    const toasts = h.events.filter((e) => e.ev === 'toast').map((e) => (e.data as { text: string }).text);
    expect(toasts).toContain('נשלח להדפסה בבר');
    expect(toasts).toContain('הודפס בבר');
  });

  it('the LAN does not answer - through the cloud by the same id; failed there and remotePrintFallback local - printed here', async () => {
    let jobId = '';
    const { h, lanSeen } = rig({
      parameters: { remotePrintFallback: 'local' },
      cloud: {
        'POST sync/m/print-jobs': (b) => {
          jobId = String(b?.id ?? '');
          return { __status: 201, id: jobId, kind: 'document', status: 'pending' };
        },
        'GET sync/m/print-jobs/status': () => ({ jobs: [{ id: jobId, status: 'failed', error: 'no_paper' }] }),
      },
    });
    current = h;
    await h.svc.kitchen.pull(true);
    await cashSale(h);
    await settle(h, 80);
    expect(lanSeen.some((c) => c.path === '/kitchen/jobs')).toBe(true);
    const sent = h.sent.find((c) => c.method === 'POST' && c.path === 'sync/m/print-jobs')!;
    expect((sent.body as { id: string }).id).toBe(jobId);
    expect((sent.body as { document: Record<string, unknown> }).document.sourceName).toBeUndefined();
    const docId = h.state().checkout.documentId ?? '';
    expect(h.svc.printQueue.jobsFor(docId, 'receipt')).toHaveLength(1);
    const toasts = h.events.filter((e) => e.ev === 'toast').map((e) => (e.data as { text: string }).text);
    expect(toasts).toContain('לא הודפס בבר — הודפס כאן');
  });

  it('remotePrintDocuments bill (the default): a receipt prints here as before, nothing sent', async () => {
    const { h, lanSeen } = rig({ parameters: { remotePrintDocuments: 'bill' } });
    current = h;
    await h.svc.kitchen.pull(true);
    await cashSale(h);
    await settle(h, 20);
    expect(lanSeen).toEqual([]);
    expect(h.sent.some((c) => c.path === 'sync/m/print-jobs')).toBe(false);
    expect(h.svc.printQueue.jobsFor(h.state().checkout.documentId ?? '', 'receipt')).toHaveLength(1);
  });

  it('"מדפסת הקופה" chosen on this till wins over the cloud\'s assignment', async () => {
    const { h, lanSeen } = rig();
    current = h;
    h.svc.kv.set(TILL_PRINTER_KEY, 'local');
    await h.svc.kitchen.pull(true);
    await cashSale(h);
    await settle(h, 20);
    expect(lanSeen).toEqual([]);
    expect(h.svc.printQueue.jobsFor(h.state().checkout.documentId ?? '', 'receipt')).toHaveLength(1);
    expect(h.svc.kv.get(DEFAULT_PRINTER_KEY)).toBeNull();
  });
});
