/**
 * The links from the screens to an engine (§3.3) — the same JSON envelopes on every transport:
 *
 *  - `endpointLink`: an engine reached by a function call — the demo's mock in the page, or the
 *    Windows shell's IPC door (`window.r2mApp`, host/electron.ts);
 *  - `wsEngineLink`: a WebSocket — the cloud engine, or the APK main till on the LAN (P1/P3): on
 *    every (re)connect `session.hello {since}`, then the calls that were waiting are sent again
 *    WITH THEIR clientOpId (the engine applies an op once, §3.3).
 *
 * A changing op always gets a clientOpId here; a refusal rejects with EngineCallError. The
 * protocol is checked on hello: an engine that speaks another one → `mismatch` (the screens say
 * "נדרש עדכון" and never sell, §8.4).
 */

import { MUTATING_OPS, TILL_PROTOCOL, type EngineCall, type EngineEndpoint, type EngineEvent, type EngineReply, type HelloReply, type OpArgs, type TillOp, type TillState } from '../../shared/till/protocol';
import { EngineCallError, type CallOptions, type EngineLink, type LinkStatus } from './TillHost';

/** The protocols these screens speak (§8.4: an engine supports at least N-1). */
export const SUPPORTED_PROTOCOLS: readonly number[] = [TILL_PROTOCOL];

interface CryptoLike {
  getRandomValues?: (a: Uint8Array) => Uint8Array;
}

/** 16 random bytes as hex. Not crypto.randomUUID: a LAN page on http has no secure context. */
export function newClientOpId(): string {
  const c = (globalThis as unknown as { crypto?: CryptoLike }).crypto;
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

function isThenable<T>(v: T | Promise<T>): v is Promise<T> {
  return typeof (v as Promise<T>)?.then === 'function';
}

/** The shared bookkeeping of every link: the last state, the listeners, the status. */
class LinkCore {
  last: { seq: number; state: TillState } | null = null;
  status: LinkStatus = 'connecting';
  readonly listeners = new Set<(e: EngineEvent) => void>();
  readonly statusListeners = new Set<(s: LinkStatus) => void>();

  setStatus(s: LinkStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of Array.from(this.statusListeners)) fn(s);
  }

  acceptHello(h: HelloReply): HelloReply {
    if (!SUPPORTED_PROTOCOLS.includes(h.protocol)) {
      this.setStatus('mismatch');
      return h;
    }
    if (!this.last || h.seq >= this.last.seq) this.last = { seq: h.seq, state: h.state };
    this.setStatus('ready');
    return h;
  }

  event(e: EngineEvent) {
    if (e.ev === 'state' && (!this.last || e.seq >= this.last.seq)) this.last = { seq: e.seq, state: e.data as TillState };
    for (const fn of Array.from(this.listeners)) fn(e);
  }

  link(call: EngineLink['call'], hello: EngineLink['hello']): EngineLink {
    return {
      call,
      hello,
      on: (fn) => {
        this.listeners.add(fn);
        return () => void this.listeners.delete(fn);
      },
      snapshot: () => this.last,
      status: () => this.status,
      onStatus: (fn) => {
        this.statusListeners.add(fn);
        return () => void this.statusListeners.delete(fn);
      },
    };
  }
}

function unwrap(reply: EngineReply): unknown {
  if (reply.ok) return reply.value;
  throw new EngineCallError(reply.error.code, reply.error.message, reply.error.details);
}

/** An engine behind a function call (the demo's mock, the Windows shell's IPC). */
export function endpointLink(endpoint: EngineEndpoint): EngineLink {
  const core = new LinkCore();
  let nextId = 0;
  endpoint.on((e) => core.event(e));
  const hello = (since?: number): Promise<HelloReply> => {
    const h = endpoint.hello(since);
    return isThenable(h) ? h.then((r) => core.acceptHello(r)) : Promise.resolve(core.acceptHello(h));
  };
  // A synchronous engine (the mock) gives the first state now: the first frame is the till.
  const first = endpoint.hello();
  if (isThenable(first)) first.then((r) => core.acceptHello(r), () => core.setStatus('offline'));
  else core.acceptHello(first);
  const call = async <K extends TillOp>(op: K, args?: OpArgs[K], opts?: CallOptions): Promise<unknown> => {
    if (core.status === 'mismatch') throw new EngineCallError('protocol_mismatch', 'נדרש עדכון — המסך והמנוע בגרסאות שונות');
    nextId += 1;
    const c: EngineCall = { id: nextId, op, args };
    if (MUTATING_OPS.has(op)) c.clientOpId = opts?.clientOpId ?? newClientOpId();
    return unwrap(await endpoint.call(c));
  };
  return core.link(call, hello);
}

