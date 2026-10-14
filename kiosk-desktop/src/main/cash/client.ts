/**
 * The kiosk's client of a cash station (P:/specs/cash-paylink.md §11.3–§11.6): signed calls to the
 * cash host on the shop's LAN, with the host's clock learned from every answer (`X-R2M-Time`) and
 * one retry when the clock was off. Never throws on the network: `offline` is an answer.
 */

import { stationPath, type LeaseView, type StationStatus } from '../../core/cash/lanProtocol';
import type { TxView } from '../../core/cash/tx';
import { signedHeaders } from './auth';

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

export class CashLanClient {
  /** The host's clock minus ours. */
  private skewMs = 0;

  constructor(
    private readonly clientId: string,
    private ref: CashStationRef,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  get station(): CashStationRef {
    return this.ref;
  }

  setStation(ref: CashStationRef) {
    this.ref = ref;
  }

  private base(): string | null {
    return this.ref.lanAddress ? `http://${this.ref.lanAddress.includes(':') && !this.ref.lanAddress.startsWith('[') ? `[${this.ref.lanAddress}]` : this.ref.lanAddress}:${this.ref.port}` : null;
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', rest: string, body?: Record<string, unknown>, timeoutMs = 6_000, retried = false): Promise<CashReply<T>> {
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
    if (res.ok) return { kind: 'ok', status: res.status, body: parsed as T };
    const b = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    if (res.status === 401 && b.why === 'clock' && !retried) return this.request<T>(method, rest, body, timeoutMs, true);
    return { kind: 'refused', status: res.status, error: typeof b.error === 'string' ? b.error : `http_${res.status}`, body: b };
  }

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

  ack(txId: string, documentId: string | null, documentNumber: string | null) {
    return this.request<TxView>('POST', `tx/${txId}/ack`, { ...(documentId ? { documentId } : {}), ...(documentNumber ? { documentNumber } : {}) });
  }
}

/** The cloud's client answer (§11.2), read leniently: the station to use, or null (no cash here). */
export function clientConfigOf(body: unknown): { enabled: boolean; station: CashStationRef | null; settings: Record<string, unknown> } | null {
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
  return { enabled: b.enabled === true, station, settings: b.settings && typeof b.settings === 'object' ? (b.settings as Record<string, unknown>) : {} };
}
