/**
 * The bridge's signed calls (core/bridgeProtocol.ts): HMAC-SHA256 over the canonical request with
 * the pairing's secret, the clock window, and nonces kept long enough that no request can be
 * replayed inside the window.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonical, KEY_RE, NONCE_RE, SIG_RE, SKEW_MS } from '../../core/bridgeProtocol';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function signCanonical(secret: Uint8Array, text: string): string {
  return createHmac('sha256', secret).update(text, 'utf8').digest('base64url');
}

/** 32 random bytes: the shared secret of a pairing. */
export function newSecret(): Buffer {
  return randomBytes(32);
}

/** A public id for a pairing (the page keeps it with its secret; /health shows it). */
export function newPairingId(): string {
  return randomBytes(12).toString('base64url');
}

/** Nonces seen inside the clock window (twice the skew, then forgotten). */
export class NonceCache {
  private seen = new Map<string, number>();

  constructor(private readonly keepMs = 2 * SKEW_MS + 5_000) {}

  /** True the first time; false for a replay. */
  take(nonce: string, now: number): boolean {
    if (this.seen.size > 5_000) this.prune(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }

  prune(now: number) {
    for (const [n, at] of this.seen) if (now - at > this.keepMs) this.seen.delete(n);
  }
}

export type AuthFailure = 'missing' | 'unknown_key' | 'bad_format' | 'clock' | 'replay' | 'signature';

export const AUTH_TEXT: Record<AuthFailure, string> = {
  missing: 'בקשה לא חתומה',
  unknown_key: 'הדפדפן אינו מצומד לגשר הזה (צימוד מחדש)',
  bad_format: 'חתימה לא תקינה',
  clock: 'שעון המחשב שונה מדי',
  replay: 'בקשה כפולה',
  signature: 'חתימה שגויה',
};

/**
 * Verifies a request's signature. `pairing` is the bridge's one pairing (or null). The nonce is
 * taken only once the signature is right (a wrong one cannot burn a good nonce).
 */
export function verifyRequest(input: {
  method: string;
  path: string;
  headers: { key?: string | null; ts?: string | null; nonce?: string | null; sig?: string | null };
  body: Uint8Array | string;
  pairing: { pairingId: string; secret: Uint8Array } | null;
  nonces: NonceCache;
  now: number;
}): { ok: true } | { ok: false; why: AuthFailure } {
  const { key, ts, nonce, sig } = input.headers;
  if (!key || !ts || !nonce || !sig) return { ok: false, why: 'missing' };
  if (!KEY_RE.test(key) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig) || !/^\d{10,16}$/.test(ts)) return { ok: false, why: 'bad_format' };
  if (!input.pairing || key !== input.pairing.pairingId) return { ok: false, why: 'unknown_key' };
  if (Math.abs(input.now - Number(ts)) > SKEW_MS) return { ok: false, why: 'clock' };
  const expected = Buffer.from(signCanonical(input.pairing.secret, canonical(input.method, input.path, ts, nonce, sha256Hex(input.body))));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, why: 'signature' };
  if (!input.nonces.take(nonce, input.now)) return { ok: false, why: 'replay' };
  return { ok: true };
}
