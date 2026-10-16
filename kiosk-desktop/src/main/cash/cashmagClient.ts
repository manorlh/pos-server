/**
 * The CashMag server's WebSocket client (P:/specs/cashmag-windows.md §3): one connection, the handshake
 * (HELLO → WHOAREYOU, IAM → WELCOME) and its session id reused, every call matched to its answer by its job id
 * with a time limit of its own, and the server's signals handed on. The wire itself is core/cash/cashmagWire.ts.
 *
 * The rules of the connection:
 *  - closed by the server with "Service occupé !" (another client has the machine): `busy` — never reconnected
 *    to by itself (the payment flow asks again on its own clock, and only before money);
 *  - dropped otherwise while a call that must survive it is out (the payment): reconnected with the same session,
 *    a few times within a grace, the call still waiting for its answer; past the grace it ends `disconnected`
 *    (no telling what the device did). With nothing out, a drop just ends the connection;
 *  - the invalid-session status (on ERROR, or on a call's answer): the session dropped, the handshake again, and
 *    the call sent once more (it was refused, nothing ran).
 *
 * Never throws: every end is an answer. No Electron here (tests run it under plain Node against a fake server).
 */

import { randomUUID } from 'node:crypto';
import {
  decodeMessage,
  encodeCall,
  HANDSHAKE,
  isBusyClose,
  STATUS_INVALID_SESSION,
  type HandshakeStep,
  type RpcStatus,
} from '../../core/cash/cashmagWire';

/** As much of a WebSocket as the client uses (Node's global WebSocket, or a test's). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

/** Node's (and Electron's main process') own WebSocket client. */
export const defaultWsFactory: WsFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (u: string) => WsLike }).WebSocket;
  if (!Ctor) throw new Error('no WebSocket in this runtime');
  return new Ctor(url);
};

const OPEN = 1;

export type ConnectOutcome =
  | { kind: 'ready'; sessionId: string | null }
  /** Another client has the server ("Service occupé !"). */
  | { kind: 'busy' }
  | { kind: 'unreachable'; reason: string }
  /** The server answered the handshake with a refusal. */
  | { kind: 'refused'; reason: string; status: RpcStatus | null };

export type CallOutcome =
  | { kind: 'answer'; fn: string | null; status: RpcStatus; result: Record<string, unknown> | null }
  | { kind: 'timeout' }
  /** The connection ended with the call out (busy: by the busy close). */
  | { kind: 'disconnected'; busy: boolean }
  /** Not sent: no connection. */
  | { kind: 'not_connected' };

export interface CashMagSignal {
  name: string;
  fn: string;
  params: Record<string, unknown>;
}

/** Where the session id is kept between connections (the sample kept it a day). */
export interface SessionStore {
  get(): string | null;
  set(id: string | null): void;
}

export function memorySession(): SessionStore {
  let id: string | null = null;
  return { get: () => id, set: (v) => (id = v) };
}

export interface CashMagClientOptions {
  url: string;
  factory?: WsFactory;
  session?: SessionStore;
  log?: (m: string) => void;
  newJobId?: () => string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** A dropped connection with the payment out: how long it is tried again, and how often. */
  reconnectGraceMs?: number;
  reconnectBaseMs?: number;
}

interface Pending {
  fn: string;
  params: Record<string, unknown> | null;
  keep: boolean;
  resolve: (o: CallOutcome) => void;
  timer: NodeJS.Timeout | null;
}

interface HandshakeWait {
  expect: HandshakeStep;
  retried: boolean;
  resolve: (o: ConnectOutcome) => void;
  timer: NodeJS.Timeout;
}

export type ClientState = 'idle' | 'connecting' | 'handshake' | 'ready' | 'reconnecting' | 'busy' | 'closed';

export class CashMagWsClient {
  private ws: WsLike | null = null;
  private st: ClientState = 'idle';
  private readonly pending = new Map<string, Pending>();
  private hs: HandshakeWait | null = null;
  private openWait: ((o: ConnectOutcome | null) => void) | null = null;
  private wanted = false;
  private reconnecting = false;
  private readonly signals = new Set<(s: CashMagSignal) => void>();
  private readonly session: SessionStore;
  private readonly factory: WsFactory;
  private readonly log: (m: string) => void;
  private readonly newJobId: () => string;
  /** Connections opened (tests count them: no reconnect loop). */
  connections = 0;

  constructor(private readonly o: CashMagClientOptions) {
    this.factory = o.factory ?? defaultWsFactory;
    this.session = o.session ?? memorySession();
    this.log = o.log ?? (() => undefined);
    this.newJobId = o.newJobId ?? randomUUID;
  }

  get state(): ClientState {
    return this.st;
  }

  get sessionId(): string | null {
    return this.session.get();
  }

  onSignal(fn: (s: CashMagSignal) => void): () => void {
    this.signals.add(fn);
    return () => this.signals.delete(fn);
  }

