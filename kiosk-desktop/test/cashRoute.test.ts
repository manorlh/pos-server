/**
 * "קיוסק מארח וניתוב ענן/מקומי" (P:/specs/cash-paylink.md §14) on Windows:
 *
 *  - the shared golden (test/fixtures/contract/cash_relay_golden.json — the same bytes in pos-server and pos-android):
 *    the signed relay envelope, the route decisions, the lease timings and the limits;
 *  - the cloud client (CashCloudClient) against a fake cloud: done / pending / expired / lost / refused / clock;
 *  - the host's relay worker: each call checked as on the LAN (age, client, signature, nonce once, a §11.4 call), run
 *    with the cloud's lease timing, answered in the next poll;
 *  - a payment end to end through a fake cloud mailbox: the kiosk (cashRoute cloud) → the relay → a real cash host
 *    with a simulated PayLink, and back; `auto` choosing the LAN while it answers, the cloud when it does not;
 *  - a host kiosk's own payment in the app (`local`, §14.1), and the host's config inside a kiosk's answer.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { CashJournal } from '../src/main/cash/journal';
import { CashHost, hostConfigOf, type HostConfig } from '../src/main/cash/host';
import { SimulatedPaylink, type SimConfig } from '../src/main/cash/simulator';
import { CashCloudClient, relayEnvelope, type CashStationRef, type RelayCloud } from '../src/main/cash/client';
import { deriveClientSecret, NonceCache, signCash } from '../src/main/cash/auth';
import { CashRelayWorker, type RelayHost, type RelayRequest } from '../src/main/cash/relay';
import { CashPay, queuedMessage } from '../src/main/kiosk/cashPay';
import {
  AUTO_LAN_FRESH_MS,
  CLOUD_LEASE_RENEW_MS,
  CLOUD_LEASE_TTL_MS,
  paymentVia,
  RELAY_CLIENT_WAIT_MS,
  RELAY_EXECUTE_MAX_AGE_MS,
  RELAY_HOST_WAIT_MS,
  recoveryVia,
  routeOf,
} from '../src/core/cash/route';
import { LEASE_RENEW_MS, LEASE_TTL_MS, matchRoute, type LeaseView } from '../src/core/cash/lanProtocol';
import { cashSettingsOf } from '../src/core/cash/settings';
import type { Api, ApiReply } from '../src/main/sync/api';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILE = path.join(here, 'fixtures', 'contract', 'cash_relay_golden.json');
/** SHA-256 of the golden (LF bytes) — the same pinned in pos-server and pos-android. */
const GOLDEN_SHA256 = '1e677302bb731f7677308b68413d6f3c2be31eadf72a5c18d34c19e1ac4bc163';
const golden = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as {
  hostSecret: string;
  clientId: string;
  clientSecret: string;
  request: Record<string, unknown> & { requestId: string; stationId: string; method: string; path: string; client: string; ts: string; nonce: string; sig: string; body: string; waitMs: number };
  statusRequest: Record<string, unknown> & { requestId: string; stationId: string; method: string; path: string; client: string; ts: string; nonce: string; sig: string; body: string; waitMs: number };
  answers: Record<'done' | 'refused' | 'pending' | 'expired' | 'lost', Record<string, unknown>>;
  poll: { body: Record<string, unknown>; answer: { api: number; relay: boolean; requests: RelayRequest[] } };
  routes: Array<{ cashRoute: string; ownHost: boolean; lanOkAgoMs: number | null; payment: string; recovery: string[] }>;
  lease: { lanRenewMs: number; lanTtlMs: number; cloudRenewMs: number; cloudTtlMs: number };
  limits: Record<string, number>;
};

const KIOSK = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const HOST = 'a1b2c3d4-0000-4000-8000-0000000000aa';
const HOST_SECRET = 'c'.repeat(64);

const stoppers: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stoppers.splice(0).reverse()) await s();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | null | undefined | false, ms = 15_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(15);
  }
};

const ok = <T>(body: T, status = 200): ApiReply<T> => ({ kind: 'ok', status, body, headers: new Headers() });

/* ------------------------------------------------------------------ the golden */

