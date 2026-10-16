/**
 * The cash host's side of the cloud relay (P:/specs/cash-paylink.md §14.4): the calls of the clients whose
 * `cashRoute` is cloud / auto, taken from the cloud and run exactly as LAN calls.
 *
 *  - a long poll (`POST /sync/{host}/cash/relay/poll`, up to 20 s — the Windows app has no realtime channel), only
 *    while a station of this host has such a client (`relay` in §11.2) — never otherwise;
 *  - each call: not older than 10 s at the cloud (`ageMs`), signed by its client exactly as on the LAN (§11.3 —
 *    one nonce cache with the LAN API), its `client` the device the cloud vouches for, one of §11.4's calls — then
 *    run (`CashHost.call`, `via: cloud`: the lease kept 20 s, every call renewing it);
 *  - its answer in the very next poll (the cloud holds the client's request open for it).
 *
 * Never throws; no internet — tried again (1 s, doubling to 10 s). Bodies never logged.
 */

import { CASH_API, matchRoute, type CashRoute } from '../../core/cash/lanProtocol';
import { RELAY_EXECUTE_MAX_AGE_MS, RELAY_HOST_WAIT_MS, type CashVia } from '../../core/cash/route';
import type { ApiReply } from '../sync/api';
import { CASH_AUTH_TEXT, verifyCash, type NonceCache } from './auth';

export interface RelayRequest {
  requestId: string;
  clientId: string;
  stationId: string;
  method: string;
  path: string;
  client: string;
  ts: string;
  nonce: string;
  sig: string;
  body: string;
  ageMs: number;
}

export interface RelayReply {
  requestId: string;
  status: number;
  body: unknown;
  hostTime: number;
}

/** What the worker needs of the host (main/cash/host.ts). */
export interface RelayHost {
  hostSecret(): string | null;
  knownClient(clientId: string): boolean;
  call(route: CashRoute, clientId: string, body: Record<string, unknown>, via?: CashVia): Promise<{ status: number; body: unknown }>;
  now(): number;
  log(m: string): void;
}

export interface RelayDeps {
  api: { post<T = unknown>(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<ApiReply<T>> };
  machineId(): string | null;
  host: RelayHost;
  /** The LAN API's nonce cache: a call is taken once, whichever way it came. */
  nonces: NonceCache;
  /** A station of this host has a client not on the LAN (§11.2 `relay`). */
  wanted(): boolean;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

const REPLIES_KEPT = 100;
const IDLE_MS = 3_000;
/** The cloud said no client routes through it: asked again after this (the §11.2 pull is every 25 s). */
const OFF_MS = 25_000;

export class CashRelayWorker {
  private replies: RelayReply[] = [];
  private stopped = true;
  private offUntil = 0;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private handled = 0;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: RelayDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  /** Stops after the poll in flight (whose calls are still answered by the cloud's lapse rules). */
  stop(): void {
    this.stopped = true;
  }

  get running(): boolean {
    return !this.stopped;
  }

  view() {
    return { listening: !this.stopped && this.d.wanted(), lastPollAt: this.lastPollAt, lastError: this.lastError, handled: this.handled };
  }

  private async loop(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped) {
      if ((!this.d.wanted() || this.d.host.now() < this.offUntil) && this.replies.length === 0) {
        await this.sleep(IDLE_MS);
        continue;
      }
      const r = await this.pollOnce(this.d.waitMs ?? RELAY_HOST_WAIT_MS).catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
        return { ok: false, relay: true, handled: 0 };
      });
      if (!r.ok) {
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 10_000);
        continue;
      }
      backoff = 1_000;
      if (!r.relay && r.handled === 0) this.offUntil = this.d.host.now() + OFF_MS;
    }
  }

  /** One poll: the answers given back, the calls taken and run (their answers go with the next poll). */
  async pollOnce(waitMs: number): Promise<{ ok: boolean; relay: boolean; handled: number }> {
    const m = this.d.machineId();
    if (!m) return { ok: false, relay: false, handled: 0 };
    const replies = this.replies.splice(0);
    const r = await this.d.api.post<{ relay?: boolean; requests?: RelayRequest[] }>(`sync/${m}/cash/relay/poll`, { replies, waitMs }, { timeoutMs: waitMs + 10_000 });
    this.lastPollAt = this.d.host.now();
    if (r.kind !== 'ok') {
      // Kept for the next poll (the cloud takes an answer once; a repeat is ignored).
      this.replies = [...replies, ...this.replies].slice(-REPLIES_KEPT);
      this.lastError = r.kind === 'offline' ? r.reason : `HTTP ${r.status}`;
      return { ok: false, relay: true, handled: 0 };
    }
    this.lastError = null;
    const requests = Array.isArray(r.body?.requests) ? r.body.requests : [];
    for (const q of requests) {
      if (!q || typeof q.requestId !== 'string') continue;
      this.replies.push(await this.handle(q));
      this.handled++;
    }
    return { ok: true, relay: r.body?.relay !== false, handled: requests.length };
  }

  /** One call, checked as the LAN API checks it, run as a LAN call. */
  async handle(q: RelayRequest): Promise<RelayReply> {
    const t0 = this.d.host.now();
    const answer = (status: number, body: unknown): RelayReply => {
      this.d.host.log(`[cash relay] ${q.method} ${q.path} ${q.clientId ?? '-'} ${status} ${this.d.host.now() - t0}ms (age ${q.ageMs}ms)`);
      return { requestId: q.requestId, status, body, hostTime: this.d.host.now() };
    };
    if (typeof q.ageMs !== 'number' || q.ageMs > RELAY_EXECUTE_MAX_AGE_MS) return answer(504, { error: 'expired', message: 'הבקשה הגיעה באיחור — לא בוצעה' });
    if (typeof q.client !== 'string' || typeof q.clientId !== 'string' || q.client.toLowerCase() !== q.clientId.toLowerCase()) {
      return answer(403, { error: 'not_assigned', message: 'הבקשה אינה של המכשיר ששלח אותה' });
    }
    const method = typeof q.method === 'string' ? q.method.toUpperCase() : '';
    const body = typeof q.body === 'string' ? q.body : '';
    const auth = verifyCash({
      method,
      path: q.path,
      headers: { client: q.client, ts: q.ts, nonce: q.nonce, sig: q.sig },
      body,
      hostSecret: this.d.host.hostSecret(),
      knownClient: (id) => this.d.host.knownClient(id),
      nonces: this.d.nonces,
      now: this.d.host.now(),
    });
    if (!auth.ok) return answer(401, { error: 'auth', why: auth.why, message: CASH_AUTH_TEXT[auth.why] });
    const route = typeof q.path === 'string' ? matchRoute(method, q.path) : null;
    if (!route || route.kind === 'health' || route.kind === 'events') return answer(404, { error: 'not_found', api: CASH_API });
    let parsed: Record<string, unknown> = {};
    if (body) {
      try {
        const v: unknown = JSON.parse(body);
        if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
      } catch {
        return answer(400, { error: 'json' });
      }
    }
    try {
      const r = await this.d.host.call(route, auth.clientId, parsed, 'cloud');
      return answer(r.status, r.status === 204 ? null : r.body);
    } catch (e) {
      return answer(500, { error: 'internal', message: e instanceof Error ? e.message : String(e) });
    }
  }
}
