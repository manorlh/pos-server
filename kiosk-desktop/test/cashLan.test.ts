import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { CashJournal } from '../src/main/cash/journal';
import { CashHost, hostConfigOf, type HostConfig } from '../src/main/cash/host';
import { SimulatedPaylink } from '../src/main/cash/simulator';
import { CashLanClient, clientConfigOf, type CashStationRef } from '../src/main/cash/client';
import { deriveClientSecret, signCash, signedEventsQuery } from '../src/main/cash/auth';
import type { Api } from '../src/main/sync/api';
import type { TxView } from '../src/core/cash/tx';
import type { LeaseView, StationStatus } from '../src/core/cash/lanProtocol';

const HOST_SECRET = 'a'.repeat(64);
/** The shop's print key a LAN server checks (a test value). */
const PRINT_KEY = ['print', 'key'].join('-');
const KIOSK_A = '11111111-1111-4111-8111-111111111111';
const KIOSK_B = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';

interface Posted {
  path: string;
  body: unknown;
}

function fakeApi(posted: Posted[], getBody: () => unknown = () => null): Api {
  return {
    get: async () => ({ kind: 'ok', status: 200, body: getBody(), headers: new Headers({ etag: '"e1"' }) }),
    post: async (path: string, body: unknown) => {
      posted.push({ path, body });
      const entries = (body as { entries?: Array<{ id: string }> }).entries;
      return { kind: 'ok', status: 200, body: entries ? { accepted: entries.map((e) => e.id), rejected: [] } : { ok: true }, headers: new Headers() };
    },
  } as unknown as Api;
}

const config = (over: Partial<HostConfig> = {}): HostConfig => ({
  hostSecret: HOST_SECRET,
  stations: [
    { stationId: 'st-1', name: 'עמדת מזומן 1', location: 'ליד קיוסק 1', serial: '', simulator: true, settings: { cashSettleMs: 300 }, clients: [{ machineId: KIOSK_A, name: 'קיוסק 1', kind: 'kiosk' }] },
    { stationId: 'st-2', name: 'עמדת מזומן 2', location: null, serial: 'AE000002', simulator: true, settings: { cashSettleMs: 300 }, clients: [{ machineId: KIOSK_B, name: 'קיוסק 2', kind: 'kiosk' }] },
  ],
  commands: [],
  settings: {},
  lanAlertTargets: [],
  ...over,
});

let hosts: CashHost[] = [];
afterEach(async () => {
  for (const h of hosts) await h.stop();
  hosts = [];
});

async function setup(over: Partial<HostConfig> = {}, extra: { online?: boolean; fetch?: typeof fetch } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const kv = new Kv(db);
  const journal = new CashJournal(db);
  const posted: Posted[] = [];
  const devices = new Map<string, SimulatedPaylink>();
  const host = new CashHost({
    api: fakeApi(posted),
    kv,
    journal,
    machineId: () => 'host-1',
    appVersion: '0.5.0',
    now: Date.now,
    newId: () => randomUUID(),
    log: () => undefined,
    lanAddress: () => '127.0.0.1',
    cloudOnline: () => extra.online !== false,
    createDevice: (s) => {
      const d = new SimulatedPaylink({ autoTakeBills: true, piecesPerRead: 5, notes: { values: [2000, 5000], escrow: true }, hoppers: [{ valueAgorot: 1000, count: 30 }, { valueAgorot: 500, count: 30 }, { valueAgorot: 100, count: 50 }] });
      devices.set(s.stationId, d);
      return { device: d, driverInstalled: () => true };
    },
    port: 0,
    manualTimers: true,
    fetch: extra.fetch,
  });
  host.apply(config(over));
  await host.start();
  hosts.push(host);
  for (let i = 0; i < 3; i++) await host.tick();
  const ref = (stationId: string, clientId: string, secret = deriveClientSecret(HOST_SECRET, clientId)): CashStationRef => ({
    stationId,
    name: 'x',
    location: null,
    hostId: 'host-1',
    hostName: null,
    lanAddress: '127.0.0.1',
    port: host.port,
    secret,
  });
  return { host, devices, posted, journal, kv, ref };
}