describe('the shared golden (§14.8)', () => {
  it('is the same bytes as in pos-server and pos-android', () => {
    const raw = readFileSync(GOLDEN_FILE).toString('utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(raw, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
  });

  it('its envelope is what this client signs and sends', () => {
    expect(deriveClientSecret(golden.hostSecret, golden.clientId)).toBe(golden.clientSecret);
    for (const r of [golden.request, golden.statusRequest]) {
      const env = relayEnvelope({ requestId: r.requestId, stationId: r.stationId, method: r.method, path: r.path, clientId: golden.clientId, secret: golden.clientSecret, ts: r.ts, nonce: r.nonce, body: r.body, waitMs: r.waitMs });
      expect(env).toEqual(r);
    }
    // The start body exactly as CashCalls.start builds it (the order of its keys is in the signature).
    expect(golden.request.body).toBe(JSON.stringify({ leaseId: 'l-1', amountAgorot: 5735, orderRef: 'o-1', orderLabel: '57', kind: 'sale' }));
  });

  it('the route decisions, the lease timings and the limits', () => {
    for (const row of golden.routes) {
      const route = routeOf(row.cashRoute);
      expect(paymentVia(route, row.ownHost, row.lanOkAgoMs), JSON.stringify(row)).toBe(row.payment);
      expect(recoveryVia(route, row.ownHost), JSON.stringify(row)).toEqual(row.recovery);
    }
    expect(golden.lease).toEqual({ lanRenewMs: LEASE_RENEW_MS, lanTtlMs: LEASE_TTL_MS, cloudRenewMs: CLOUD_LEASE_RENEW_MS, cloudTtlMs: CLOUD_LEASE_TTL_MS });
    expect(golden.limits.executeMaxAgeMs).toBe(RELAY_EXECUTE_MAX_AGE_MS);
    expect(golden.limits.autoLanFreshMs).toBe(AUTO_LAN_FRESH_MS);
    expect(RELAY_CLIENT_WAIT_MS).toBeLessThanOrEqual(golden.limits.clientWaitMaxMs);
    expect(RELAY_HOST_WAIT_MS).toBeLessThanOrEqual(golden.limits.hostWaitMaxMs);
    expect(cashSettingsOf({ cashRoute: 'cloud' }).route).toBe('cloud');
    expect(cashSettingsOf({}).route).toBe('lan');
    expect(cashSettingsOf({ cashRoute: 'wifi' }).route).toBe('lan');
  });
});

/* ------------------------------------------------------------------ the client through the cloud */

const ref = (over: Partial<CashStationRef> = {}): CashStationRef => ({
  stationId: 'st-1',
  name: 'עמדת מזומן 1',
  location: null,
  hostId: HOST,
  hostName: null,
  lanAddress: null,
  port: 47630,
  secret: deriveClientSecret(HOST_SECRET, KIOSK),
  ...over,
});

function scriptedCloud(answers: Array<ApiReply<unknown>>) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const next = () => answers.shift() ?? ok({ api: 1, state: 'pending' });
  const cloud: RelayCloud = {
    post: async <T>(p: string, body?: unknown) => {
      calls.push({ method: 'POST', path: p, body: body as Record<string, unknown> });
      return next() as ApiReply<T>;
    },
    get: async <T>(p: string) => {
      calls.push({ method: 'GET', path: p });
      return next() as ApiReply<T>;
    },
  };
  return { cloud, calls };
}

