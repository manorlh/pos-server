/**
 * The Nayax pinpad's HTTP transport, as the till's (pos-android hardware/payment/net/
 * TcHttpEmvDevice.kt, PinpadHttp.kt, PinpadPins.kt):
 *
 *  - one POST per frame, a fresh connection each time (`Connection: close`), NO retries;
 *  - HTTPS trust-on-first-use: the pinpad's self-signed leaf certificate is pinned (SHA-256 of its
 *    DER, "AB:CD:…") after the first good exchange; afterwards only that certificate is accepted;
 *  - the request bytes leave only after the TLS handshake and the pin check — a frame never
 *    reaches a pinpad that is not the pinned one;
 *  - plain HTTP only to an RFC 1918 address with the till parameter `pinpadAllowHttp`.
 *
 * A raw HTTP/1.1 client over net/tls (not fetch), so the pin is checked before anything is written.
 */

import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { PinpadAddress } from '../../core/nayax';

export class PinpadCertificateChanged extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super('תעודת המסופון השתנתה — אין חיבור עד שמנהל יאשר את המסופון מחדש');
  }
}

export class PinpadHttpStatus extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export interface PinStore {
  get(hostPort: string): string | null;
  set(hostPort: string, pin: string): void;
}

export const CONNECT_TIMEOUT_MS = 5_000;
const MAX_REPLY_BYTES = 1024 * 1024;

export function certFingerprint(der: Buffer): string {
  return createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)!
    .join(':');
}

export interface RawReply {
  status: number;
  body: string;
}

/** POST `body` to the pinpad; resolves with the reply (any status), rejects on transport failure. */
export function postFrame(addr: PinpadAddress, body: string, timeoutMs: number, pins: PinStore | null): Promise<RawReply> {
  return new Promise<RawReply>((resolve, reject) => {
    const hostPort = `${addr.host}:${addr.port}`;
    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    let socket: net.Socket;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      socket?.destroy();
      reject(e);
    };
    const overall = setTimeout(() => fail(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    const connectTimer = setTimeout(() => fail(new Error('connect timeout')), Math.min(CONNECT_TIMEOUT_MS, timeoutMs));

    const send = (pinOk: boolean) => {
      clearTimeout(connectTimer);
      if (!pinOk) return;
      const payload = Buffer.from(body, 'utf8');
      const head =
        `POST ${addr.path} HTTP/1.1\r\n` +
        `Host: ${hostPort}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\n' +
        'Accept: application/json\r\n' +
        'Connection: close\r\n' +
        `Content-Length: ${payload.length}\r\n\r\n`;
      socket.write(Buffer.concat([Buffer.from(head, 'latin1'), payload]));
    };

    if (addr.tls) {
      const isIp = net.isIP(addr.host) !== 0;
      const s = tls.connect({
        host: addr.host,
        port: addr.port,
        servername: isIp ? undefined : addr.host,
        rejectUnauthorized: false,
        minVersion: 'TLSv1',
      });
      socket = s;
      s.once('secureConnect', () => {
        const cert = s.getPeerCertificate(false);
        const der = cert && (cert as { raw?: Buffer }).raw;
        if (!der) return fail(new Error('no certificate from the pinpad'));
        const actual = certFingerprint(der);
        const pinned = pins?.get(hostPort) ?? null;
        if (pinned && pinned !== actual) return fail(new PinpadCertificateChanged(pinned, actual));
        (s as unknown as { __pin?: string }).__pin = actual;
        send(true);
      });
    } else {
      socket = net.connect({ host: addr.host, port: addr.port }, () => send(true));
    }
    socket.on('data', (d: Buffer) => {
      total += d.length;
      if (total > MAX_REPLY_BYTES) return fail(new Error('reply too large'));
      chunks.push(d);
      const parsed = tryParse(Buffer.concat(chunks));
      if (parsed) finish(parsed);
    });
    socket.on('end', () => {
      const parsed = tryParse(Buffer.concat(chunks), true);
      if (parsed) finish(parsed);
      else fail(new Error('connection closed without a reply'));
    });
    socket.on('error', (e) => fail(e));
    socket.on('close', () => {
      if (!settled) {
        const parsed = tryParse(Buffer.concat(chunks), true);
        if (parsed) finish(parsed);
        else fail(new Error('connection closed'));
      }
    });

    function finish(r: RawReply) {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      clearTimeout(connectTimer);
      const pin = (socket as unknown as { __pin?: string }).__pin;
      // Pinned only after the first good exchange (TcHttpEmvDevice: a 2xx).
      if (pin && pins && r.status >= 200 && r.status < 300 && !pins.get(hostPort)) pins.set(hostPort, pin);
      socket.destroy();
      resolve(r);
    }
  });
}

/** A complete HTTP/1.1 response in `buf` (Content-Length, chunked, or to the end), else null. */
export function tryParse(buf: Buffer, ended = false): RawReply | null {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const head = buf.subarray(0, sep).toString('latin1');
  const lines = head.split('\r\n');
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0] ?? '');
  if (!m) return ended ? { status: 0, body: '' } : null;
  const status = Number(m[1]);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const rest = buf.subarray(sep + 4);
  const len = headers.get('content-length');
  if (len !== undefined) {
    const n = Number(len);
    if (rest.length < n) return null;
    return { status, body: rest.subarray(0, n).toString('utf8') };
  }
  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    const out: Buffer[] = [];
    let at = 0;
    for (;;) {
      const nl = rest.indexOf('\r\n', at);
      if (nl < 0) return null;
      const size = parseInt(rest.subarray(at, nl).toString('latin1'), 16);
      if (!Number.isFinite(size)) return null;
      if (size === 0) return { status, body: Buffer.concat(out).toString('utf8') };
      if (rest.length < nl + 2 + size + 2) return null;
      out.push(rest.subarray(nl + 2, nl + 2 + size));
      at = nl + 2 + size + 2;
    }
  }
  return ended ? { status, body: rest.toString('utf8') } : null;
}

/** TLS refused at the handshake (an HTTP-only pinpad), as PinpadHttp.tlsRefused. */
export function tlsRefused(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e);
  return /wrong version number|EPROTO|ECONNRESET|packet length too long|unknown protocol|SSL routines/i.test(msg);
}
