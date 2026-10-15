/**
 * CashMag over its WebSocket (P:/specs/cashmag-windows.md §3–§4): the [CashRecyclerDriver] the Windows kiosk pays
 * through — a network client of the vendor's CashMag server on the vendor's own box on the LAN (host and port only;
 * whatever OS it runs — the sample came from a Linux setup), like the Android kiosk.
 *
 * One connection per payment: the server is one machine for every till and kiosk, first come first served, and a
 * client holding the connection holds the machine — so the kiosk connects when a customer pays and says GOODBYE
 * when the payment ends (the vendor's sample does the same). While idle it only knocks on the port (`probe`, a TCP
 * connect with no WebSocket), never taking the machine from anyone.
 *
 * Order (the vendor's guide: user and terminal before start): handshake → `setUserName` (when a code is set) →
 * `start` → `payTransaction` → GOODBYE. The function names come from the table (core/cash/cashmagWire.ts).
 */

import net from 'node:net';
import {
  CASHMAG_ERRORS,
  cashmagShekels,
  okReply,
  refusedReply,
  type CashMagConfig,
  type CashRecyclerReply,
} from '../../core/cash/cashmag';
import { CASHMAG_FUNCTIONS, CASHMAG_SIGNALS, claimOf, payReplyOf, piecesOf, questionOf, statusName, totalOf, type CashMagFunctions } from '../../core/cash/cashmagWire';
import { CashMagWsClient, memorySession, type CallOutcome, type SessionStore, type WsFactory } from './cashmagClient';
import { IDLE_STATE, type CashRecyclerDriver, type CashRecyclerSignal, type CashRecyclerState } from './recycler';

export interface CashMagDriverOptions {
  factory?: WsFactory;
  functions?: CashMagFunctions;
  session?: SessionStore;
  log?: (m: string) => void;
  now?: () => number;
  /** Is host:port listening (TCP only); tests replace it. */
  knock?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  connectTimeoutMs?: number;
  reconnectGraceMs?: number;
  reconnectBaseMs?: number;
}

/** A TCP connect and close — no WebSocket, no handshake: the server is there, nobody's machine is taken. */
export function tcpKnock(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const end = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
}

/** ws://host:port (an IPv6 address in brackets). */
export function cashmagUrl(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `ws://${h}:${port}`;
}

export class CashMagWsDriver implements CashRecyclerDriver {
  readonly installed = true;
  readonly notInstalledReason = CASHMAG_ERRORS.NOT_CONNECTED;
  private client: CashMagWsClient | null = null;
  private offClient: (() => void) | null = null;
  private config: CashMagConfig | null = null;
  private st: CashRecyclerState = { ...IDLE_STATE };
  private readonly listeners = new Set<(s: CashRecyclerSignal) => void>();
  private readonly fns: CashMagFunctions;
  private readonly session: SessionStore;
  private readonly log: (m: string) => void;
  private readonly now: () => number;

  constructor(private readonly o: CashMagDriverOptions = {}) {
    this.fns = o.functions ?? { ...CASHMAG_FUNCTIONS };
    this.session = o.session ?? memorySession();
    this.log = o.log ?? (() => undefined);
    this.now = o.now ?? Date.now;
  }

  state(): CashRecyclerState {
    // The connection as the client has it now (it may have dropped since the handshake).
    const c = this.client;
    if (c && this.st.connection === 'ready' && c.state !== 'ready' && c.state !== 'reconnecting') return { ...this.st, connection: c.state === 'busy' ? 'busy' : 'closed' };
    return this.st;
  }

