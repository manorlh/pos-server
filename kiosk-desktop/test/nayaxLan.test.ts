/**
 * The Nayax pinpad on the LAN ("nayax_lan", src/main/payment/nayaxProvider.ts over pinpadHttp.ts):
 * a sale frame that never reached the pinpad — plain HTTP not allowed by the settings, the
 * connection refused, no such host or no route to it — is "not sent": the order is voided with its
 * reason, no lookup, no abort, nothing unresolved (as the C4 on USB). Only a frame that was written
 * and whose reply was lost stays "unknown" and is settled by its vuid.
 *
 * Every connection the transport opens is redirected to this machine's loopback, or failed the way
 * the network fails it: nothing reaches a real terminal.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallFn } from '../src/core/cardRecovery';
import type { PinpadAddress } from '../src/core/nayax';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { NayaxLanProvider } from '../src/main/payment/nayaxProvider';
import { PayService } from '../src/main/payment/payService';
import type { ProviderContext } from '../src/main/payment/provider';

const reply = (result: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: '1', result });

/** The shop's pinpad as the cloud settings name it (always redirected below). */
const HTTPS: PinpadAddress = { host: '192.168.0.167', port: 8080, path: '/SPICy', tls: true };
const HTTP: PinpadAddress = { ...HTTPS, tls: false };
const NO_LINK = 'אין חיבור למסוף (192.168.0.167:8080)';

/* ------------------------------------------------------------ the network */

/**
 * Where a connection the transport opens goes: a loopback port, a failed name lookup, or no route.
 * `tlsTaken`: a TLS connection's handshake is taken as done (plain TCP to the loopback pinpad,
 * one fixed certificate) — a pinpad that speaks HTTPS.
 */
type Route = { loopback: number; tlsTaken?: true } | { dns: string } | { unreachable: string };

const realNetConnect = net.connect;
const realTlsConnect = tls.connect;
/** Every connection opened, "net|tls host:port" as the transport asked for it. */
const dials: string[] = [];

function errno(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

function network(route: Route) {
  const open = (kind: 'net' | 'tls', opts: Record<string, unknown>, cb?: () => void): net.Socket => {
    const host = String(opts.host);
    const port = Number(opts.port);
    dials.push(`${kind} ${host}:${port}`);
    if ('unreachable' in route) {
      // No route to the host: the connect itself fails, as the OS reports it — nothing written.
      const s = new net.Socket();
      const e = errno(`connect ${route.unreachable} ${host}:${port}`, { code: route.unreachable, syscall: 'connect', address: host, port });
      process.nextTick(() => s.destroy(e));
      return s;
    }
    if ('loopback' in route && route.tlsTaken && kind === 'tls') {
      const s = realNetConnect({ host: '127.0.0.1', port: route.loopback }, () => s.emit('secureConnect'));
      Object.assign(s, { getPeerCertificate: () => ({ raw: Buffer.from('loopback pinpad') }) });
      return s;
    }
    const target =
      'loopback' in route
        ? { ...opts, host: '127.0.0.1', port: route.loopback }
        : {
            ...opts,
            // Node's own lookup path, failing as a name the shop's DNS does not know.
            lookup: (name: string, _o: unknown, done: (e: Error) => void) => done(errno(`getaddrinfo ${route.dns} ${name}`, { code: route.dns, syscall: 'getaddrinfo', hostname: name })),
          };
    return kind === 'tls' ? realTlsConnect(target as tls.ConnectionOptions, cb) : realNetConnect(target as net.NetConnectOpts, cb);
  };
  vi.spyOn(net, 'connect').mockImplementation(((opts: Record<string, unknown>, cb?: () => void) => open('net', opts, cb)) as unknown as typeof net.connect);
  vi.spyOn(tls, 'connect').mockImplementation(((opts: Record<string, unknown>, cb?: () => void) => open('tls', opts, cb)) as unknown as typeof tls.connect);
}

/* ---------------------------------------------- a loopback "pinpad" (HTTP) */

let server: http.Server;
let pinpadPort = 0;
/** A loopback port nothing listens on: the connection is refused. */
let closedPort = 0;
/** Every frame the loopback pinpad read, by method. */
const seen: string[] = [];
/** Methods whose request the pinpad reads, then drops the connection without a reply. */
const drop = new Set<string>();
/** Methods whose request the pinpad reads, then resets the connection (ECONNRESET). */
const reset = new Set<string>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const o = JSON.parse(body) as { method: string; params: unknown[] };
      seen.push(o.method);
      if (drop.has(o.method)) return void req.socket.destroy();
      if (reset.has(o.method)) return void req.socket.resetAndDestroy();
      const p = (o.params[1] ?? {}) as Record<string, unknown>;
      res.setHeader('Content-Type', 'application/json');
      if (o.method === 'getTransactionByVuid') return void res.end(reply({ statusCode: 0, vuid: p.vuid, amount: 100, uid: 'u-1', transactionId: 'acq-1' }));
      res.end(reply({ statusCode: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  pinpadPort = (server.address() as AddressInfo).port;
  const spare = net.createServer();
  await new Promise<void>((r) => spare.listen(0, '127.0.0.1', () => r()));
  closedPort = (spare.address() as AddressInfo).port;
  await new Promise<void>((r) => spare.close(() => r()));
});

afterAll(() => server.close());

afterEach(() => {
  vi.restoreAllMocks();
  dials.length = 0;
  seen.length = 0;
  drop.clear();
  reset.clear();
});

/* ---------------------------------------------------------------- helpers */

/** The kiosk's till parameters: `pinpadAllowHttp` as given; nothing pinned, no scheme remembered. */
function context(allowHttp: boolean): ProviderContext {
  const values = new Map<string, string>();
  return {
    machineId: 'm-1',
    nextSequence: () => 40,
    getValue: (k) => values.get(k) ?? null,
    setValue: (k, v) => {
      values.set(k, v);
    },
    parameter: (k) => (k === 'pinpadAllowHttp' && allowHttp ? 'true' : null),
    log: () => undefined,
  };
}

/** The LAN provider at [address]; each frame it tries (by method) and each pause it takes. */
function lan(address: PinpadAddress, allowHttp: boolean) {
  const tried: string[] = [];
  const pauses: number[] = [];
  const p = new NayaxLanProvider(address, context(allowHttp), async (ms) => {
    pauses.push(ms);
  });
  const own = p as unknown as { call: CallFn };
  const call = own.call;
  own.call = (frame, timeoutMs) => {
    tried.push((JSON.parse(frame) as { method: string }).method);
    return call(frame, timeoutMs);
  };
  return { p, tried, pauses };
}

const sale = (p: NayaxLanProvider, reference = 'v40') => p.sale({ amountAgorot: 100, reference, payments: 1 });

function payService() {
  const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), 'kd-lan-')), 'k.db'));
  migrate(db);
  const logs: string[] = [];
  const svc = new PayService(db, (m) => logs.push(m));
  svc.setLockOnUnresolved(() => true);
  return { svc, logs };
}

