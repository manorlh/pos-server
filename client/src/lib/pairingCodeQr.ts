/**
 * "צימוד בסריקה" (pos-server docs/SPEC_PAIRING_QR.md §2): the QR the add-device dialog draws beside the
 * pairing code, and the same format read back — which is what the till's `DashboardPairingQr.kt` does.
 *
 *   r2mpos://pair?v=1&server=<percent-encoded API base>&code=<CODE>&exp=<epoch seconds>
 *
 * Pinned by the golden fixture server/tests/fixtures/pairing_qr_golden.json (the same bytes sit in
 * pos-android's test resources; both tests pin its SHA-256). The reader here exists for that test and
 * for the dialog's own sanity — the till is the real reader.
 *
 * Self-contained on purpose (no `@/` imports): `npm test` compiles it on its own.
 */

export const PAIRING_QR_PREFIX = 'r2mpos://pair?';
export const PAIRING_QR_VERSION = 1;
/** No real payload is longer; a longer text is not ours. */
export const PAIRING_QR_MAX_LENGTH = 600;

const AUTHORITY = /^(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;
// http(s) + a host (no user info) + an optional path with no space, `?` or `#`.
const SERVER = /^https?:\/\/([^/?#@\u0000- \u007f]+)((?:\/[^\u0000- \u007f?#]*)?)$/i;
const CODE = /^[A-Za-z0-9]{4,32}$/;
const EPOCH = /^[0-9]{1,12}$/;

/** RFC 3986: everything but `A-Z a-z 0-9 - _ . ~` is percent-encoded (UTF-8 bytes, upper-case hex). */
export function percentEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The address as the QR carries it — an `http(s)` URL with a host, no user info, no `?` / `#`, no space,
 * trailing slashes dropped — or null when it is not one.
 */
export function pairingQrServer(raw: string): string | null {
  const m = SERVER.exec(raw);
  if (m === null || !AUTHORITY.test(m[1])) return null;
  return raw.replace(/\/+$/, '');
}

/** localhost, 127.x, ::1 and 0.0.0.0: no device can reach them, so no QR is drawn for one. */
export function isLoopbackServer(server: string): boolean {
  const authority = SERVER.exec(server)?.[1] ?? '';
  const host = (authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':')[0]).toLowerCase();
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost') || host.startsWith('127.');
}

/**
 * The API base the device must reach: the dashboard's own configured public API URL
 * (`NEXT_PUBLIC_API_URL`), a relative one resolved against [origin]. Null when there is none, or it
 * is not one a device could use.
 */
export function resolvePairingServer(apiBase: string | null | undefined, origin: string): string | null {
  const base = (apiBase ?? '').trim();
  if (!base) return null;
  let absolute = base;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(base)) {
    if (!origin) return null;
    try {
      absolute = new URL(base, origin).href;
    } catch {
      return null;
    }
  }
  const server = pairingQrServer(absolute);
  return server !== null && !isLoopbackServer(server) ? server : null;
}

/** An `expiresAt` from `POST /pairing/generate` as epoch seconds (a time with no zone is UTC), or null. */
export function expiryEpochSeconds(expiresAt: unknown): number | null {
  if (typeof expiresAt !== 'string' || !expiresAt.trim()) return null;
  const text = expiresAt.trim();
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The QR's text for a code, or null when there is nothing a device could scan (the code stays as text). */
export function buildPairingQr(input: { server: string; code: string; exp: number }): string | null {
  const server = pairingQrServer(input.server);
  if (server === null || isLoopbackServer(server)) return null;
  if (!/^[A-Z0-9]{4,32}$/.test(input.code)) return null;
  if (!Number.isInteger(input.exp) || input.exp <= 0 || input.exp >= 1e12) return null;
  return `${PAIRING_QR_PREFIX}v=${PAIRING_QR_VERSION}&server=${percentEncode(server)}&code=${input.code}&exp=${input.exp}`;
}

export type PairingQrRead =
  | { outcome: 'valid'; server: string; code: string; exp: number }
  | { outcome: 'expired' }
  | { outcome: 'unrecognized' };

const UNRECOGNIZED: PairingQrRead = { outcome: 'unrecognized' };

function decode(value: string): string | null {
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * What a scanned text is: the QR of a pairing code ([nowEpochSeconds] before its expiry), one that has
 * expired (`now > exp`), or not ours. A malformed one is "unrecognized" even when it is also late.
 */
export function parsePairingQr(text: string, nowEpochSeconds: number): PairingQrRead {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > PAIRING_QR_MAX_LENGTH) return UNRECOGNIZED;
  if (trimmed.slice(0, PAIRING_QR_PREFIX.length).toLowerCase() !== PAIRING_QR_PREFIX) return UNRECOGNIZED;
  const seen = new Map<string, string>();
  for (const part of trimmed.slice(PAIRING_QR_PREFIX.length).split('&')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at);
    if (key !== 'v' && key !== 'server' && key !== 'code' && key !== 'exp') continue;
    if (seen.has(key)) return UNRECOGNIZED;
    seen.set(key, part.slice(at + 1));
  }
  const values = new Map<string, string>();
  for (const [key, raw] of seen) {
    const value = decode(raw);
    if (value === null) return UNRECOGNIZED;
    values.set(key, value);
  }
  if (values.size !== 4 || values.get('v') !== String(PAIRING_QR_VERSION)) return UNRECOGNIZED;
  const server = pairingQrServer(values.get('server') ?? '');
  const code = values.get('code') ?? '';
  const expText = values.get('exp') ?? '';
  if (server === null || !CODE.test(code) || !EPOCH.test(expText)) return UNRECOGNIZED;
  const exp = Number(expText);
  if (exp <= 0) return UNRECOGNIZED;
  if (nowEpochSeconds > exp) return { outcome: 'expired' };
  return { outcome: 'valid', server, code: code.toUpperCase(), exp };
}
