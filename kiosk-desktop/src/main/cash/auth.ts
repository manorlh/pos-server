/**
 * The cash LAN API's signatures (P:/specs/cash-paylink.md §11.3): the bridge's canonical request
 * (core/bridgeProtocol.ts) signed with HMAC-SHA256 by the client's own secret, which the cloud
 * derives from the host's secret — the host derives it the same way, so a kiosk can never sign as
 * another one. Both ends live here: the host verifies (lanServer.ts), the kiosk signs (client.ts).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonical, NONCE_RE, SIG_RE } from '../../core/bridgeProtocol';
import { CASH_H, CASH_SKEW_MS, CLIENT_RE, clientSecretMessage } from '../../core/cash/lanProtocol';
import { sha256Hex, type NonceCache } from '../bridge/auth';

export { NonceCache } from '../bridge/auth';

/** hex(HMAC-SHA256(key = UTF-8 of the host secret, "cash-client:" + clientId)), lower case. */
export function deriveClientSecret(hostSecret: string, clientId: string): string {
  return createHmac('sha256', Buffer.from(hostSecret, 'utf8')).update(clientSecretMessage(clientId), 'utf8').digest('hex');
}

export function signCash(clientSecret: string, method: string, pathWithQuery: string, ts: number | string, nonce: string, body: string | Uint8Array): string {
  return createHmac('sha256', Buffer.from(clientSecret, 'utf8')).update(canonical(method, pathWithQuery, ts, nonce, sha256Hex(body)), 'utf8').digest('base64url');
}

export function newNonce(): string {
  return randomBytes(18).toString('base64url');
}

/** The headers of a signed call (the kiosk's side). */
export function signedHeaders(o: { clientId: string; clientSecret: string; method: string; path: string; body: string; now: number }): Record<string, string> {
  const nonce = newNonce();
  const ts = String(Math.round(o.now));
  return {
    'X-R2M-Cash-Client': o.clientId,
    'X-R2M-Ts': ts,
    'X-R2M-Nonce': nonce,
    'X-R2M-Sig': signCash(o.clientSecret, o.method, o.path, ts, nonce, o.body),
  };
}

/** The WebSocket's query (signed over GET + the path, empty body). */
export function signedEventsQuery(o: { clientId: string; clientSecret: string; path: string; now: number }): string {
  const nonce = newNonce();
  const ts = String(Math.round(o.now));
  const sig = signCash(o.clientSecret, 'GET', o.path, ts, nonce, '');
  return `client=${encodeURIComponent(o.clientId)}&ts=${ts}&nonce=${nonce}&sig=${sig}`;
}

export type CashAuthFailure = 'missing' | 'bad_format' | 'unknown_client' | 'clock' | 'replay' | 'signature';

export const CASH_AUTH_TEXT: Record<CashAuthFailure, string> = {
  missing: 'בקשה לא חתומה',
  bad_format: 'חתימה לא תקינה',
  unknown_client: 'המכשיר אינו משויך לשרת המזומן הזה',
  clock: 'שעון המכשיר שונה מדי משעון שרת המזומן',
  replay: 'בקשה כפולה',
  signature: 'חתימה שגויה',
};

export function verifyCash(input: {
  method: string;
  path: string;
  headers: { client?: string | null; ts?: string | null; nonce?: string | null; sig?: string | null };
  body: Uint8Array | string;
  hostSecret: string | null;
  /** Whether the cloud lists this client for any of the host's stations. */
  knownClient(clientId: string): boolean;
  nonces: NonceCache;
  now: number;
}): { ok: true; clientId: string } | { ok: false; why: CashAuthFailure } {
  const { client, ts, nonce, sig } = input.headers;
  if (!client || !ts || !nonce || !sig) return { ok: false, why: 'missing' };
  if (!CLIENT_RE.test(client) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig) || !/^\d{10,16}$/.test(ts)) return { ok: false, why: 'bad_format' };
  if (!input.hostSecret || !input.knownClient(client)) return { ok: false, why: 'unknown_client' };
  if (Math.abs(input.now - Number(ts)) > CASH_SKEW_MS) return { ok: false, why: 'clock' };
  const expected = Buffer.from(signCash(deriveClientSecret(input.hostSecret, client), input.method, input.path, ts, nonce, input.body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, why: 'signature' };
  if (!input.nonces.take(nonce, input.now)) return { ok: false, why: 'replay' };
  return { ok: true, clientId: client };
}

export { CASH_H };