describe('the cloud client (§14.4)', () => {
  it('signs the call as on the LAN and maps the host’s answer; pending is asked again', async () => {
    const tx = { txId: '7c0e5a1b-2d3f-4c5e-8a9b-0c1d2e3f4a5b', state: 'ACCEPTING', seq: 3 };
    const { cloud, calls } = scriptedCloud([ok({ api: 1, state: 'pending' }), ok({ api: 1, state: 'done', reply: { status: 200, body: tx, hostTime: 1_760_000_000_500 } })]);
    const c = new CashCloudClient(KIOSK, ref(), cloud, () => 1_760_000_000_000, () => 'req-1', () => 'nonce-relay-test-0001');
    const r = await c.tx(tx.txId);
    expect(r).toEqual({ kind: 'ok', status: 200, body: tx });
    expect(calls.map((x) => `${x.method} ${x.path.split('?')[0]}`)).toEqual([`POST sync/${KIOSK}/cash/relay`, `GET sync/${KIOSK}/cash/relay/req-1`]);
    const env = calls[0].body!;
    expect(env).toMatchObject({ requestId: 'req-1', stationId: 'st-1', method: 'GET', path: `/cash/stations/st-1/tx/${tx.txId}`, client: KIOSK, ts: '1760000000000', nonce: 'nonce-relay-test-0001', body: '', waitMs: RELAY_CLIENT_WAIT_MS });
    expect(env.sig).toBe(signCash(ref().secret, 'GET', `/cash/stations/st-1/tx/${tx.txId}`, '1760000000000', 'nonce-relay-test-0001', ''));
    expect(c.renewMs).toBe(CLOUD_LEASE_RENEW_MS);
    expect(c.via).toBe('cloud');
  });

  it('a host refusal, a cloud refusal, no answer, an expired call', async () => {
    const refused = scriptedCloud([ok(golden.answers.refused)]);
    expect(await new CashCloudClient(KIOSK, ref(), refused.cloud).status()).toMatchObject({ kind: 'refused', status: 409, error: 'not_holder' });
    const cloudSaysNo = scriptedCloud([{ kind: 'refused', status: 409, body: { detail: { code: 'cloud_route_off', message: 'x' } }, detail: null, headers: new Headers() }]);
    expect(await new CashCloudClient(KIOSK, ref(), cloudSaysNo.cloud).status()).toMatchObject({ kind: 'refused', status: 409, error: 'cloud_route_off' });
    // The cloud's 404 (`relay_not_found`, or a cloud without the relay) is no answer — never the station's "unknown tx".
    const cloud404 = scriptedCloud([{ kind: 'refused', status: 404, body: { detail: { code: 'relay_not_found' } }, detail: null, headers: new Headers() }]);
    expect(await new CashCloudClient(KIOSK, ref(), cloud404.cloud).tx('7c0e5a1b-2d3f-4c5e-8a9b-0c1d2e3f4a5b')).toMatchObject({ kind: 'offline' });
    // The station's own 404 through the relay stays a refusal.
    const station404 = scriptedCloud([ok({ api: 1, state: 'done', reply: { status: 404, body: { error: 'unknown_tx' }, hostTime: 1 } })]);
    expect(await new CashCloudClient(KIOSK, ref(), station404.cloud).tx('7c0e5a1b-2d3f-4c5e-8a9b-0c1d2e3f4a5b')).toMatchObject({ kind: 'refused', status: 404, error: 'unknown_tx' });
    for (const state of ['expired', 'lost'] as const) {
      const s = scriptedCloud([ok(golden.answers[state])]);
      expect((await new CashCloudClient(KIOSK, ref(), s.cloud).status()).kind).toBe('offline');
    }
    const noNet = scriptedCloud([{ kind: 'offline', reason: 'fetch failed' }]);
    const r = await new CashCloudClient(KIOSK, ref(), noNet.cloud).status();
    expect(r).toMatchObject({ kind: 'offline' });
    expect((r as { reason: string }).reason.startsWith('cloud:')).toBe(true);
    const tooOld = scriptedCloud([ok({ api: 1, state: 'done', reply: { status: 504, body: { error: 'expired' }, hostTime: 1 } })]);
    expect((await new CashCloudClient(KIOSK, ref(), tooOld.cloud).status()).kind).toBe('offline');
    // Pending past its deadline: no answer.
    let t = 0;
    const slow = scriptedCloud([]);
    const late = new CashCloudClient(KIOSK, ref(), { post: async (p, b) => ((t += 9_000), slow.cloud.post(p, b)), get: slow.cloud.get }, () => t);
    expect(await late.status()).toMatchObject({ kind: 'offline', reason: 'relay: no answer in time' });
  });

  it('a clock the host refused: its time taken, sent once more', async () => {
    const { cloud, calls } = scriptedCloud([
      ok({ api: 1, state: 'done', reply: { status: 401, body: { error: 'auth', why: 'clock' }, hostTime: 1_760_000_600_000 } }),
      ok({ api: 1, state: 'done', reply: { status: 200, body: { ready: true }, hostTime: 1_760_000_600_000 } }),
    ]);
    const r = await new CashCloudClient(KIOSK, ref(), cloud, () => 1_760_000_000_000).status();
    expect(r.kind).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(Number(calls[1].body!.ts)).toBe(1_760_000_600_000);
    expect(calls[1].body!.requestId).not.toBe(calls[0].body!.requestId);
  });
});

/* ------------------------------------------------------------------ the host's relay worker */