/* ------------------------------------------------------------------ WebSocket */

/** The part of a WebSocket the link uses (the browser's, or a fake in the tests). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WsLinkOptions {
  url: string;
  connect(url: string): WsLike;
  /** Waits between reconnects, the last one repeated. */
  backoffMs?: number[];
  /** A call not answered by then fails (`engine_offline`); a card frame may take 180 s (§3.4). */
  callTimeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface Pending {
  call: EngineCall;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  cancelTimer: () => void;
}

export function wsEngineLink(o: WsLinkOptions): EngineLink & { close(): void } {
  const core = new LinkCore();
  const schedule =
    o.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const backoff = o.backoffMs ?? [500, 1000, 2000, 5000];
  const pending = new Map<number, Pending>();
  const helloWaiters: Array<{ resolve(h: HelloReply): void; reject(e: unknown): void }> = [];
  let nextId = 0;
  let ws: WsLike | null = null;
  let open = false;
  let attempt = 0;
  let closed = false;
  let helloId = -1;

  const send = (c: EngineCall) => {
    if (ws && open) ws.send(JSON.stringify(c));
  };

  const connect = () => {
    if (closed) return;
    core.setStatus('connecting');
    const sock = o.connect(o.url);
    ws = sock;
    sock.onopen = () => {
      open = true;
      nextId += 1;
      helloId = nextId;
      send({ id: helloId, op: 'session.hello', args: { since: core.last?.seq, protocol: TILL_PROTOCOL } });
    };
    sock.onmessage = (m) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const rec = msg as Record<string, unknown>;
      if (typeof rec.ev === 'string') {
        core.event(rec as unknown as EngineEvent);
        return;
      }
      if (typeof rec.id !== 'number') return;
      const reply = rec as unknown as EngineReply;
      if (reply.id === helloId) {
        if (!reply.ok) {
          core.setStatus(reply.error.code === 'protocol_mismatch' ? 'mismatch' : 'offline');
          helloWaiters.splice(0).forEach((w) => w.reject(new EngineCallError(reply.error.code, reply.error.message)));
          return;
        }
        const h = core.acceptHello(reply.value as HelloReply);
        attempt = 0;
        helloWaiters.splice(0).forEach((w) => w.resolve(h));
        if (core.status === 'ready') for (const p of pending.values()) send(p.call); // the same ids, the same clientOpIds
        return;
      }
      const p = pending.get(reply.id);
      if (!p) return;
      pending.delete(reply.id);
      p.cancelTimer();
      try {
        p.resolve(unwrap(reply));
      } catch (e) {
        p.reject(e);
      }
    };
    sock.onclose = () => {
      open = false;
      ws = null;
      if (closed) return;
      if (core.status !== 'mismatch') core.setStatus('offline');
      const wait = backoff[Math.min(attempt, backoff.length - 1)];
      attempt += 1;
      schedule(connect, wait);
    };
    sock.onerror = () => undefined;
  };

  const call = <K extends TillOp>(op: K, args?: OpArgs[K], opts?: CallOptions): Promise<unknown> => {
    if (core.status === 'mismatch') return Promise.reject(new EngineCallError('protocol_mismatch', 'נדרש עדכון — המסך והמנוע בגרסאות שונות'));
    nextId += 1;
    const c: EngineCall = { id: nextId, op, args };
    if (MUTATING_OPS.has(op)) c.clientOpId = opts?.clientOpId ?? newClientOpId();
    return new Promise((resolve, reject) => {
      const cancelTimer = schedule(() => {
        pending.delete(c.id);
        reject(new EngineCallError('engine_offline', 'מנוע הקופה לא ענה'));
      }, opts?.timeoutMs ?? o.callTimeoutMs ?? 15_000);
      pending.set(c.id, { call: c, resolve, reject, cancelTimer });
      if (core.status === 'ready') send(c);
    });
  };

  const hello = (): Promise<HelloReply> =>
    new Promise((resolve, reject) => {
      if (core.status === 'ready' && core.last) {
        resolve({ protocol: TILL_PROTOCOL, seq: core.last.seq, state: core.last.state });
        return;
      }
      helloWaiters.push({ resolve, reject });
    });

  connect();
  return {
    ...core.link(call, hello),
    close: () => {
      closed = true;
      ws?.close();
      for (const p of pending.values()) {
        p.cancelTimer();
        p.reject(new EngineCallError('engine_offline', 'החיבור נסגר'));
      }
      pending.clear();
    },
  };
}