  onSignal(fn: (s: CashRecyclerSignal) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(s: CashRecyclerSignal) {
    this.st = { ...this.st, lastSignal: s.name, lastSignalAt: s.at };
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch (e) {
        this.log(`cashmag signal listener: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private callLimitMs(): number {
    return (this.config?.callTimeoutSec ?? 30) * 1000;
  }

  async connect(config: CashMagConfig): Promise<CashRecyclerReply> {
    await this.disconnect();
    this.config = config;
    this.st = { ...this.st, connection: 'connecting', insertedAgorot: 0, question: null, lastError: null, claim: 'unknown' };
    const client = new CashMagWsClient({
      url: cashmagUrl(config.host, config.port),
      factory: this.o.factory,
      session: this.session,
      log: this.log,
      connectTimeoutMs: this.o.connectTimeoutMs ?? Math.min(10_000, this.callLimitMs()),
      handshakeTimeoutMs: this.callLimitMs(),
      reconnectGraceMs: this.o.reconnectGraceMs,
      reconnectBaseMs: this.o.reconnectBaseMs,
    });
    this.client = client;
    this.offClient = client.onSignal((s) => {
      const at = this.now();
      if (s.name === CASHMAG_SIGNALS.deposits) {
        // The whole list so far (not a delta): what went in, live.
        const inserted = totalOf(piecesOf(s.params.deposits) ?? []);
        this.st = { ...this.st, insertedAgorot: inserted };
        this.emit({ type: 'deposits', name: s.name, at, insertedAgorot: inserted });
      } else if (s.name === CASHMAG_SIGNALS.question) {
        const question = questionOf(s.params);
        this.st = { ...this.st, question };
        this.log(`cashmag question: ${question.title} — ${question.text}`);
        this.emit({ type: 'question', name: s.name, at, question });
      } else if (s.name === CASHMAG_SIGNALS.claim) {
        const claim = claimOf(s.params);
        this.st = { ...this.st, claim };
        this.log(`cashmag claim: ${claim}`);
        this.emit({ type: 'claim', name: s.name, at, claim });
      } else if (s.name === CASHMAG_SIGNALS.deviceChange) {
        this.log(`cashmag pay station notification: ${JSON.stringify(s.params).slice(0, 200)}`);
        this.emit({ type: 'device', name: s.name, at });
      } else {
        this.emit({ type: 'other', name: s.name, at });
      }
    });
    const out = await client.connect();
    if (out.kind === 'busy') {
      this.st = { ...this.st, connection: 'busy', lastError: CASHMAG_ERRORS.CLAIMED_BY_ANOTHER };
      await this.disconnect('busy');
      return refusedReply(CASHMAG_ERRORS.CLAIMED_BY_ANOTHER, 'Service occupé');
    }
    if (out.kind !== 'ready') {
      const reason = out.reason;
      this.st = { ...this.st, connection: 'unreachable', lastError: reason };
      await this.disconnect('unreachable');
      const error = out.kind === 'refused' && out.status ? statusName(out.status.code) : CASHMAG_ERRORS.NOT_CONNECTED;
      return refusedReply(error, reason);
    }
    this.st = { ...this.st, connection: 'ready', reachable: true };
    if (config.userCode) {
      const r = await client.call(this.fns.setUserName, { as_user_name: config.userCode }, { timeoutMs: this.callLimitMs() });
      const reply = this.simple(r, CASHMAG_ERRORS.USER_REFUSED);
      if (!reply.valid) {
        await this.disconnect('unreachable');
        return reply;
      }
    }
    return okReply({ session: client.sessionId ? 'yes' : 'no' });
  }

  /** A call that is not a payment: ok, or refused before money (it never reached a payment). */
  private simple(r: CallOutcome, refusedAs: string): CashRecyclerReply {
    if (r.kind === 'answer') {
      if (r.status.code === 0) {
        if (r.status.warnings.length > 0) this.log(`cashmag ${r.fn ?? ''}: warnings ${JSON.stringify(r.status.warnings).slice(0, 200)}`);
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.result ?? {})) fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
        return okReply(fields);
      }
      const name = statusName(r.status.code);
      this.st = { ...this.st, lastError: r.status.message ?? name };
      return refusedReply(name.startsWith('CM_STATUS_') ? refusedAs : name, r.status.message ?? name);
    }
    if (r.kind === 'timeout') return refusedReply(CASHMAG_ERRORS.TIMEOUT);
    if (r.kind === 'disconnected' && r.busy) return refusedReply(CASHMAG_ERRORS.CLAIMED_BY_ANOTHER);
    return refusedReply(CASHMAG_ERRORS.NOT_CONNECTED);
  }

  async start(): Promise<CashRecyclerReply> {
    if (!this.client) return refusedReply(CASHMAG_ERRORS.NOT_CONNECTED);
    // Device discovery may take seconds (the vendor's guide).
    return this.simple(await this.client.call(this.fns.start, null, { timeoutMs: this.callLimitMs() }), CASHMAG_ERRORS.NOT_STARTED);
  }

  async stop(): Promise<CashRecyclerReply> {
    if (!this.client) return refusedReply(CASHMAG_ERRORS.NOT_CONNECTED);
    return this.simple(await this.client.call(this.fns.stop, null, { timeoutMs: this.callLimitMs() }), CASHMAG_ERRORS.EXCEPTION);
  }

  async pay(_amountAgorot: number, dueAgorot: number, currency: string, _autoCancelSec: number): Promise<CashRecyclerReply> {
    const client = this.client;
    if (!client) return refusedReply(CASHMAG_ERRORS.NOT_CONNECTED);
    this.st = { ...this.st, insertedAgorot: 0, question: null };
    // As long as the customer takes: no limit of ours; through a dropped connection while the grace lasts.
    const r = await client.call(this.fns.pay, { adc_transaction_amount: cashmagShekels(dueAgorot), as_transaction_currency: currency }, { timeoutMs: null, keep: true });
    this.st = { ...this.st, question: null };
    if (r.kind === 'answer') {
      const reply = payReplyOf({ status: r.status, result: r.result }, dueAgorot);
      // Refused while the claim signal says the machine is another client's, and nothing went in (no figures, no
      // deposit seen): the machine was not ours to take money with — a wait, never a fault.
      if (!reply.valid && this.st.claim === 'other' && this.st.insertedAgorot === 0 && (reply.balance?.cashInAgorot ?? 0) === 0 && reply.error !== CASHMAG_ERRORS.INCONSISTENT) {
        return { ...refusedReply(CASHMAG_ERRORS.CLAIMED_BY_ANOTHER, reply.message), fields: reply.fields };
      }
      return reply;
    }
    if (r.kind === 'not_connected') return refusedReply(CASHMAG_ERRORS.NOT_CONNECTED);
    // Sent, and the answer is gone: no telling what the device did (never "nothing happened").
    return { valid: false, error: CASHMAG_ERRORS.DISCONNECTED, message: r.kind === 'disconnected' && r.busy ? 'Service occupé' : null, reachedDevice: true, balance: null, fields: {} };
  }

  async answer(confirm: boolean): Promise<CashRecyclerReply> {
    const client = this.client;
    if (!client) return refusedReply(CASHMAG_ERRORS.NOT_CONNECTED);
    this.st = { ...this.st, question: null };
    return this.simple(await client.call(confirm ? this.fns.dialogValid : this.fns.dialogCancel, {}, { timeoutMs: this.callLimitMs() }), CASHMAG_ERRORS.EXCEPTION);
  }

  async probe(config: CashMagConfig): Promise<boolean> {
    const knock = this.o.knock ?? tcpKnock;
    const ok = await knock(config.host, config.port, 3_000).catch(() => false);
    this.st = { ...this.st, reachable: ok };
    return ok;
  }

  async disconnect(why: 'done' | 'busy' | 'unreachable' = 'done'): Promise<void> {
    const c = this.client;
    this.client = null;
    this.offClient?.();
    this.offClient = null;
    if (c) await c.disconnect();
    if (why === 'done' && this.st.connection !== 'idle') this.st = { ...this.st, connection: 'closed' };
  }

  /** Connections opened by the client now (tests). */
  get connections(): number {
    return this.client?.connections ?? 0;
  }
}