function stubHost(now: () => number) {
  const ran: Array<{ kind: string; clientId: string; body: Record<string, unknown>; via: string | undefined }> = [];
  const host: RelayHost = {
    hostSecret: () => golden.hostSecret,
    knownClient: (id) => id === golden.clientId,
    call: async (route, clientId, body, via) => {
      ran.push({ kind: route.kind, clientId, body, via });
      return { status: 200, body: { txId: 'x', state: 'ACCEPTING' } };
    },
    now,
    log: () => undefined,
  };
  return { host, ran };
}

describe('the host’s relay worker (§14.4)', () => {
  const request = (over: Partial<RelayRequest> = {}): RelayRequest => ({ ...(golden.poll.answer.requests[0] as RelayRequest), ...over });

  it('checks each call as the LAN does and runs it with the cloud’s timing', async () => {
    const now = () => Number(golden.request.ts) + 300;
    const { host, ran } = stubHost(now);
    const w = new CashRelayWorker({ api: { post: async <T>() => ok({} as T) }, machineId: () => HOST, host, nonces: new NonceCache(), wanted: () => true });
    const first = await w.handle(request());
    expect(first).toEqual({ requestId: golden.request.requestId, status: 200, body: { txId: 'x', state: 'ACCEPTING' }, hostTime: now() });
    expect(ran).toEqual([{ kind: 'tx_start', clientId: golden.clientId, body: JSON.parse(golden.request.body), via: 'cloud' }]);
    // The same signed call again (a replay): refused, not run.
    expect(await w.handle(request())).toMatchObject({ status: 401, body: { error: 'auth', why: 'replay' } });
    expect(ran).toHaveLength(1);
    // Too old at the cloud; another device's call; a bad signature; not a §11.4 call.
    expect(await w.handle(request({ ageMs: RELAY_EXECUTE_MAX_AGE_MS + 1 }))).toMatchObject({ status: 504, body: { error: 'expired' } });
    expect(await w.handle(request({ nonce: 'nonce-relay-test-0009', clientId: KIOSK }))).toMatchObject({ status: 403 });
    expect(await w.handle(request({ nonce: 'nonce-relay-test-0010' }))).toMatchObject({ status: 401, body: { why: 'signature' } });
    const healthSig = signCash(golden.clientSecret, 'GET', '/cash/health', golden.request.ts, 'nonce-relay-test-0011', '');
    expect(await w.handle(request({ method: 'GET', path: '/cash/health', body: '', nonce: 'nonce-relay-test-0011', sig: healthSig }))).toMatchObject({ status: 404 });
    expect(ran).toHaveLength(1);
  });

  it('answers in the next poll; no internet — kept; the cloud says nobody routes through it', async () => {
    const now = () => Number(golden.request.ts) + 300;
    const { host } = stubHost(now);
    const posts: Array<{ path: string; body: { replies: unknown[]; waitMs: number } }> = [];
    const answers: Array<ApiReply<unknown>> = [ok(golden.poll.answer), { kind: 'offline', reason: 'x' }, ok({ api: 1, relay: false, requests: [] })];
    const w = new CashRelayWorker({
      api: { post: async <T>(p: string, b?: unknown) => (posts.push({ path: p, body: b as { replies: unknown[]; waitMs: number } }), answers.shift() as ApiReply<T>) },
      machineId: () => HOST,
      host,
      nonces: new NonceCache(),
      wanted: () => true,
    });
    expect(await w.pollOnce(0)).toEqual({ ok: true, relay: true, handled: 1 });
    expect(await w.pollOnce(0)).toEqual({ ok: false, relay: true, handled: 0 });
    expect(await w.pollOnce(0)).toEqual({ ok: true, relay: false, handled: 0 });
    expect(posts.map((p) => p.path)).toEqual([`sync/${HOST}/cash/relay/poll`, `sync/${HOST}/cash/relay/poll`, `sync/${HOST}/cash/relay/poll`]);
    expect(posts[0].body.replies).toEqual([]);
    // The answer rode the next poll, and again after the one that did not reach the cloud.
    expect(posts[1].body.replies).toEqual([expect.objectContaining({ requestId: golden.request.requestId, status: 200 })]);
    expect(posts[2].body.replies).toEqual(posts[1].body.replies);
    expect(Object.keys(golden.poll.body).sort()).toEqual(Object.keys(posts[0].body).sort());
  });
});

/* ------------------------------------------------------------------ end to end through a fake cloud */

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

