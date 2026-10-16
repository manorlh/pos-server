/**
 * The kiosk's client of a cash station (P:/specs/cash-paylink.md §11.3–§11.6), three ways to the same calls (§14):
 *
 *  - `CashLanClient` — signed calls to the cash host on the shop's LAN (`cashRoute` lan, the default), with the
 *    host's clock learned from every answer (`X-R2M-Time`) and one retry when the clock was off;
 *  - `CashCloudClient` — the same call, signed the same way, handed to the cloud relay (§14.4) for the host, and its
 *    answer back (`cashRoute` cloud / auto);
 *  - `CashLocalClient` — a host kiosk's own payments at its own station (§14.1): straight into the host in this app.
 *
 * Never throws on the network: `offline` is an answer (no answer at all — the station may or may not have it).
 */

import { randomUUID } from 'node:crypto';
import { LEASE_RENEW_MS, matchRoute, stationPath, type CashRoute, type LeaseView, type StationStatus } from '../../core/cash/lanProtocol';
import { CLOUD_LEASE_RENEW_MS, RELAY_CALL_DEADLINE_MS, RELAY_CLIENT_WAIT_MS, type CashVia } from '../../core/cash/route';
import type { OwedChoice, TxView } from '../../core/cash/tx';
import type { ApiReply } from '../sync/api';
import { newNonce, signCash, signedHeaders } from './auth';

export interface CashStationRef {
  stationId: string;
  name: string;
  location: string | null;
  hostId: string;
  hostName: string | null;
  lanAddress: string | null;
  port: number;
  /** This client's own secret (§11.3), from the cloud. */
  secret: string;
}

export type CashReply<T> = { kind: 'ok'; status: number; body: T } | { kind: 'refused'; status: number; error: string; body: Record<string, unknown> } | { kind: 'offline'; reason: string };

type Method = 'GET' | 'POST' | 'DELETE';

/** The §11.4 calls, whichever way they go. */
export abstract class CashCalls {
  abstract readonly via: CashVia;

  /** How often the lease is renewed this way (a relayed one: 5 s, §14.4). */
  get renewMs(): number {
    return LEASE_RENEW_MS;
  }

  abstract get station(): CashStationRef;

  abstract setStation(ref: CashStationRef): void;

  abstract request<T>(method: Method, rest: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<CashReply<T>>;

  status() {
    return this.request<StationStatus>('GET', 'status', undefined, 3_000);
  }

  lease(leaseId: string | null, txId?: string, amountAgorot?: number) {
    return this.request<LeaseView>('POST', 'lease', { ...(leaseId ? { leaseId } : {}), ...(txId ? { txId } : {}), ...(amountAgorot ? { amountAgorot } : {}) }, 4_000);
  }

  release(leaseId: string) {
    return this.request<null>('DELETE', `lease/${encodeURIComponent(leaseId)}`, {}, 4_000);
  }

  start(txId: string, body: { leaseId: string; amountAgorot: number; orderRef: string | null; orderLabel: string | null }) {
    return this.request<TxView>('POST', `tx/${txId}/start`, { ...body, kind: 'sale' });
  }

  tx(txId: string) {
    return this.request<TxView>('GET', `tx/${txId}`, undefined, 4_000);
  }

  cancel(txId: string, reason: 'customer' | 'timeout' | 'kiosk') {
    return this.request<TxView>('POST', `tx/${txId}/cancel`, { reason });
  }

  ack(txId: string, documentId: string | null, documentNumber: string | null, orderLabel: string | null = null, extra: { changeOwedAs?: OwedChoice | null; void?: boolean } = {}) {
    return this.request<TxView>('POST', `tx/${txId}/ack`, {
      ...(documentId ? { documentId } : {}),
      ...(documentNumber ? { documentNumber } : {}),
      ...(orderLabel ? { orderLabel } : {}),
      ...(extra.changeOwedAs ? { changeOwedAs: extra.changeOwedAs } : {}),
      ...(extra.void ? { void: true } : {}),
    });
  }

  /** "להשלים באשראי" (§11.15ב): the cash part so far, the rest by card. */
  split(txId: string) {
    return this.request<TxView>('POST', `tx/${txId}/split`, {});
  }

  /** The card paid the rest: the cash part is paid. */
  finish(txId: string) {
    return this.request<TxView>('POST', `tx/${txId}/finish`, {});
  }
}

/** A host's answer (status + body) as a reply: 2xx — ok; else refused with its `error`. */
function replyOf<T>(status: number, parsed: unknown): CashReply<T> {
  if (status >= 200 && status < 300) return { kind: 'ok', status, body: (status === 204 ? null : parsed) as T };
  const b = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return { kind: 'refused', status, error: typeof b.error === 'string' ? b.error : `http_${status}`, body: b };
}

/** On the shop's LAN (§11.3–§11.4). */
export class CashLanClient extends CashCalls {
  readonly via = 'lan' as const;
  /** The host's clock minus ours. */
  private skewMs = 0;

