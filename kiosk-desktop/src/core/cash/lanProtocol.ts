/**
 * The cash host's LAN API (P:/specs/cash-paylink.md §11.3–§11.5) — the shapes and rules both ends
 * share: the cash host (main/cash/lanServer.ts) and the kiosk's client (main/cash/client.ts; the
 * Android kiosk implements the same contract in Kotlin).
 *
 * Every call but `GET /cash/health` is signed: HMAC-SHA256 over the bridge's canonical request
 * (core/bridgeProtocol.ts `canonical`) with the client's own secret, which the cloud derives from
 * the host's secret and the client's machine id — so one kiosk can never act as another.
 *
 * Pure.
 */

import type { TxView } from './tx';

export const CASH_API = 1;
/** The default LAN port (kiosk.json `cashPort` moves it; the host reports the one it took). */
export const CASH_PORT = 47630;

/** Header names as Node reads them (lower case). */
export const CASH_H = {
  client: 'x-r2m-cash-client',
  ts: 'x-r2m-ts',
  nonce: 'x-r2m-nonce',
  sig: 'x-r2m-sig',
  time: 'x-r2m-time',
} as const;

export const CASH_SKEW_MS = 120_000;
export const CLIENT_RE = /^[A-Za-z0-9-]{8,64}$/;
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const STATION_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Leases: renewed every 2 s; one not renewed for 6 s is gone. */
export const LEASE_RENEW_MS = 2_000;
export const LEASE_TTL_MS = 6_000;
/** A kiosk polls the station's status this often while idle (the "מזומן" tile). */
export const STATUS_POLL_MS = 10_000;

export type StationState = 'ready' | 'busy' | 'maintenance' | 'fault' | 'starting';

export interface StationStatus {
  api: number;
  stationId: string;
  stationName: string;
  hostId: string;
  time: number;
  state: StationState;
  ready: boolean;
  reason: string | null;
  currency: 'ILS';
  accepts: { coins: number[]; notes: number[] };
  changeAvailableAgorot: number;
  exactOnly: boolean;
  maxChangeAgorot: number;
  queue: { length: number; holderClientId: string | null };
  you: { leaseId: string | null; position: number | null; txId: string | null };
}

export interface LeaseView {
  leaseId: string;
  state: 'granted' | 'queued';
  position: number;
  renewMs: number;
  expiresAt: number;
  estimatedWaitSec: number | null;
}

export interface CashHealth {
  service: 'r2m-cash';
  api: number;
  hostId: string | null;
  version: string;
  time: number;
  stations: string[];
}

/** Refusal codes (the `error` field); the HTTP status they come with. */
export const CASH_ERRORS = {
  auth: 401,
  not_assigned: 403,
  unknown_station: 404,
  unknown_lease: 404,
  unknown_tx: 404,
  not_found: 404,
  not_ready: 409,
  not_holder: 409,
  tx_active: 409,
  tx_conflict: 409,
  too_late: 409,
  not_final: 409,
  not_accepting: 409,
  nothing_inserted: 409,
  not_partial: 409,
  amount: 400,
  json: 400,
  too_large: 413,
  method: 405,
  internal: 500,
} as const;

export type CashErrorCode = keyof typeof CASH_ERRORS;

export type CashRoute =
  | { kind: 'health' }
  | { kind: 'status'; stationId: string }
  | { kind: 'lease'; stationId: string }
  | { kind: 'release'; stationId: string; leaseId: string }
  | { kind: 'tx_get'; stationId: string; txId: string }
  | { kind: 'tx_start' | 'tx_cancel' | 'tx_ack' | 'tx_split' | 'tx_finish'; stationId: string; txId: string }
  | { kind: 'events'; stationId: string };

/** "METHOD /path" → the route (null: not one). */
export function matchRoute(method: string, path: string): CashRoute | null {
  const m = method.toUpperCase();
  const p = path.split('?')[0];
  if (m === 'GET' && p === '/cash/health') return { kind: 'health' };
  const parts = p.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'cash' || parts[1] !== 'stations') return null;
  const stationId = decodeURIComponent(parts[2]);
  if (!STATION_RE.test(stationId)) return null;
  const rest = parts.slice(3);
  if (m === 'GET' && rest.length === 1 && rest[0] === 'status') return { kind: 'status', stationId };
  if (m === 'GET' && rest.length === 1 && rest[0] === 'events') return { kind: 'events', stationId };
  if (m === 'POST' && rest.length === 1 && rest[0] === 'lease') return { kind: 'lease', stationId };
  if (m === 'DELETE' && rest.length === 2 && rest[0] === 'lease') return { kind: 'release', stationId, leaseId: decodeURIComponent(rest[1]) };
  if (rest[0] === 'tx' && rest.length >= 2) {
    const txId = decodeURIComponent(rest[1]);
    if (!UUID_RE.test(txId)) return null;
    if (m === 'GET' && rest.length === 2) return { kind: 'tx_get', stationId, txId };
    if (m === 'POST' && rest.length === 3 && rest[2] === 'start') return { kind: 'tx_start', stationId, txId };
    if (m === 'POST' && rest.length === 3 && rest[2] === 'cancel') return { kind: 'tx_cancel', stationId, txId };
    if (m === 'POST' && rest.length === 3 && rest[2] === 'ack') return { kind: 'tx_ack', stationId, txId };
    // Cash + card (§11.15ב).
    if (m === 'POST' && rest.length === 3 && rest[2] === 'split') return { kind: 'tx_split', stationId, txId };
    if (m === 'POST' && rest.length === 3 && rest[2] === 'finish') return { kind: 'tx_finish', stationId, txId };
  }
  return null;
}

export function stationPath(stationId: string, rest: string): string {
  return `/cash/stations/${encodeURIComponent(stationId)}/${rest.replace(/^\/+/, '')}`;
}

/** The WebSocket's events. */
export type CashEvent = { type: 'tx'; tx: TxView } | { type: 'status'; status: StationStatus } | { type: 'lease'; lease: LeaseView };

/** The client secret's derivation input (HMAC-SHA256 keyed by the host secret's UTF-8 bytes). */
export function clientSecretMessage(clientId: string): string {
  return `cash-client:${clientId}`;
}