  /** The connection and the handshake; `ready` once WELCOME came. */
  async connect(): Promise<ConnectOutcome> {
    if (this.st === 'ready' && this.ws?.readyState === OPEN) return { kind: 'ready', sessionId: this.session.get() };
    this.wanted = true;
    const out = await this.open();
    if (out.kind !== 'ready') this.wanted = false;
    return out;
  }

  /** GOODBYE, then closed; nothing is reconnected after it. Calls still out end `disconnected`. */
  async disconnect(): Promise<void> {
    this.wanted = false;
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) {
      try {
        ws.send(encodeCall({ sessionId: this.session.get(), fn: HANDSHAKE.GOODBYE, jobId: this.newJobId() }));
      } catch {
        // closing anyway
      }
    }
    this.st = 'closed';
    this.ws = null;
    this.drop(ws);
    this.failAll({ kind: 'disconnected', busy: false });
  }

  /**
   * One call: its answer, matched by job id. [timeoutMs] null: no limit (the payment, which lasts as long as the
   * customer); [keep]: it waits through a reconnect (the payment's answer may still come).
   */
  async call(fn: string, params: Record<string, unknown> | null = null, opts: { timeoutMs?: number | null; keep?: boolean } = {}): Promise<CallOutcome> {
    const first = await this.send(fn, params, opts);
    if (first.kind !== 'answer' || first.status.code !== STATUS_INVALID_SESSION) return first;
    // Refused for its session: nothing ran — the session dropped, the handshake again, the call once more.
    this.log(`cashmag ${fn}: invalid session — handshake again`);
    this.session.set(null);
    const again = await this.rehandshake();
    if (again.kind !== 'ready') return first;
    return this.send(fn, params, opts);
  }

  /* ------------------------------------------------------------------ inside */

  private send(fn: string, params: Record<string, unknown> | null, opts: { timeoutMs?: number | null; keep?: boolean }): Promise<CallOutcome> {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || this.st !== 'ready') return Promise.resolve({ kind: 'not_connected' });
    const jobId = this.newJobId();
    return new Promise<CallOutcome>((resolve) => {
      const p: Pending = { fn, params, keep: opts.keep === true, resolve, timer: null };
      const limit = opts.timeoutMs === undefined ? 30_000 : opts.timeoutMs;
      if (limit !== null) {
        p.timer = setTimeout(() => {
          this.pending.delete(jobId);
          this.log(`cashmag ${fn}: no answer in ${limit} ms`);
          resolve({ kind: 'timeout' });
        }, limit);
      }
      this.pending.set(jobId, p);
      try {
        ws.send(encodeCall({ sessionId: this.session.get(), fn, jobId, params }));
      } catch (e) {
        this.pending.delete(jobId);
        if (p.timer) clearTimeout(p.timer);
        this.log(`cashmag ${fn}: not sent (${e instanceof Error ? e.message : String(e)})`);
        resolve({ kind: 'not_connected' });
      }
    });
  }

  private open(): Promise<ConnectOutcome> {
    this.st = this.reconnecting ? 'reconnecting' : 'connecting';
    let ws: WsLike;
    try {
      ws = this.factory(this.o.url);
    } catch (e) {
      this.st = 'closed';
      return Promise.resolve({ kind: 'unreachable', reason: e instanceof Error ? e.message : String(e) });
    }
    this.connections++;
    this.ws = ws;
    return new Promise<ConnectOutcome>((resolve) => {
      let done = false;
      const finish = (out: ConnectOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.openWait = null;
        if (out.kind === 'ready') this.st = 'ready';
        else {
          this.st = out.kind === 'busy' ? 'busy' : 'closed';
          if (this.ws === ws) this.ws = null;
          this.drop(ws);
        }
        resolve(out);
      };
      const timer = setTimeout(() => finish({ kind: 'unreachable', reason: 'connect timeout' }), this.o.connectTimeoutMs ?? 10_000);
      this.openWait = (o) => {
        if (o) finish(o);
      };
      ws.onopen = () => {
        clearTimeout(timer);
        this.st = 'handshake';
        void this.handshake().then(finish);
      };
      ws.onmessage = (ev) => this.onMessage(ws, ev.data);
      ws.onerror = () => undefined;
      ws.onclose = (ev) => this.onClose(ws, ev?.code ?? 1006, typeof ev?.reason === 'string' ? ev.reason : '');
    });
  }

  /** HELLO → WHOAREYOU, IAM → WELCOME on the open socket. */
  private handshake(retried = false): Promise<ConnectOutcome> {
    return new Promise<ConnectOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.hs = null;
        resolve({ kind: 'unreachable', reason: 'handshake timeout' });
      }, this.o.handshakeTimeoutMs ?? 10_000);
      this.hs = {
        expect: HANDSHAKE.WHOAREYOU,
        retried,
        timer,
        resolve: (o) => {
          clearTimeout(timer);
          this.hs = null;
          resolve(o);
        },
      };
      this.step(HANDSHAKE.HELLO);
    });
  }

  private async rehandshake(): Promise<ConnectOutcome> {
    if (!this.ws || this.ws.readyState !== OPEN) return { kind: 'unreachable', reason: 'closed' };
    this.st = 'handshake';
    const out = await this.handshake(true);
    this.st = out.kind === 'ready' ? 'ready' : this.st;
    return out;
  }

  private step(step: HandshakeStep) {
    try {
      this.ws?.send(encodeCall({ sessionId: this.session.get(), fn: step, jobId: this.newJobId() }));
    } catch {
      this.hs?.resolve({ kind: 'unreachable', reason: 'send failed' });
    }
  }

  private onMessage(ws: WsLike, data: unknown) {
    if (ws !== this.ws) return;
    const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data);
    const m = decodeMessage(text);
    if (m.kind === 'invalid') {
      this.log(`cashmag: unreadable message (${m.why})`);
      return;
    }
    if (m.kind === 'step') return this.onStep(m.step, m.sessionId, m.status);
    if (m.kind === 'result') {
      const p = m.jobId ? this.pending.get(m.jobId) : undefined;
      if (!p || !m.jobId) {
        this.log(`cashmag: an answer to no call of ours (${m.fn ?? '?'})`);
        return;
      }
      this.pending.delete(m.jobId);
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ kind: 'answer', fn: m.fn, status: m.status, result: m.result });
      return;
    }
    for (const fn of this.signals) {
      try {
        fn({ name: m.name, fn: m.fn, params: m.params });
      } catch (e) {
        this.log(`cashmag signal ${m.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private onStep(step: HandshakeStep, sessionId: string | null, status: RpcStatus | null) {
    const hs = this.hs;
    if (step === HANDSHAKE.ERROR) {
      const invalid = status?.code === STATUS_INVALID_SESSION;
      if (invalid) this.session.set(null);
      if (hs) {
        if (invalid && !hs.retried) {
          // The session the server no longer knows: dropped, the handshake from its start.
          hs.retried = true;
          hs.expect = HANDSHAKE.WHOAREYOU;
          this.step(HANDSHAKE.HELLO);
          return;
        }
        hs.resolve({ kind: 'refused', reason: status?.message ?? (invalid ? 'INVALID_SESSION' : 'ERROR'), status });
      }
      return;
    }
    if (step === HANDSHAKE.GOODBYE) {
      hs?.resolve({ kind: 'refused', reason: 'GOODBYE', status });
      return;
    }
    if (!hs) return;
    if (step === HANDSHAKE.WHOAREYOU && hs.expect === HANDSHAKE.WHOAREYOU) {
      hs.expect = HANDSHAKE.WELCOME;
      this.step(HANDSHAKE.IAM);
      return;
    }
    if (step === HANDSHAKE.WELCOME && hs.expect === HANDSHAKE.WELCOME) {
      if (sessionId) this.session.set(sessionId);
      hs.resolve({ kind: 'ready', sessionId: this.session.get() });
    }
  }

  private onClose(ws: WsLike, code: number, reason: string) {
    if (ws !== this.ws) return;
    this.ws = null;
    const busy = isBusyClose(reason);
    if (this.hs) {
      this.hs.resolve(busy ? { kind: 'busy' } : { kind: 'unreachable', reason: `closed ${code}${reason ? ` ${reason}` : ''}` });
      return;
    }
    if (this.openWait) {
      this.openWait(busy ? { kind: 'busy' } : { kind: 'unreachable', reason: `closed ${code}${reason ? ` ${reason}` : ''}` });
      return;
    }
    if (busy) {
      // Another client has it now: no reconnect loop.
      this.log('cashmag: closed by the server — busy (Service occupé)');
      this.st = 'busy';
      this.wanted = false;
      this.failAll({ kind: 'disconnected', busy: true });
      return;
    }
    this.st = 'closed';
    this.failAll({ kind: 'disconnected', busy: false }, true);
    const kept = [...this.pending.values()].some((p) => p.keep);
    if (this.wanted && kept) void this.reconnect();
    else this.failAll({ kind: 'disconnected', busy: false });
  }

  /** The payment is out and the connection dropped: back with the same session, within the grace. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const until = Date.now() + (this.o.reconnectGraceMs ?? 15_000);
    let wait = this.o.reconnectBaseMs ?? 500;
    try {
      while (this.wanted && Date.now() < until && [...this.pending.values()].some((p) => p.keep)) {
        await new Promise((r) => setTimeout(r, wait));
        if (!this.wanted) break;
        this.log('cashmag: connection dropped with the payment out — reconnecting');
        const out = await this.open();
        if (out.kind === 'ready') return;
        if (out.kind === 'busy') {
          this.wanted = false;
          this.failAll({ kind: 'disconnected', busy: true });
          return;
        }
        wait = Math.min(wait * 2, 4_000);
      }
      this.failAll({ kind: 'disconnected', busy: false });
    } finally {
      this.reconnecting = false;
    }
  }

  /** Every call out ends with [o] ([exceptKept]: but those that wait through a reconnect). */
  private failAll(o: CallOutcome, exceptKept = false) {
    for (const [id, p] of [...this.pending]) {
      if (exceptKept && p.keep) continue;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(o);
    }
  }

  private drop(ws: WsLike | null) {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(1000);
    } catch {
      // gone already
    }
  }
}
