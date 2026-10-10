/**
 * The bridge's local API on http://127.0.0.1:<port> (core/bridgeProtocol.ts; docs/SPEC_KIOSK.md
 * §28): plain node:http, one listener on the loopback address only.
 *
 *   GET  /health          no signature — "a bridge is here", its version, whether a page is paired
 *   POST /pair            no signature — the 6-digit code → the pairing's id and secret (once)
 *   *    everything else  signed by the paired page (auth.ts), and allowed by its role's caps
 *   GET  /events          WebSocket, signed in the query: payment progress pushed as it happens
 *
 * Every request must come from an allowed origin (no Origin, another site → 403 without CORS
 * headers, so the page cannot even read the refusal) and name the loopback host (no DNS
 * rebinding). Chrome / Edge's Private Network Access preflight is answered. Every call is logged
 * (method, path, origin, status, time — never a body, a code, a token or a PIN).
 */

import http from 'node:http';
import type { Duplex } from 'node:stream';
import {
  corsHeaders,
  EMPTY_SHA256,
  H,
  normalizeOrigin,
  originAllowed,
  ROLE_CAPS,
  ROUTE_CAPS,
  routeKey,
  roleOf,
  type BridgeHealth,
  type BridgeRole,
} from '../../core/bridgeProtocol';
import type { PayProgress } from '../../shared/bridge';
import { AUTH_TEXT, NonceCache, verifyRequest } from './auth';
import { acceptUpgrade, refuseUpgrade, type WsConnection } from './ws';

export interface CallLogEntry {
  at: number;
  method: string;
  path: string;
  origin: string | null;
  status: number;
  ms: number;
  note?: string | null;
}

export type BridgeEvent = { type: 'pay'; progress: PayProgress } | { type: 'status' };

export interface PairingSecret {
  pairingId: string;
  secret: Uint8Array;
  role: BridgeRole;
}

export interface BridgeHost {
  allowedOrigins(): string[];
  health(): BridgeHealth;
  pairingSecret(): PairingSecret | null;
  pair(input: { code: string; role: BridgeRole; url: string | null; origin: string; device: Record<string, string> }): { status: number; body: unknown };
  call(route: string, body: unknown, ctx: { role: BridgeRole; origin: string; query: URLSearchParams }): Promise<{ status: number; body: unknown }>;
  logCall(e: CallLogEntry): void;
  onEvent(fn: (e: BridgeEvent) => void): () => void;
  now(): number;
}