/** The cloud's relay as a mailbox in memory (app/services/cash_relay.py, without the database). */
function mailbox() {
  type Row = { env: Record<string, unknown>; client: string; at: number; state: 'pending' | 'taken' | 'done'; reply?: unknown };
  const rows = new Map<string, Row>();
  const waitFor = async (id: string, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (rows.get(id)?.state === 'done') break;
      await sleep(5);
    }
    const r = rows.get(id)!;
    return r.state === 'done' ? { api: 1, requestId: id, state: 'done', reply: r.reply } : { api: 1, requestId: id, state: 'pending' };
  };
  let relayed = 0;
  const api = {
    post: async (p: string, body: unknown) => {
      const m = /^sync\/([^/]+)\/cash\/relay(\/poll)?$/.exec(p);
      if (!m) return { kind: 'refused', status: 404, body: { detail: 'Not Found' }, detail: 'Not Found', headers: new Headers() };
      const b = body as Record<string, unknown>;
      if (!m[2]) {
        const id = String(b.requestId);
        if (!rows.has(id)) rows.set(id, { env: b, client: m[1], at: Date.now(), state: 'pending' });
        relayed++;
        return ok(await waitFor(id, Math.min(Number(b.waitMs ?? 0), 300)));
      }
      for (const r of (b.replies as Array<{ requestId: string; status: number; body: unknown; hostTime: number }>) ?? []) {
        const row = rows.get(r.requestId);
        if (row?.state === 'taken') Object.assign(row, { state: 'done', reply: { status: r.status, body: r.body, hostTime: r.hostTime } });
      }
      const t0 = Date.now();
      for (;;) {
        const waiting = [...rows.entries()].filter(([, r]) => r.state === 'pending');
        if (waiting.length > 0 || Date.now() - t0 > Math.min(Number(b.waitMs ?? 0), 100)) {
          for (const [, r] of waiting) r.state = 'taken';
          return ok({ api: 1, relay: true, requests: waiting.map(([id, r]) => ({ requestId: id, clientId: r.client, ...r.env, ageMs: Date.now() - r.at })) });
        }
        await sleep(5);
      }
    },
    get: async (p: string) => {
      const m = /^sync\/[^/]+\/cash\/relay\/([^?]+)\?waitMs=(\d+)$/.exec(p);
      if (!m) return { kind: 'refused', status: 404, body: { detail: 'Not Found' }, detail: 'Not Found', headers: new Headers() };
      return ok(await waitFor(decodeURIComponent(m[1]), Math.min(Number(m[2]), 300)));
    },
  };
  return { api: api as unknown as Api, relayedCount: () => relayed };
}

async function cashHost(cloud: Api, clients: HostConfig['stations'][number]['clients'], opts: { relay?: boolean; machineId?: string } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const device = new SimulatedPaylink(SIM);
  const host = new CashHost({
    api: cloud,
    kv: new Kv(db),
    journal: new CashJournal(db),
    machineId: () => opts.machineId ?? HOST,
    appVersion: '0.6.0',
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
    stations: [{ stationId: 'st-1', name: 'עמדת מזומן 1', location: null, serial: '', simulator: true, settings: { cashSettleMs: 200, cashRefundGraceSec: 10 }, clients, relay: opts.relay ?? true }],
    commands: [],
    settings: {},
    lanAlertTargets: [],
  });
  await host.start();
  const timer = setInterval(() => void host.tick(), 40);
  stoppers.push(async () => {
    clearInterval(timer);
    host.relay.stop();
    await host.stop();
  });
  for (let i = 0; i < 3; i++) await host.tick();
  return { host, device };
}

function kioskPay(cloud: Api, station: CashStationRef, settings: Record<string, unknown>, machineId = KIOSK) {
  const db = openDb(':memory:');
  migrate(db);
  const kv = new Kv(db);
  kv.setJson('cash.clientConfig', { enabled: true, station, settings });
  const pay = new CashPay({ api: cloud, kv, machineId: () => machineId, log: () => undefined, pollMs: 50 });
  stoppers.push(() => pay.stop());
  return pay;
}

