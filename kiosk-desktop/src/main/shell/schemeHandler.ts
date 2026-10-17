/**
 * The app's own URL schemes (`kiosk://`, `r2m://`) on both Electron lines:
 *
 *  - Electron 25 and later (the standard build, Electron 44): `protocol.handle(scheme, Request → Response)`.
 *  - Electron 22 (the Windows 7 build, P:/specs/windows7-till.md): there is no `protocol.handle` (and Node 16 has no
 *    `Response` / `Readable.toWeb`) — `protocol.registerStreamProtocol(scheme, (request, callback))` instead.
 *
 * The handlers answer a plain `SchemeReply` (status, headers, a Node stream or text), turned into what each line
 * wants here, so the same code serves files on both. Nothing in here imports Electron (the protocol is passed in).
 */

import { Readable } from 'node:stream';

export interface SchemeRequest {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
}

export interface SchemeReply {
  status: number;
  headers: Record<string, string>;
  /** A file's stream, a short text, or nothing. */
  body: Readable | string | null;
}

export type SchemeHandler = (request: SchemeRequest) => SchemeReply | Promise<SchemeReply>;

/** Electron 22's stream-protocol request (`ProtocolRequest`). */
interface LegacyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string | string[]>;
}

/** Electron 22's stream-protocol answer (`ProtocolResponse` with a stream). */
export interface LegacyReply {
  statusCode: number;
  headers: Record<string, string>;
  data: Readable;
}

/** The part of Electron's `protocol` used here, on either line. */
export interface ProtocolLike {
  handle?(scheme: string, handler: (request: { url: string; method: string; headers: { get(name: string): string | null } }) => unknown): void;
  unhandle?(scheme: string): void;
  registerStreamProtocol?(scheme: string, handler: (request: LegacyRequest, callback: (reply: LegacyReply) => void) => void): boolean | void;
  unregisterProtocol?(scheme: string): boolean | void;
}

export function textReply(status: number, text: string, headers: Record<string, string> = {}): SchemeReply {
  return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, body: text };
}

/** Electron 22's request with a `headers.get` (any case) — what the handlers read. */
export function schemeRequestOf(r: LegacyRequest): SchemeRequest {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(r.headers ?? {})) lower.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v));
  return { url: r.url, method: (r.method ?? 'GET').toUpperCase(), headers: { get: (name) => lower.get(name.toLowerCase()) ?? null } };
}

/** A reply as Electron 22 takes it from a stream protocol. */
export function legacyReplyOf(reply: SchemeReply): LegacyReply {
  const data = reply.body instanceof Readable ? reply.body : Readable.from(reply.body === null ? [] : [Buffer.from(reply.body, 'utf8')]);
  return { statusCode: reply.status, headers: reply.headers, data };
}

/** A reply as a WHATWG Response (Electron ≥ 25: `Response` and `Readable.toWeb` exist there). */
export function webResponseOf(reply: SchemeReply): unknown {
  const R = (globalThis as { Response?: new (body: unknown, init: { status: number; headers: Record<string, string> }) => unknown }).Response;
  const toWeb = (Readable as unknown as { toWeb?: (r: Readable) => unknown }).toWeb;
  if (!R || !toWeb) throw new Error('Response / Readable.toWeb missing: this Electron needs registerStreamProtocol');
  const body = reply.body instanceof Readable ? toWeb(reply.body) : reply.body;
  return new R(body, { status: reply.status, headers: reply.headers });
}

/** Serves `scheme` with `handler` — `protocol.handle` where it exists, else Electron 22's stream protocol. */
export function handleScheme(protocol: ProtocolLike, scheme: string, handler: SchemeHandler, log: (m: string) => void = () => undefined): 'handle' | 'stream' {
  if (typeof protocol.handle === 'function') {
    protocol.handle(scheme, async (request) => webResponseOf(await handler(request)));
    return 'handle';
  }
  if (typeof protocol.registerStreamProtocol !== 'function') throw new Error(`no way to register the ${scheme}: scheme`);
  protocol.registerStreamProtocol(scheme, (request, callback) => {
    Promise.resolve()
      .then(() => handler(schemeRequestOf(request)))
      .then((reply) => callback(legacyReplyOf(reply)))
      .catch((e: unknown) => {
        log(`${scheme}: ${e instanceof Error ? e.message : String(e)}`);
        callback(legacyReplyOf(textReply(500, 'error')));
      });
  });
  return 'stream';
}

export function unhandleScheme(protocol: ProtocolLike, scheme: string): void {
  if (typeof protocol.unhandle === 'function') protocol.unhandle(scheme);
  else protocol.unregisterProtocol?.(scheme);
}