const MAX_BODY = 256 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function strHeader(v: string | string[] | undefined): string | null {
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

/** The loopback names a page may use (anything else is another host, e.g. DNS rebinding). */
export function hostAllowed(host: string | null, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

export class BridgeServer {
  private server: http.Server;
  private readonly nonces = new NonceCache();
  private readonly sockets = new Set<WsConnection>();
  private port = 0;
  private offEvents: (() => void) | null = null;

  constructor(
    private readonly host: BridgeHost,
    private readonly opts: { port: number; hostname?: string },
  ) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.keepAliveTimeout = 5_000;
  }

  /** Listens on the loopback address; the port actually taken (0 in tests = any). */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      this.server.once('error', onError);
      this.server.listen(this.opts.port, this.opts.hostname ?? '127.0.0.1', () => {
        this.server.off('error', onError);
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        this.offEvents = this.host.onEvent((e) => {
          for (const s of this.sockets) if (s.isOpen) s.send(e);
        });
        resolve(this.port);
      });
    });
  }

  get listeningPort(): number {
    return this.port;
  }

  close(): Promise<void> {
    this.offEvents?.();
    for (const s of this.sockets) s.close(1001);
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = status === 204 ? '' : JSON.stringify(body ?? null);
    res.writeHead(status, {
      ...headers,
      ...(status === 204 ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const t0 = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = strHeader(req.headers.origin);
    const norm = normalizeOrigin(origin);
    let status = 500;
    let note: string | null = null;
    const done = (s: number, body: unknown, headers: Record<string, string> = {}, why: string | null = null) => {
      status = s;
      note = why;
      this.send(res, s, body, headers);
    };
    try {
      if (!hostAllowed(strHeader(req.headers.host), this.port)) return done(403, { error: 'host', message: 'כתובת לא מוכרת' }, {}, 'host');
      if (!norm || !originAllowed(norm, this.host.allowedOrigins())) {
        return done(403, { error: 'origin', message: 'האתר הזה אינו מורשה להשתמש בגשר' }, {}, `origin ${origin ?? '-'}`);
      }
      const preflight = method === 'OPTIONS';
      const cors = corsHeaders(norm, {
        preflight,
        privateNetwork: strHeader(req.headers['access-control-request-private-network']) === 'true',
        localNetwork: strHeader(req.headers['access-control-request-local-network']) === 'true',
      });
      if (preflight) return done(204, null, cors, 'preflight');
      if (method !== 'GET' && method !== 'POST') return done(405, { error: 'method' }, cors);
      let raw: Buffer = Buffer.alloc(0);
      if (method === 'POST') {
        try {
          raw = await readBody(req);
        } catch {
          return done(413, { error: 'too_large' }, cors);
        }
      }
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return done(400, { error: 'json' }, cors);
        }
      }
      const path = url.pathname;
      if (method === 'GET' && path === '/health') return done(200, this.host.health(), cors);
      if (method === 'POST' && path === '/pair') {
        const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const role = roleOf(b.role);
        if (!role) return done(400, { error: 'role', message: 'תפקיד הדף לא מוכר' }, cors);
        const device: Record<string, string> = {};
        if (b.device && typeof b.device === 'object') {
          for (const [k, v] of Object.entries(b.device as Record<string, unknown>).slice(0, 12)) if (typeof v === 'string') device[k.slice(0, 40)] = v.slice(0, 120);
        }
        const r = this.host.pair({ code: typeof b.code === 'string' ? b.code : '', role, url: typeof b.url === 'string' ? b.url.slice(0, 500) : null, origin: norm, device });
        return done(r.status, r.body, cors, `pair ${role}`);
      }
      const route = routeKey(method, path);
      if (!(route in ROUTE_CAPS)) return done(404, { error: 'not_found' }, cors);
      const pairing = this.host.pairingSecret();
      const auth = verifyRequest({
        method,
        path: path + url.search,
        headers: {
          key: strHeader(req.headers[H.key]),
          ts: strHeader(req.headers[H.ts]),
          nonce: strHeader(req.headers[H.nonce]),
          sig: strHeader(req.headers[H.sig]),
        },
        body: raw,
        pairing,
        nonces: this.nonces,
        now: this.host.now(),
      });
      if (!auth.ok) return done(401, { error: 'auth', why: auth.why, message: AUTH_TEXT[auth.why] }, cors, `auth ${auth.why}`);
      const need = ROUTE_CAPS[route];
      if (need && !ROLE_CAPS[pairing!.role][need]) {
        return done(403, { error: 'capability', capability: need, message: 'הפעולה הזו אינה זמינה לתפקיד של הדף' }, cors, `cap ${need}`);
      }
      const r = await this.host.call(route, body, { role: pairing!.role, origin: norm, query: url.searchParams });
      return done(r.status, r.body, cors);
    } catch (e) {
      if (!res.headersSent) done(500, { error: 'internal', message: e instanceof Error ? e.message : String(e) }, norm ? corsHeaders(norm, { preflight: false }) : {}, 'error');
    } finally {
      this.host.logCall({ at: t0, method, path: url.pathname, origin: norm ?? origin, status, ms: Date.now() - t0, note });
    }
  }

  /** `GET /events?key=&ts=&nonce=&sig=` — the signature over `GET /events` and an empty body. */
  private upgrade(req: http.IncomingMessage, socket: Duplex, _head: Buffer) {
    const t0 = Date.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = normalizeOrigin(strHeader(req.headers.origin));
    const log = (status: number, note: string | null) =>
      this.host.logCall({ at: t0, method: 'WS', path: url.pathname, origin, status, ms: Date.now() - t0, note });
    if (url.pathname !== '/events' || !hostAllowed(strHeader(req.headers.host), this.port)) {
      log(404, null);
      return refuseUpgrade(socket, 404, 'Not Found');
    }
    if (!origin || !originAllowed(origin, this.host.allowedOrigins())) {
      log(403, 'origin');
      return refuseUpgrade(socket, 403, 'Forbidden');
    }
    const q = url.searchParams;
    const auth = verifyRequest({
      method: 'GET',
      path: '/events',
      headers: { key: q.get('key'), ts: q.get('ts'), nonce: q.get('nonce'), sig: q.get('sig') },
      body: '',
      pairing: this.host.pairingSecret(),
      nonces: this.nonces,
      now: this.host.now(),
    });
    if (!auth.ok) {
      log(401, `auth ${auth.why}`);
      return refuseUpgrade(socket, 401, 'Unauthorized');
    }
    const ws = acceptUpgrade(req, socket);
    if (!ws) {
      log(400, 'not websocket');
      return refuseUpgrade(socket, 400, 'Bad Request');
    }
    this.sockets.add(ws);
    ws.onClose(() => this.sockets.delete(ws));
    log(101, null);
  }

  /** Every socket closed (the pairing changed). */
  dropSockets() {
    for (const s of this.sockets) s.close(4001);
    this.sockets.clear();
  }
}

/** For tests: the canonical body hash of a GET. */
export const GET_BODY_SHA = EMPTY_SHA256;
