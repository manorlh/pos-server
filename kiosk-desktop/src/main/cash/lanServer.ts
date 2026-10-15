/**
 * The cash host's LAN API (P:/specs/cash-paylink.md §11.4) on http://0.0.0.0:<port>: plain
 * node:http, JSON, every call but `GET /cash/health` signed (auth.ts), and a WebSocket per station
 * for the client's own transactions, the station's status and its place in the queue.
 *
 * Kiosks (Windows and Android) and, in stage 3, tills are its only callers — never a browser: no
 * CORS. Every call is logged (method, path, client, status, time — never a body or a signature).
 */

import http from 'node:http';
import type { Duplex } from 'node:stream';
import { CASH_API, CASH_ERRORS, CASH_H, matchRoute, type CashEvent, type CashHealth, type CashRoute } from '../../core/cash/lanProtocol';
import { acceptUpgrade, refuseUpgrade, type WsConnection } from '../bridge/ws';
import { CASH_AUTH_TEXT, NonceCache, verifyCash } from './auth';

export interface CashLanHost {
  health(): CashHealth;
  hostSecret(): string | null;
  knownClient(clientId: string): boolean;
  /** A signed call: the station answers (main/cash/station.ts Reply). */
  call(route: CashRoute, clientId: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** May this client watch this station (assigned to it)? */
  mayWatch(stationId: string, clientId: string): boolean;
  onEvent(stationId: string, fn: (e: CashEvent, clientId: string | null) => void): () => void;
  now(): number;
  log(m: string): void;
}

const MAX_BODY = 64 * 1024;

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

function header(v: string | string[] | undefined): string | null {
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

export class CashLanServer {
  private server: http.Server;
  private readonly nonces = new NonceCache();
  private readonly sockets = new Set<{ ws: WsConnection; off: () => void }>();
  private port = 0;

  constructor(
    private readonly host: CashLanHost,
    private readonly opts: { port: number; hostname?: string },
  ) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.keepAliveTimeout = 5_000;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      this.server.once('error', onError);
      this.server.listen(this.opts.port, this.opts.hostname ?? '0.0.0.0', () => {
        this.server.off('error', onError);
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        resolve(this.port);
      });
    });
  }

  get listeningPort(): number {
    return this.port;
  }

  close(): Promise<void> {
    for (const s of this.sockets) {
      s.off();
      s.ws.close(1001);
    }
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    const text = status === 204 ? '' : JSON.stringify(body ?? null);
    res.writeHead(status, {
      ...(status === 204 ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-R2M-Time': String(this.host.now()),
    });
    res.end(text);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const t0 = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://cash');
    let status = 500;
    let client: string | null = null;
    const done = (s: number, body: unknown) => {
      status = s;
      this.send(res, s, body);
    };
    try {
      const route = matchRoute(method, url.pathname);
      if (!route) return done(404, { error: 'not_found', api: CASH_API });
      if (route.kind === 'health') return done(200, this.host.health());
      if (route.kind === 'events') return done(400, { error: 'websocket', message: 'WebSocket only' });
      let raw: Buffer = Buffer.alloc(0);
      if (method === 'POST' || method === 'DELETE') {
        try {
          raw = await readBody(req);
        } catch {
          return done(CASH_ERRORS.too_large, { error: 'too_large' });
        }
      }
      const auth = verifyCash({
        method,
        path: url.pathname + url.search,
        headers: { client: header(req.headers[CASH_H.client]), ts: header(req.headers[CASH_H.ts]), nonce: header(req.headers[CASH_H.nonce]), sig: header(req.headers[CASH_H.sig]) },
        body: raw,
        hostSecret: this.host.hostSecret(),
        knownClient: (id) => this.host.knownClient(id),
        nonces: this.nonces,
        now: this.host.now(),
      });
      if (!auth.ok) return done(401, { error: 'auth', why: auth.why, message: CASH_AUTH_TEXT[auth.why] });
      client = auth.clientId;
      let body: Record<string, unknown> = {};
      if (raw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw.toString('utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch {
          return done(400, { error: 'json' });
        }
      }
      const r = await this.host.call(route, client, body);
      return done(r.status, r.body);
    } catch (e) {
      if (!res.headersSent) done(500, { error: 'internal', message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.host.log(`[cash lan] ${method} ${url.pathname} ${client ?? '-'} ${status} ${Date.now() - t0}ms`);
    }
  }

  /** `GET /cash/stations/{id}/events?client=&ts=&nonce=&sig=` — signed over GET + the path, empty body. */
  private upgrade(req: http.IncomingMessage, socket: Duplex, _head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://cash');
    const route = matchRoute('GET', url.pathname);
    if (!route || route.kind !== 'events') return refuseUpgrade(socket, 404, 'Not Found');
    const q = url.searchParams;
    const auth = verifyCash({
      method: 'GET',
      path: url.pathname,
      headers: { client: q.get('client'), ts: q.get('ts'), nonce: q.get('nonce'), sig: q.get('sig') },
      body: '',
      hostSecret: this.host.hostSecret(),
      knownClient: (id) => this.host.knownClient(id),
      nonces: this.nonces,
      now: this.host.now(),
    });
    if (!auth.ok) {
      this.host.log(`[cash lan] WS ${url.pathname} 401 ${auth.why}`);
      return refuseUpgrade(socket, 401, 'Unauthorized');
    }
    if (!this.host.mayWatch(route.stationId, auth.clientId)) return refuseUpgrade(socket, 403, 'Forbidden');
    const ws = acceptUpgrade(req, socket);
    if (!ws) return refuseUpgrade(socket, 400, 'Bad Request');
    const clientId = auth.clientId;
    const off = this.host.onEvent(route.stationId, (e, to) => {
      // A transaction / lease goes to its own client only; the station's status to everyone watching.
      if (to !== null && to !== clientId) return;
      if (e.type === 'status' && ws.isOpen) {
        ws.send({ ...e, status: { ...e.status } });
        return;
      }
      if (ws.isOpen) ws.send(e);
    });
    const entry = { ws, off };
    this.sockets.add(entry);
    ws.onClose(() => {
      off();
      this.sockets.delete(entry);
    });
    this.host.log(`[cash lan] WS ${url.pathname} ${clientId} 101`);
  }
}