  constructor(
    private readonly clientId: string,
    private ref: CashStationRef,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  get station(): CashStationRef {
    return this.ref;
  }

  setStation(ref: CashStationRef) {
    this.ref = ref;
  }

  private base(): string | null {
    return this.ref.lanAddress ? `http://${this.ref.lanAddress.includes(':') && !this.ref.lanAddress.startsWith('[') ? `[${this.ref.lanAddress}]` : this.ref.lanAddress}:${this.ref.port}` : null;
  }

  async request<T>(method: Method, rest: string, body?: Record<string, unknown>, timeoutMs = 6_000, retried = false): Promise<CashReply<T>> {
    const base = this.base();
    if (!base) return { kind: 'offline', reason: 'no address' };
    const path = stationPath(this.ref.stationId, rest);
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...signedHeaders({ clientId: this.clientId, clientSecret: this.ref.secret, method, path, body: text, now: this.now() + this.skewMs }),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    let res: Response;
    try {
      res = await this.fetchFn(base + path, { method, headers, body: body === undefined ? undefined : text, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { kind: 'offline', reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
    const hostTime = Number(res.headers.get('x-r2m-time'));
    if (Number.isFinite(hostTime) && hostTime > 0) this.skewMs = hostTime - this.now();
    const raw = await res.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    const r = replyOf<T>(res.status, parsed);
    if (r.kind === 'refused' && res.status === 401 && r.body.why === 'clock' && !retried) return this.request<T>(method, rest, body, timeoutMs, true);
    return r;
  }
}

/** The cloud's client API the relay needs (main/sync/api.ts `Api`). */
export interface RelayCloud {
  get<T = unknown>(path: string, opts?: { timeoutMs?: number }): Promise<ApiReply<T>>;
  post<T = unknown>(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<ApiReply<T>>;
}

/** The cloud relay's answer to a client (§14.4). */
export interface RelayAnswer {
  api?: number;
  requestId?: string;
  state?: 'pending' | 'done' | 'expired' | 'lost' | string;
  reply?: { status?: number; body?: unknown; hostTime?: number | null };
}

/** The relay's envelope for one signed call (§14.4) — what `POST /sync/{client}/cash/relay` takes. */
export function relayEnvelope(o: { requestId: string; stationId: string; method: string; path: string; clientId: string; secret: string; ts: number | string; nonce: string; body: string; waitMs: number }) {
  const ts = String(typeof o.ts === 'number' ? Math.round(o.ts) : o.ts);
  return {
    requestId: o.requestId,
    stationId: o.stationId,
    method: o.method,
    path: o.path,
    client: o.clientId,
    ts,
    nonce: o.nonce,
    sig: signCash(o.secret, o.method, o.path, ts, o.nonce, o.body),
    body: o.body,
    waitMs: o.waitMs,
  };
}

/**
 * Through the cloud relay (§14.4): the call signed exactly as on the LAN, kept by the cloud for the station's host
 * and its answer awaited (`pending` — asked again until `RELAY_CALL_DEADLINE_MS`). `expired` / `lost` / no internet —
 * no answer, like a LAN timeout. A cloud refusal (not assigned, the route is the LAN, no host…) — refused with its code.
 */
export class CashCloudClient extends CashCalls {
  readonly via = 'cloud' as const;
  private skewMs = 0;

  constructor(
    private readonly clientId: string,
    private ref: CashStationRef,
    private readonly cloud: RelayCloud,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => randomUUID(),
    private readonly nonce: () => string = newNonce,
  ) {
    super();
  }

  override get renewMs(): number {
    return CLOUD_LEASE_RENEW_MS;
  }

  get station(): CashStationRef {
    return this.ref;
  }

  setStation(ref: CashStationRef) {
    this.ref = ref;
  }

  async request<T>(method: Method, rest: string, body?: Record<string, unknown>, _timeoutMs?: number, retried = false): Promise<CashReply<T>> {
    if (!this.ref.secret || !this.ref.hostId) return { kind: 'offline', reason: 'no station' };
    const path = stationPath(this.ref.stationId, rest);
    const text = body === undefined ? '' : JSON.stringify(body);
    const requestId = this.newId();
    const deadline = this.now() + RELAY_CALL_DEADLINE_MS;
    const waitFor = () => Math.max(0, Math.min(RELAY_CLIENT_WAIT_MS, deadline - this.now()));
    const wait = waitFor();
    const envelope = relayEnvelope({ requestId, stationId: this.ref.stationId, method, path, clientId: this.clientId, secret: this.ref.secret, ts: this.now() + this.skewMs, nonce: this.nonce(), body: text, waitMs: wait });
    let reply: ApiReply<RelayAnswer> = await this.cloud.post<RelayAnswer>(`sync/${this.clientId}/cash/relay`, envelope, { timeoutMs: wait + 5_000 });
    for (;;) {
      if (reply.kind === 'offline') return { kind: 'offline', reason: `cloud: ${reply.reason}` };
      if (reply.kind === 'refused') {
        // The cloud's own refusal (§11.11: FastAPI's `detail`): not assigned, the route is the LAN, no host, a bad call.
        const raw = reply.body && typeof reply.body === 'object' ? (reply.body as Record<string, unknown>).detail : null;
        const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const code = typeof d.code === 'string' ? d.code : null;
        if (reply.status === 403 || reply.status === 409 || reply.status === 422) return { kind: 'refused', status: reply.status, error: code ?? `http_${reply.status}`, body: d };
        // Anything else is no answer — a 404 above all (`relay_not_found`, a cloud without the relay) must never read as
        // the station's own 404, which would close a pending payment as "nothing happened".
        return { kind: 'offline', reason: `${reply.status === 401 ? 'cloud' : 'relay'}: HTTP ${reply.status}${code ? ` ${code}` : ''}` };
      }
      const a = reply.body ?? {};
      if (a.state === 'done') {
        const r = a.reply ?? {};
        const hostTime = Number(r.hostTime);
        if (Number.isFinite(hostTime) && hostTime > 0) this.skewMs = hostTime - this.now();
        const status = typeof r.status === 'number' ? r.status : 502;
        const b = r.body && typeof r.body === 'object' ? (r.body as Record<string, unknown>) : {};
        // The host did not run it (too old by the time it took it): no answer.
        if (status === 504 && b.error === 'expired') return { kind: 'offline', reason: 'relay: expired at the host' };
        const out = replyOf<T>(status, r.body ?? null);
        if (out.kind === 'refused' && status === 401 && out.body.why === 'clock' && !retried) return this.request<T>(method, rest, body, _timeoutMs, true);
        return out;
      }
      if (a.state !== 'pending') return { kind: 'offline', reason: `relay: ${a.state ?? 'no answer'}` };
      const left = waitFor();
      if (left <= 0) return { kind: 'offline', reason: 'relay: no answer in time' };
      reply = await this.cloud.get<RelayAnswer>(`sync/${this.clientId}/cash/relay/${encodeURIComponent(requestId)}?waitMs=${left}`, { timeoutMs: left + 5_000 });
    }
  }
}

/** The host in this app, as the kiosk's own payments reach it (main/cash/host.ts `CashHost.call`). */
export interface LocalCashHost {
  call(route: CashRoute, clientId: string, body: Record<string, unknown>, via?: CashVia): Promise<{ status: number; body: unknown }>;
}

/** A host kiosk's own payments at its own station (§14.1): no network, no signature — the same calls, the same answers. */
export class CashLocalClient extends CashCalls {
  readonly via = 'local' as const;

  constructor(
    private readonly clientId: string,
    private ref: CashStationRef,
    private readonly host: () => LocalCashHost | null,
  ) {
    super();
  }

  get station(): CashStationRef {
    return this.ref;
  }

  setStation(ref: CashStationRef) {
    this.ref = ref;
  }

  async request<T>(method: Method, rest: string, body?: Record<string, unknown>): Promise<CashReply<T>> {
    const host = this.host();
    if (!host) return { kind: 'offline', reason: 'the station is not running in this app' };
    const route = matchRoute(method, stationPath(this.ref.stationId, rest));
    if (!route) return { kind: 'refused', status: 404, error: 'not_found', body: {} };
    // The body as the LAN would carry it (JSON), never the caller's own object.
    const parsed = body === undefined ? {} : (JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
    try {
      const r = await host.call(route, this.clientId, parsed, 'local');
      return replyOf<T>(r.status, r.status === 204 ? null : JSON.parse(JSON.stringify(r.body ?? null)));
    } catch (e) {
      return { kind: 'offline', reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** The cloud's client answer (§11.2), read leniently: the station to use, or null (no cash here). */
export function clientConfigOf(body: unknown): { enabled: boolean; station: CashStationRef | null; settings: Record<string, unknown>; hostsStations: boolean } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.role !== undefined && b.role !== 'client') return null;
  const s = b.station && typeof b.station === 'object' ? (b.station as Record<string, unknown>) : null;
  const station: CashStationRef | null =
    s && typeof s.stationId === 'string' && typeof s.secret === 'string' && s.secret
      ? {
          stationId: s.stationId,
          name: typeof s.name === 'string' ? s.name : 'עמדת מזומן',
          location: typeof s.location === 'string' && s.location ? s.location : null,
          hostId: typeof s.hostId === 'string' ? s.hostId : '',
          hostName: typeof s.hostName === 'string' ? s.hostName : null,
          lanAddress: typeof s.lanAddress === 'string' && s.lanAddress ? s.lanAddress : null,
          port: typeof s.port === 'number' && s.port > 0 && s.port < 65536 ? s.port : 47630,
          secret: s.secret,
        }
      : null;
  return {
    enabled: b.enabled === true,
    station,
    settings: b.settings && typeof b.settings === 'object' ? (b.settings as Record<string, unknown>) : {},
    // A host kiosk (§14.1): the cloud gave it the host's answer too.
    hostsStations: !!b.host && typeof b.host === 'object',
  };
}