async function ticks(host: CashHost, n: number, waitMs = 120) {
  for (let i = 0; i < n; i++) {
    await host.tick();
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

describe('the cash LAN API', () => {
  it('health is open; everything else is signed by the client’s own secret', async () => {
    const { host, ref } = await setup();
    const health = (await (await fetch(`http://127.0.0.1:${host.port}/cash/health`)).json()) as { service: string; stations: string[] };
    expect(health.service).toBe('r2m-cash');
    expect(health.stations.sort()).toEqual(['st-1', 'st-2']);
    const unsigned = await fetch(`http://127.0.0.1:${host.port}/cash/stations/st-1/status`);
    expect(unsigned.status).toBe(401);
    expect(((await unsigned.json()) as { why: string }).why).toBe('missing');
    const ok = await new CashLanClient(KIOSK_A, ref('st-1', KIOSK_A)).status();
    expect(ok.kind).toBe('ok');
    expect((ok as { body: StationStatus }).body.state).toBe('ready');
    // Another kiosk's secret / a wrong one.
    const wrong = await new CashLanClient(KIOSK_A, ref('st-1', KIOSK_A, deriveClientSecret(HOST_SECRET, KIOSK_B))).status();
    expect(wrong).toMatchObject({ kind: 'refused', status: 401, error: 'auth' });
    // A machine the cloud never assigned.
    const stranger = await new CashLanClient(STRANGER, ref('st-1', STRANGER)).status();
    expect(stranger).toMatchObject({ kind: 'refused', status: 401 });
    expect((stranger as unknown as { body: { why: string } }).body.why).toBe('unknown_client');
    // Assigned to station 2, asking station 1.
    const other = await new CashLanClient(KIOSK_B, ref('st-1', KIOSK_B)).status();
    expect(other).toMatchObject({ kind: 'refused', status: 403, error: 'not_assigned' });
  });

  it('a replayed request is refused; a clock that is off is corrected and retried once', async () => {
    const { host } = await setup();
    const secret = deriveClientSecret(HOST_SECRET, KIOSK_A);
    const path = '/cash/stations/st-1/status';
    const ts = String(Date.now());
    const nonce = 'n'.repeat(20);
    const headers = { 'X-R2M-Cash-Client': KIOSK_A, 'X-R2M-Ts': ts, 'X-R2M-Nonce': nonce, 'X-R2M-Sig': signCash(secret, 'GET', path, ts, nonce, '') };
    expect((await fetch(`http://127.0.0.1:${host.port}${path}`, { headers })).status).toBe(200);
    const again = await fetch(`http://127.0.0.1:${host.port}${path}`, { headers });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { why: string }).why).toBe('replay');
    // A kiosk whose clock is 10 minutes slow.
    const slow = new CashLanClient(KIOSK_A, { stationId: 'st-1', name: '', location: null, hostId: '', hostName: null, lanAddress: '127.0.0.1', port: host.port, secret }, undefined, () => Date.now() - 600_000);
    expect((await slow.status()).kind).toBe('ok');
  });

  it('a whole sale over the LAN: lease, start (idempotent), insert, change, ack — then the journal goes to the cloud', async () => {
    const { host, devices, posted, ref } = await setup();
    const c = new CashLanClient(KIOSK_A, ref('st-1', KIOSK_A));
    const l = (await c.lease(null)) as { kind: 'ok'; body: LeaseView };
    expect(l.body.state).toBe('granted');
    const txId = randomUUID();
    const s1 = await c.start(txId, { leaseId: l.body.leaseId, amountAgorot: 3700, orderRef: 'o-1', orderLabel: '57' });
    const s2 = await c.start(txId, { leaseId: l.body.leaseId, amountAgorot: 3700, orderRef: 'o-1', orderLabel: '57' });
    expect(s1.kind).toBe('ok');
    expect(s2.kind).toBe('ok');
    const conflict = await c.start(txId, { leaseId: l.body.leaseId, amountAgorot: 9999, orderRef: 'o-1', orderLabel: '57' });
    expect(conflict).toMatchObject({ kind: 'refused', status: 409, error: 'tx_conflict' });
    await ticks(host, 2);
    devices.get('st-1')!.insert(5000);
    let v: TxView | null = null;
    for (let i = 0; i < 40; i++) {
      await ticks(host, 1, 60);
      await c.lease(l.body.leaseId);
      const r = await c.tx(txId);
      v = (r as { body: TxView }).body;
      if (v.state === 'DONE') break;
    }
    expect(v!.state).toBe('DONE');
    expect(v!.outcome).toBe('paid');
    expect(v!.changePaidAgorot).toBe(1300);
    const acked = (await c.ack(txId, 'doc-1', 'K1-17')) as { body: TxView };
    expect(acked.body.acked).toBe(true);
    await host.upload();
    const journal = posted.find((p) => p.path === 'sync/host-1/cash/journal');
    expect(journal).toBeTruthy();
    const entry = (journal!.body as { entries: Array<Record<string, unknown>> }).entries.find((e) => e.id === txId)!;
    expect(entry).toMatchObject({ type: 'tx', state: 'DONE', outcome: 'paid', amountAgorot: 3700, changePaidAgorot: 1300, documentId: 'doc-1', orderLabel: '57', stationId: 'st-1' });
    // Nothing left to send.
    const before = posted.length;
    await host.upload();
    expect(posted.length).toBe(before);
  });

  it('the WebSocket carries the client’s own transaction and the station’s status', async () => {
    const { host, devices, ref } = await setup();
    const c = new CashLanClient(KIOSK_A, ref('st-1', KIOSK_A));
    const path = '/cash/stations/st-1/events';
    const q = signedEventsQuery({ clientId: KIOSK_A, clientSecret: deriveClientSecret(HOST_SECRET, KIOSK_A), path, now: Date.now() });
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}${path}?${q}`);
    const seen: Array<{ type: string; tx?: TxView }> = [];
    ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error'));
    });
    const l = (await c.lease(null)) as { body: LeaseView };
    const txId = randomUUID();
    await c.start(txId, { leaseId: l.body.leaseId, amountAgorot: 1000, orderRef: null, orderLabel: null });
    await ticks(host, 2);
    devices.get('st-1')!.insert(1000);
    await ticks(host, 10, 60);
    ws.close();
    expect(seen.some((e) => e.type === 'tx' && e.tx!.txId === txId && e.tx!.state === 'DONE')).toBe(true);
    expect(seen.some((e) => e.type === 'status')).toBe(true);
    // A bad signature never upgrades.
    const bad = new WebSocket(`ws://127.0.0.1:${host.port}${path}?client=${KIOSK_A}&ts=${Date.now()}&nonce=${'x'.repeat(20)}&sig=${'A'.repeat(43)}`);
    const failed = await new Promise<boolean>((resolve) => {
      bad.onopen = () => resolve(false);
      bad.onerror = () => resolve(true);
    });
    expect(failed).toBe(true);
  });

  it('two stations on one host are independent (own queue, own device)', async () => {
    const { host, devices, ref } = await setup();
    const a = new CashLanClient(KIOSK_A, ref('st-1', KIOSK_A));
    const b = new CashLanClient(KIOSK_B, ref('st-2', KIOSK_B));
    expect(((await a.lease(null)) as { body: LeaseView }).body.state).toBe('granted');
    expect(((await b.lease(null)) as { body: LeaseView }).body.state).toBe('granted');
    expect(devices.size).toBe(2);
    const hb = host.heartbeatBlock() as { stations: Array<{ stationId: string; queue: number }>; lanAddress: string; port: number };
    expect(hb.stations.map((s) => [s.stationId, s.queue])).toEqual([
      ['st-1', 1],
      ['st-2', 1],
    ]);
    expect(hb.lanAddress).toBe('127.0.0.1');
    expect(host.busy()).toBe(true);
  });
});