/* ------------------------------------------------------------------ tests */

describe('the pinpad on the LAN: a sale frame that never reached it is "not sent", never "unknown"', () => {
  it('plain HTTP not allowed by the settings: NOT_SENT with its reason — nothing dialled, no abort, no lookup', async () => {
    network({ loopback: pinpadPort });
    const off = lan(HTTP, false);
    expect(await sale(off.p)).toEqual({ answer: 'NOT_SENT', message: `${NO_LINK}: http_not_allowed` });
    expect(off.tried).toEqual(['doTransaction']);
    expect(off.pauses).toEqual([]);

    // The parameter on, but the address is not on the shop's own network (RFC 1918): not allowed either.
    const pub = lan({ ...HTTP, host: '203.0.113.7' }, true);
    expect(await sale(pub.p)).toEqual({ answer: 'NOT_SENT', message: 'אין חיבור למסוף (203.0.113.7:8080): http_not_allowed' });
    expect(pub.tried).toEqual(['doTransaction']);

    expect(dials).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('the connection refused — over HTTPS, over HTTP, or while finding out which: NOT_SENT, nothing written', async () => {
    network({ loopback: closedPort });
    const cases: Array<[PinpadAddress, boolean, string]> = [
      [HTTPS, false, 'tls'], // https
      [HTTP, true, 'net'], // http
      [HTTPS, true, 'tls'], // detect: getStatus over HTTPS first
    ];
    for (const [address, allowHttp, kind] of cases) {
      dials.length = 0;
      const { p, tried, pauses } = lan(address, allowHttp);
      const r = await sale(p);
      expect(r.answer).toBe('NOT_SENT');
      if (r.answer === 'NOT_SENT') {
        expect(r.message.startsWith(`${NO_LINK}: `)).toBe(true);
        expect(r.message).toContain('ECONNREFUSED');
      }
      expect(tried).toEqual(['doTransaction']);
      expect(pauses).toEqual([]);
      expect(dials).toEqual([`${kind} 192.168.0.167:8080`]);
    }
  });

  it('no such host, or no route to it: NOT_SENT, nothing written', async () => {
    network({ dns: 'ENOTFOUND' });
    const named = lan({ ...HTTPS, host: 'pinpad.shop.lan' }, false);
    expect(await sale(named.p)).toEqual({ answer: 'NOT_SENT', message: 'אין חיבור למסוף (pinpad.shop.lan:8080): getaddrinfo ENOTFOUND pinpad.shop.lan' });
    expect(named.pauses).toEqual([]);
    vi.restoreAllMocks();

    for (const code of ['EHOSTUNREACH', 'ENETUNREACH']) {
      for (const [address, allowHttp] of [
        [HTTPS, false],
        [HTTP, true],
      ] as const) {
        network({ unreachable: code });
        const { p, tried, pauses } = lan(address, allowHttp);
        expect(await sale(p)).toEqual({ answer: 'NOT_SENT', message: `${NO_LINK}: connect ${code} 192.168.0.167:8080` });
        expect(tried).toEqual(['doTransaction']);
        expect(pauses).toEqual([]);
        vi.restoreAllMocks();
      }
    }
  });

  it('finding out the scheme: the getStatus written and its reply lost — the sale frame never went: NOT_SENT', async () => {
    // HTTPS refused at the handshake (an HTTP-only pinpad), then getStatus over HTTP read and dropped.
    network({ loopback: pinpadPort });
    drop.add('getStatus');
    const { p, pauses } = lan(HTTPS, true);
    const r = await sale(p);
    expect(r.answer).toBe('NOT_SENT');
    if (r.answer === 'NOT_SENT') expect(r.message.startsWith(`${NO_LINK}: `)).toBe(true);
    expect(seen).toEqual(['getStatus']);
    expect(pauses).toEqual([]);
  });

  it("the kiosk's charge: voided with the reason, the attempt dropped — no lookup, no abort, no unresolved alert", async () => {
    network({ loopback: closedPort });
    const { svc, logs } = payService();

    const off = lan(HTTP, false);
    svc.setProvider(off.p, 'nayax_lan');
    expect(await svc.charge({ transactionId: 't-40', orderId: 'o-40', amountAgorot: 100, tipAgorot: 0 })).toEqual({
      kind: 'declined',
      message: `${NO_LINK}: http_not_allowed`,
      voidMeta: null,
    });
    expect(off.tried).toEqual(['doTransaction']);

    const refused = lan(HTTPS, false);
    svc.setProvider(refused.p, 'nayax_lan');
    const out = await svc.charge({ transactionId: 't-41', orderId: 'o-41', amountAgorot: 100, tipAgorot: 0 });
    expect(out.kind).toBe('declined');
    if (out.kind === 'declined') {
      expect(out.message).toContain('ECONNREFUSED');
      expect(out.voidMeta).toBe(null);
    }
    expect(refused.tried).toEqual(['doTransaction']);
    expect(refused.pauses).toEqual([]);

    expect(svc.attempts()).toEqual([]);
    expect(svc.unresolved()).toBe(false);
    expect(svc.blocked()).toBe(false);
    expect(svc.cardInFlight).toBe(false);
    expect(logs.filter((m) => m.startsWith('card: not sent')).length).toBe(2);
  });

  it('the frame written, then its reply lost: still "unknown" — settled by its vuid, never sent twice', async () => {
    network({ loopback: pinpadPort });
    drop.add('doTransaction');
    const alone = lan(HTTP, true);
    const r = await sale(alone.p, 'v41');
    expect(r.answer).toBe('UNKNOWN');
    expect(seen).toEqual(['doTransaction']);

    seen.length = 0;
    const { svc } = payService();
    const { p, tried } = lan(HTTP, true);
    svc.setProvider(p, 'nayax_lan');
    const out = await svc.charge({ transactionId: 't-42', orderId: 'o-42', amountAgorot: 100, tipAgorot: 0 });
    expect(out.kind).toBe('approved');
    if (out.kind === 'approved') expect(out.recovered).toBe(true);
    expect(tried).toEqual(['doTransaction', 'getTransactionByVuid']);
    expect(seen).toEqual(['doTransaction', 'getTransactionByVuid']);
  });

  it('finding out the scheme: the sale written over HTTPS, then the connection reset — unknown, never sent again over HTTP', async () => {
    network({ loopback: pinpadPort, tlsTaken: true });
    reset.add('doTransaction');
    const { p, pauses } = lan(HTTPS, true);
    const r = await sale(p);
    expect(r.answer).toBe('UNKNOWN');
    expect(seen).toEqual(['getStatus', 'doTransaction']);
    expect(dials).toEqual(['tls 192.168.0.167:8080', 'tls 192.168.0.167:8080']);
    expect(pauses).toEqual([]);
  });
});