describe('a payment through the cloud relay, end to end', () => {
  it('cashRoute cloud: queue, insert, change, ack — every call through the relay, the lease kept the cloud’s way', async () => {
    const cloud = mailbox();
    const { host, device } = await cashHost(cloud.api, [{ machineId: KIOSK, name: 'קיוסק 2', kind: 'kiosk', route: 'cloud' }]);
    host.relay.start();
    // No LAN address at all: only the cloud.
    const pay = kioskPay(cloud.api, ref({ lanAddress: null }), { cashRoute: 'cloud', cashRefundGraceSec: 10 });
    expect(pay.configured()).toBe(true);
    await pay.refreshStatus();
    expect(pay.usable()).toBe(true);
    expect(pay.viaForPayment()).toBe('cloud');
    const stages: string[] = [];
    const paying = pay.pay({ orderId: 'o-1', docId: 'd-1', amountAgorot: 3735, orderLabel: '12' }, (p) => stages.push(p.stage));
    await until(() => stages.includes('insert'));
    expect(pay.pending()[0].via).toBe('cloud');
    // The station holds the lease the cloud's way (20 s to live, renewed every 5 s — and by every relayed call).
    const leases = (host.station('st-1') as unknown as { leases: Array<{ clientId: string; ttlMs: number; renewMs: number }> }).leases;
    expect(leases.find((l) => l.clientId === KIOSK)).toMatchObject({ ttlMs: CLOUD_LEASE_TTL_MS, renewMs: CLOUD_LEASE_RENEW_MS });
    expect(device.insert(5000)).toBe('escrow');
    const outcome = await paying;
    expect(outcome.kind).toBe('paid');
    const tx = (outcome as { tx: { insertedAgorot: number; changePaidAgorot: number; dueAgorot: number } }).tx;
    expect(tx).toMatchObject({ insertedAgorot: 5000, dueAgorot: 3740, changePaidAgorot: 1260 });
    expect(await pay.ack((outcome as { tx: { txId: string } }).tx.txId, 'doc-1', '17', '12')).toBe(true);
    await until(() => host.station('st-1')!.recentTxs(1)[0]?.acked);
    expect(pay.pending()).toEqual([]);
    expect(cloud.relayedCount()).toBeGreaterThan(4);
  });

  it('a relayed lease is the cloud’s: 5 s renewal, 20 s to live — and any relayed call renews it', async () => {
    const cloud = mailbox();
    const { host } = await cashHost(cloud.api, [{ machineId: KIOSK, name: 'קיוסק 2', kind: 'kiosk', route: 'cloud' }]);
    const leased = await host.call({ kind: 'lease', stationId: 'st-1' }, KIOSK, {}, 'cloud');
    const view = leased.body as LeaseView;
    expect(view.renewMs).toBe(CLOUD_LEASE_RENEW_MS);
    expect(view.expiresAt - Date.now()).toBeGreaterThan(CLOUD_LEASE_TTL_MS - 1_000);
    const st = host.station('st-1')!;
    // A status through the cloud renews it (no extra lease call needed).
    const before = st.status(KIOSK).you.leaseId;
    await host.call({ kind: 'status', stationId: 'st-1' }, KIOSK, {}, 'cloud');
    expect(st.status(KIOSK).you.leaseId).toBe(before);
  });

  it('auto: the LAN while the station answers there, else the cloud — each payment keeps its way', async () => {
    const cloud = mailbox();
    const { host, device } = await cashHost(cloud.api, [{ machineId: KIOSK, name: 'קיוסק 2', kind: 'kiosk', route: 'auto' }]);
    host.relay.start();
    const pay = kioskPay(cloud.api, ref({ lanAddress: '127.0.0.1', port: host.port }), { cashRoute: 'auto', cashRefundGraceSec: 10 });
    await pay.refreshStatus();
    expect(pay.usable()).toBe(true);
    expect(pay.viaForPayment()).toBe('lan');
    const before = cloud.relayedCount();
    const paying = pay.pay({ orderId: 'o-2', docId: 'd-2', amountAgorot: 1000, orderLabel: null }, () => undefined);
    await until(() => host.station('st-1')!.status(KIOSK).you.txId);
    expect(pay.pending()[0].via).toBe('lan');
    device.insert(1000);
    expect((await paying).kind).toBe('paid');
    expect(cloud.relayedCount()).toBe(before);
    // The LAN gone (another address): the tile through the cloud, the next payment through it.
    const lost = kioskPay(cloud.api, ref({ lanAddress: '127.0.0.1', port: 1 }), { cashRoute: 'auto' });
    await lost.refreshStatus();
    expect(lost.usable()).toBe(true);
    expect(lost.viaForPayment()).toBe('cloud');
    expect(cloud.relayedCount()).toBeGreaterThan(before);
  });
});