describe('the cash host and the cloud', () => {
  it('staff commands from the dashboard run once and are acknowledged', async () => {
    const cmd = { id: 'c-1', stationId: 'st-1', op: 'collect', args: { countedAgorot: 0 }, by: { userId: 'u', name: 'דנה' }, createdAt: null };
    const { host, posted, journal } = await setup({ commands: [cmd] });
    await host.runCommands();
    await host.runCommands();
    const acks = posted.filter((p) => p.path === 'sync/host-1/cash/commands/c-1/ack');
    expect(acks).toHaveLength(1);
    expect(acks[0].body).toMatchObject({ status: 'done' });
    expect(journal.moves('st-1').filter((m) => m.kind === 'collect')).toHaveLength(1);
  });

  it('no cloud: the stations’ alerts go to the shop’s LAN server, as a kiosk’s', async () => {
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null, body: JSON.parse(String(init.body)) });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const { host, devices } = await setup({ lanAlertTargets: [{ lanAddress: '10.0.0.5', port: 8765, secret: PRINT_KEY }] }, { online: false, fetch: fakeFetch });
    devices.get('st-1')!.consistencyError = 'bad counts';
    await ticks(host, 2, 10);
    expect(await host.lanAlerts()).toBe(2);
    const first = calls.find((c) => (c.body.kioskMachineId as string) === 'st-1')!;
    expect(first.url).toBe('http://10.0.0.5:8765/kiosk/alerts');
    expect(first.auth).toBe(`Bearer ${PRINT_KEY}`);
    expect((first.body.alerts as Array<{ kind: string; text: string }>)[0]).toMatchObject({ kind: 'cash', reason: 'consistency' });
    expect((first.body.alerts as Array<{ text: string }>)[0].text.startsWith('עמדת מזומן 1 (ליד קיוסק 1): ')).toBe(true);
  });

  it('reads the cloud’s answers leniently', () => {
    expect(hostConfigOf({ role: 'client' })).toBe(null);
    const h = hostConfigOf({ role: 'host', hostSecret: 'x', stations: [{ stationId: 's', clients: [{ machineId: 'k' }, { bad: 1 }] }, { nope: 1 }] })!;
    expect(h.stations).toHaveLength(1);
    expect(h.stations[0].clients).toEqual([{ machineId: 'k', name: '', kind: 'kiosk' }]);
    const c = clientConfigOf({ role: 'client', enabled: true, station: { stationId: 's', secret: 'z', lanAddress: '10.0.0.9', port: 47630 } })!;
    expect(c.enabled).toBe(true);
    expect(c.station!.lanAddress).toBe('10.0.0.9');
    expect(clientConfigOf({ role: 'client', enabled: true, station: { stationId: 's' } })!.station).toBe(null);
  });

  it('the client secret derivation is the contract’s (pinned)', () => {
    // The same value is pinned by the cloud's tests (server tests/test_cash_stations.py) and the Android client.
    expect(deriveClientSecret('host-secret', 'kiosk-1')).toBe('93e6a695b8a062545b9afb9c6a0c3c84d448f109e32152c837fdb44e11a857c9');
    expect(deriveClientSecret('host-secret', 'kiosk-1')).not.toBe(deriveClientSecret('host-secret', 'kiosk-2'));
  });
});