describe('recovery in auto (§14.2.3)', () => {
  it('a payment the cloud carried is looked up on the LAN first; its ack right after the payment went its own way', async () => {
    const cloud = mailbox();
    const { host } = await cashHost(cloud.api, [{ machineId: KIOSK, name: 'קיוסק 2', kind: 'kiosk', route: 'auto' }]);
    host.relay.start();
    const pay = kioskPay(cloud.api, ref({ lanAddress: '127.0.0.1', port: host.port }), { cashRoute: 'auto' });
    // A payment a restart left behind, carried by the cloud; the station never heard of it.
    const txId = randomUUID();
    const kv = (pay as unknown as { d: { kv: Kv } }).d.kv;
    kv.setJson('cash.pending', [{ txId, stationId: 'st-1', leaseId: null, orderId: 'o', docId: 'd', amountAgorot: 100, orderLabel: null, startedAt: Date.now(), started: true, finalState: null, via: 'cloud' }]);
    const before = cloud.relayedCount();
    expect(await pay.lookUp(txId)).toEqual({ kind: 'none' });
    expect(cloud.relayedCount()).toBe(before); // answered on the LAN — the cloud never asked
  });
});

/* ------------------------------------------------------------------ the host kiosk (§14.1) */

describe('a host kiosk', () => {
  it('reads its stations from the `host` part of its own answer', () => {
    const answer = {
      role: 'client',
      enabled: true,
      station: { stationId: 'st-1', secret: 'z', hostId: KIOSK, lanAddress: '10.0.0.5', port: 47630 },
      settings: {},
      host: {
        role: 'host',
        hostSecret: HOST_SECRET,
        stations: [{ stationId: 'st-1', name: 'עמדה', serial: '', settings: {}, relay: true, clients: [{ machineId: KIOSK, name: 'k', kind: 'kiosk', route: 'lan' }, { machineId: HOST, name: 'k2', kind: 'kiosk', route: 'cloud' }] }],
        commands: [],
        settings: {},
        lanAlertTargets: [],
      },
    };
    const cfg = hostConfigOf(answer)!;
    expect(cfg.hostSecret).toBe(HOST_SECRET);
    expect(cfg.stations[0].relay).toBe(true);
    expect(cfg.stations[0].clients.map((c) => c.route)).toEqual(['lan', 'cloud']);
    expect(hostConfigOf({ role: 'client', enabled: true, station: null })).toBe(null);
    expect(hostConfigOf({ role: 'host', hostSecret: 'x', stations: [] })!.stations).toEqual([]);
  });

  it('pays at its own station in the app — no network, the same calls', async () => {
    const nowhere = { get: async () => ({ kind: 'offline', reason: 'x' }), post: async () => ({ kind: 'offline', reason: 'x' }) } as unknown as Api;
    const { host, device } = await cashHost(nowhere, [{ machineId: KIOSK, name: 'קיוסק מארח', kind: 'kiosk', route: 'cloud' }], { relay: false, machineId: KIOSK });
    // Its own station (hostId = itself), whatever its route says, and no LAN address needed.
    const pay = kioskPay(nowhere, ref({ hostId: KIOSK, lanAddress: null }), { cashRoute: 'cloud' });
    expect(pay.configured()).toBe(true);
    expect(pay.viaForPayment()).toBe('local');
    await pay.refreshStatus();
    expect(pay.usable()).toBe(false); // the host not attached yet
    pay.setLocalHost(host);
    await until(() => pay.usable());
    const paying = pay.pay({ orderId: 'o-3', docId: 'd-3', amountAgorot: 2000, orderLabel: '3' }, () => undefined);
    await until(() => host.station('st-1')!.status(KIOSK).you.txId);
    expect(pay.pending()[0].via).toBe('local');
    device.insert(2000);
    const outcome = await paying;
    expect(outcome.kind).toBe('paid');
    expect(await pay.ack((outcome as { tx: { txId: string } }).tx.txId, 'doc-3', '3')).toBe(true);
    expect(host.busy()).toBe(false);
  });
});

describe('the queue’s words (§14.3)', () => {
  it('the same on every route; the place from 2 on; the long wait', () => {
    expect(queuedMessage(1, false)).toBe('עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום');
    expect(queuedMessage(2, false)).toBe('עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום · מקום 2 בתור');
    expect(queuedMessage(1, true)).toBe('עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום · ההמתנה ארוכה מהרגיל');
    expect(matchRoute('POST', '/cash/stations/st-1/lease')).toEqual({ kind: 'lease', stationId: 'st-1' });
  });
});
