/**
 * "מזומן" at a CashMag machine — the Windows kiosk's side (P:/specs/cashmag-windows.md §5; the money's rules are
 * P:/specs/cashmag.md §3 and §12, the same as the Android till and kiosk):
 *
 *  - off (`cashmagEnabled` false, the default): nothing — no driver, no probe, no connection;
 *  - while idle: the server's port knocked on every 15 s (TCP only — never the machine taken), for the tile and for
 *    the kiosk's `cash` alert to the cloud (`unreachable`, a minute silent);
 *  - a payment: the transaction id made here and written to the disk BEFORE the server is asked anything; the
 *    machine another client's — the claim signal says IN_USE_BY_ANOTHER (the connection kept, the payment going on by
 *    itself the moment it says FREE), or the server closes with "Service occupé !" (asked again every 3 s):
 *    "עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום" with a small "חזרה" — only ever before money, so
 *    never a second charge, and never taking the machine from anyone;
 *  - our own screens (no vendor dialog on Windows): "הכנס מזומן", what went in live (the deposits signal), "ביטול"
 *    (dialogCancel), and the server's questions (dialogValid / dialogCancel);
 *  - the answer read by the contract (core/cash/cashmag.ts): a document only on a plain "paid"; change owed →
 *    the kiosk's own choice; given back → no document; anything unclear → a fault for the staff, kept open in the
 *    journal, and no CashMag payment until a manager says it was dealt with ("טופל");
 *  - after a restart: a payment that was answered "paid" gets its document; one that was sent and never answered
 *    is the staff's (no telling what the device did).
 *
 * It answers in the kiosk's cash outcome (kiosk/cashPay.ts `CashOutcome`, a TxView of its own) so the document,
 * the change-owed choice, the receipt and the slips are the same path as the cash station's.
 */

import { randomUUID } from 'node:crypto';
import type { Kv } from '../db/schema';
import {
  CASHMAG_BUSY_TEXT,
  CASHMAG_ERRORS,
  CASHMAG_HOST_ID,
  CASHMAG_INSERT_TEXT,
  cashmagConfigOf,
  cashmagMayWait,
  cashmagMissing,
  cashmagOutcome,
  cashmagPayable,
  cashmagStationId,
  cashmagUnavailableText,
  refusedReply,
  WAIT_POLL_MS,
  type CashMagConfig,
  type CashMagLocal,
  type CashMagOutcome,
  type CashMagPayRequest,
  type CashRecyclerReply,
} from '../../core/cash/cashmag';
import { cashmagFunctionsOf, type CashMagFunctions } from '../../core/cash/cashmagWire';
import { shekelText } from '../../core/cash/settings';
import { slipCodeOf, type TxView } from '../../core/cash/tx';
import { CashMagWsDriver, type CashMagDriverOptions } from '../cash/cashmagDriver';
import type { SessionStore } from '../cash/cashmagClient';
import { UnavailableRecycler, type CashRecyclerDriver } from '../cash/recycler';
import type { CashOutcome } from './cashPay';

/** One payment in the journal (kv `cashmag.journal`): on the disk before the server is asked anything. */
export interface CashMagEntry {
  txId: string;
  orderId: string;
  docId: string;
  amountAgorot: number;
  dueAgorot: number;
  stationId: string;
  currency: string;
  startedAt: number;
  /** started: nothing sent yet · sent: the payment is with the server · paid: answered paid, document not yet · ended: a fault. */
  stage: 'started' | 'sent' | 'paid' | 'ended';
  /** ended: held (money kept) · unknown (the answer lost) · interrupted (a restart with the payment out). */
  outcome: 'held' | 'unknown' | 'interrupted' | null;
  insertedAgorot: number;
  changeAgorot: number;
  owedAgorot: number;
  heldAgorot: number;
  roundingAgorot: number;
  reason: string | null;
}

export type CashMagStage = 'connecting' | 'busy' | 'insert' | 'question' | 'settling';

export interface CashMagProgress {
  stage: CashMagStage;
  insertedAgorot: number;
  dueAgorot: number;
  question: { title: string; text: string } | null;
  /** Hebrew, as is. */
  message: string;
  canCancel: boolean;
}

/** The kiosk's own CashMag settings (kiosk.json `cashmag`): the server, the name, the user code, function names. */
export type CashMagLocalConfig = CashMagLocal & { functions?: unknown };

export interface CashMagPayDeps {
  kv: Kv;
  /** The till parameters as the cloud resolved them (`cashmag*`). */
  params(): Record<string, unknown>;
  local?: () => CashMagLocalConfig | null;
  kioskName?: () => string | null;
  log(m: string): void;
  now?: () => number;
  newTxId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** The driver for a config (tests: a fake, or the real one against a fake server). */
  driverFor?: (cfg: CashMagConfig, functions: CashMagFunctions, session: SessionStore) => CashRecyclerDriver;
  driverOptions?: CashMagDriverOptions;
  pollMs?: number;
  probeEveryMs?: number;
}

const K = { journal: 'cashmag.journal', session: 'cashmag.session' } as const;

/** kiosk.json `cashmag`, read field by field (a malformed value is ignored: the cloud's stays). */
export function cashmagLocalOf(raw: unknown): CashMagLocalConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const t = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
  const port = typeof o.port === 'number' ? o.port : typeof o.port === 'string' && /^\d{1,5}$/.test(o.port.trim()) ? Number(o.port.trim()) : null;
  return {
    host: t(o.host, 253),
    port: port !== null && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null,
    terminal: t(o.terminal, 40),
    userCode: t(o.userCode, 12),
    functions: o.functions,
  };
}
const SESSION_TTL_MS = 24 * 60 * 60_000;
const STAFF: ReadonlySet<string> = new Set(['held', 'unknown', 'interrupted']);
export const CASHMAG_STATION_NAME = 'CashMag';

export class CashMagPay {
  private driverNow: { key: string; driver: CashRecyclerDriver } | null = null;
  private running: string | null = null;
  private phase: 'waiting' | 'paying' | null = null;
  private cancelRequested = false;
  private cancelSent = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastOkAt = 0;
  private silentSince: number | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private progressNow: ((p: CashMagProgress) => void) | null = null;
  private live: CashMagProgress | null = null;

  constructor(private readonly d: CashMagPayDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /* ------------------------------------------------------------------ settings */

  config(): CashMagConfig {
    return cashmagConfigOf(this.d.params(), this.d.local?.() ?? null, this.d.kioskName?.() ?? null);
  }

  /** The cloud turned CashMag on for this kiosk: it is the kiosk's cash device (instead of a cash station). */
  enabled(): boolean {
    return this.config().enabled;
  }

  stationId(): string {
    const c = this.config();
    return cashmagStationId(c.host, c.port);
  }

  private functions(): CashMagFunctions {
    return cashmagFunctionsOf(this.d.local?.()?.functions);
  }

  /** The session id the server gave, kept a day (as the vendor's sample does). */
  private session(): SessionStore {
    return {
      get: () => {
        const s = this.d.kv.getJson<{ id: string; at: number }>(K.session);
        return s && typeof s.id === 'string' && this.now() - s.at < SESSION_TTL_MS ? s.id : null;
      },
      set: (id) => (id ? this.d.kv.setJson(K.session, { id, at: this.now() }) : this.d.kv.delete(K.session)),
    };
  }

  /** The driver for the protocol set now — made on first need only (CashMag off: never). */
  private driver(cfg: CashMagConfig): CashRecyclerDriver {
    const fns = this.functions();
    const key = `${cfg.protocol}|${JSON.stringify(fns)}`;
    if (this.driverNow?.key === key) return this.driverNow.driver;
    const driver =
      cfg.protocol === 'rlp'
        ? new UnavailableRecycler(CASHMAG_ERRORS.RLP_NOT_AVAILABLE)
        : this.d.driverFor
          ? this.d.driverFor(cfg, fns, this.session())
          : new CashMagWsDriver({ ...this.d.driverOptions, functions: fns, session: this.session(), log: this.d.log });
    this.driverNow = { key, driver };
    return driver;
  }

  /* ------------------------------------------------------------------ idle: is the server there */

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.probe(), this.d.probeEveryMs ?? 15_000);
    this.timer.unref?.();
    void this.probe();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  /** A knock on the server's port (never a WebSocket: nobody's machine taken). Nothing at all while off. */
  async probe(): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled || cfg.protocol !== 'jar' || cashmagMissing(cfg).length > 0) {
      const had = this.silentSince !== null || this.lastOkAt > 0;
      this.silentSince = null;
      this.lastOkAt = 0;
      if (had) this.changed();
      return;
    }
    if (this.running) return;
    const before = this.usable();
    const ok = await this.driver(cfg).probe(cfg);
    if (ok) {
      this.lastOkAt = this.now();
      this.silentSince = null;
    } else this.silentSince ??= this.now();
    if (this.usable() !== before) this.changed();
  }

  private reachable(): boolean {
    return this.lastOkAt > 0 && this.now() - this.lastOkAt < 3 * (this.d.probeEveryMs ?? 15_000);
  }

  /** Why the tile is off now (Hebrew); null: it may be offered. */
  offReason(): string | null {
    const cfg = this.config();
    if (!cfg.enabled) return cashmagUnavailableText(CASHMAG_ERRORS.NOT_CONFIGURED);
    if (cfg.protocol !== 'jar') return cashmagUnavailableText(CASHMAG_ERRORS.RLP_NOT_AVAILABLE);
    if (cashmagMissing(cfg).length > 0) return cashmagUnavailableText(CASHMAG_ERRORS.NOT_CONFIGURED);
    if (this.unresolved().length > 0) return cashmagUnavailableText(CASHMAG_ERRORS.UNRESOLVED);
    if (this.running) return null;
    if (!this.reachable()) return cashmagUnavailableText(CASHMAG_ERRORS.NOT_CONNECTED);
    return null;
  }

  usable(): boolean {
    return this.offReason() === null;
  }

  /** May a payment start now (the server is asked then: unreachable is its own answer). */
  refusal(): string | null {
    const cfg = this.config();
    if (!cfg.enabled || cashmagMissing(cfg).length > 0) return cashmagUnavailableText(CASHMAG_ERRORS.NOT_CONFIGURED);
    if (cfg.protocol !== 'jar') return cashmagUnavailableText(CASHMAG_ERRORS.RLP_NOT_AVAILABLE);
    if (this.unresolved().length > 0) return cashmagUnavailableText(CASHMAG_ERRORS.UNRESOLVED);
    if (this.running) return cashmagUnavailableText(CASHMAG_ERRORS.BUSY);
    return null;
  }

  /**
   * "אין קשר לשרת CashMag": the kiosk's alert for the cloud while the server's port has been silent this long (kind
   * `cash`, reason `unreachable` — as the cash station's). Null while it answers, or while CashMag is off.
   */
  unreachableAlert(afterMs = 60_000): Record<string, unknown> | null {
    const cfg = this.config();
    if (!cfg.enabled || this.silentSince === null || this.now() - this.silentSince < afterMs) return null;
    return {
      kind: 'cash',
      key: 'cash:cashmag:unreachable',
      reason: 'unreachable',
      text: `אין קשר לשרת CashMag (${cfg.host}:${cfg.port})`,
      detail: { stationId: cashmagStationId(cfg.host, cfg.port), stationName: CASHMAG_STATION_NAME, device: 'cashmag' },
    };
  }

  get inFlight(): boolean {
    return this.running !== null;
  }

  /** The driver's view (the staff screen). */
  driverState() {
    return this.driverNow?.driver.state() ?? null;
  }

  /* ------------------------------------------------------------------ the journal */

  journal(): CashMagEntry[] {
    if (this.stopped) return [];
    return this.d.kv.getJson<CashMagEntry[]>(K.journal) ?? [];
  }

  private save(e: CashMagEntry) {
    if (this.stopped) return;
    this.d.kv.setJson(K.journal, [...this.journal().filter((x) => x.txId !== e.txId), e]);
  }

  private remove(txId: string) {
    if (this.stopped) return;
    this.d.kv.setJson(K.journal, this.journal().filter((x) => x.txId !== txId));
  }

  /** The staff's (§3.6): ended unclear, or interrupted — money may be in the device without a sale. Oldest first. */
  unresolved(): CashMagEntry[] {
    return this.journal()
      .filter((e) => e.txId !== this.running && e.stage === 'ended' && e.outcome !== null && STAFF.has(e.outcome))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** A manager dealt with it at the device ("טופל"): closed, with who said so in the log. */
  acknowledge(txId: string, by: string | null): boolean {
    const e = this.journal().find((x) => x.txId === txId || x.txId.replace(/-/g, '').toUpperCase().startsWith(txId.toUpperCase()));
    if (!e || e.txId === this.running || e.stage !== 'ended') return false;
    this.remove(e.txId);
    this.d.log(`cashmag tx ${e.txId.slice(0, 8)}: ${e.outcome} (${e.reason ?? ''}) acknowledged by ${by ?? '?'}`);
    this.changed();
    return true;
  }

  /**
   * The kiosk's acknowledgement after the document (or the failure handled) — the cash station's `ack` here: a paid
   * one is closed once its document is written; a fault stays the staff's.
   */
  async ack(txId: string, documentId: string | null): Promise<boolean> {
    const e = this.journal().find((x) => x.txId === txId);
    if (!e) return true;
    if (e.stage === 'paid' && documentId) {
      this.remove(txId);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ a payment */

  /** "ביטול" / "חזרה": while waiting — the wait ends (nothing reached the device); while paying — dialogCancel. */
  cancel() {
    this.cancelRequested = true;
    if (this.phase === 'paying' && !this.cancelSent && this.driverNow) {
      this.cancelSent = true;
      this.say({ stage: 'settling', message: 'מבטלים — קחו את הכסף מהמכשיר', canCancel: false });
      void this.driverNow.driver.answer(false).then((r) => {
        if (!r.valid) this.d.log(`cashmag cancel: ${r.error ?? ''} ${r.message ?? ''}`);
      });
    }
  }

  /** The customer's answer to the server's question (dialogValid / dialogCancel). */
  async answerQuestion(confirm: boolean): Promise<boolean> {
    if (this.phase !== 'paying' || !this.driverNow || !this.live?.question) return false;
    this.say({ stage: 'insert', question: null, message: CASHMAG_INSERT_TEXT, canCancel: true });
    const r = await this.driverNow.driver.answer(confirm);
    return r.valid;
  }

  private say(p: Partial<CashMagProgress>) {
    if (!this.live) return;
    this.live = { ...this.live, ...p };
    this.progressNow?.(this.live);
  }

  /**
   * One payment: [amountAgorot] is what is left to pay (the tip with it). Answers in the kiosk's cash outcome:
   * paid (a TxView of its own — `hostId` cashmag), refunded (nothing kept), held (a fault: the staff, no document).
   */
  async pay(input: { orderId: string; docId: string; amountAgorot: number }, onProgress: (p: CashMagProgress) => void): Promise<CashOutcome> {
    const refused = this.refusal();
    if (refused) return { kind: 'refunded', tx: null, message: refused };
    if (!(input.amountAgorot > 0)) return { kind: 'refunded', tx: null, message: cashmagUnavailableText(CASHMAG_ERRORS.AMOUNT) };
    const cfg = this.config();
    const txId = (this.d.newTxId ?? randomUUID)();
    const request: CashMagPayRequest = { txId, amountAgorot: input.amountAgorot, dueAgorot: cashmagPayable(cfg.rounding, input.amountAgorot), stationId: cashmagStationId(cfg.host, cfg.port), currency: cfg.currency };
    const entry: CashMagEntry = {
      txId,
      orderId: input.orderId,
      docId: input.docId,
      amountAgorot: request.amountAgorot,
      dueAgorot: request.dueAgorot,
      stationId: request.stationId,
      currency: request.currency,
      startedAt: this.now(),
      stage: 'started',
      outcome: null,
      insertedAgorot: 0,
      changeAgorot: 0,
      owedAgorot: 0,
      heldAgorot: 0,
      roundingAgorot: request.dueAgorot - request.amountAgorot,
      reason: null,
    };
    // On the disk before the server is asked anything (§3.6).
    this.save(entry);
    this.running = txId;
    this.cancelRequested = false;
    this.cancelSent = false;
    this.progressNow = onProgress;
    this.live = { stage: 'connecting', insertedAgorot: 0, dueAgorot: request.dueAgorot, question: null, message: 'מתחבר למכשיר המזומן…', canCancel: true };
    onProgress(this.live);
    this.changed();
    const driver = this.driver(cfg);
    let reply: CashRecyclerReply;
    try {
      reply = await this.ask(driver, cfg, request, entry);
    } catch (e) {
      this.d.log(`cashmag tx ${txId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
      reply = { valid: false, error: CASHMAG_ERRORS.EXCEPTION, message: null, reachedDevice: entry.stage === 'sent', balance: null, fields: {} };
    } finally {
      await driver.disconnect().catch(() => undefined);
      this.phase = null;
    }
    try {
      const outcome = cashmagOutcome(request, reply);
      this.d.log(`cashmag tx ${txId.slice(0, 8)}: ${outcomeText(outcome)}${reply.error ? ` (${reply.error}${reply.message ? `: ${reply.message}` : ''})` : ''}`);
      return this.record(entry, request, outcome, this.live?.insertedAgorot ?? 0);
    } finally {
      this.running = null;
      this.progressNow = null;
      this.live = null;
      this.changed();
    }
  }

  /**
   * The payment asked, with the waits first come first served demands (only ever before money):
   *  - the server closed with "Service occupé !" (or refused to connect as busy): connected again every few seconds;
   *  - connected, and the claim signal says the machine is another client's: the connection kept, the payment sent
   *    the moment it says FREE (or ours);
   *  - the payment itself refused as busy with nothing in: back to one of the two.
   * Until free, "חזרה", or `cashmagQueueTimeoutSec`.
   */
  private async ask(driver: CashRecyclerDriver, cfg: CashMagConfig, request: CashMagPayRequest, entry: CashMagEntry): Promise<CashRecyclerReply> {
    const until = cfg.queueTimeoutSec > 0 ? this.now() + cfg.queueTimeoutSec * 1000 : Number.POSITIVE_INFINITY;
    const poll = this.d.pollMs ?? WAIT_POLL_MS;
    let connected = false;
    for (;;) {
      if (this.cancelRequested) return refusedReply(CASHMAG_ERRORS.WAIT_CANCELLED);
      this.phase = 'waiting';
      let r: CashRecyclerReply = { valid: true, error: null, message: null, reachedDevice: true, balance: null, fields: {} };
      if (!connected) {
        r = await driver.connect(cfg);
        if (r.valid) r = await driver.start();
        connected = r.valid;
      }
      if (connected) {
        const free = await this.claimFree(driver, until, request.txId);
        if (free === 'cancel') return refusedReply(CASHMAG_ERRORS.WAIT_CANCELLED);
        if (free === 'timeout') return refusedReply(CASHMAG_ERRORS.CLAIMED_BY_ANOTHER);
        if (free === 'dropped') {
          connected = false;
          await driver.disconnect();
          continue;
        }
        if (this.cancelRequested) return refusedReply(CASHMAG_ERRORS.WAIT_CANCELLED);
        // The payment goes to the server: from here on, an answer lost is a fault (the journal says so).
        entry.stage = 'sent';
        this.save(entry);
        this.phase = 'paying';
        this.say({ stage: 'insert', insertedAgorot: 0, question: null, message: CASHMAG_INSERT_TEXT, canCancel: true });
        const off = driver.onSignal((sig) => {
          if (sig.type === 'deposits' && typeof sig.insertedAgorot === 'number') {
            this.say({ insertedAgorot: sig.insertedAgorot, ...(this.live?.stage === 'question' ? {} : { message: CASHMAG_INSERT_TEXT }) });
          } else if (sig.type === 'question' && sig.question) {
            this.say({ stage: 'question', question: sig.question, message: sig.question.text || sig.question.title });
          }
        });
        try {
          r = await driver.pay(request.amountAgorot, request.dueAgorot, request.currency, cfg.autoCancelSec);
        } finally {
          off();
        }
        if (!cashmagMayWait(r)) return r;
        // Refused as busy at the payment itself, with nothing in: nothing ran — back to waiting.
        entry.stage = 'started';
        this.save(entry);
        this.phase = 'waiting';
        this.d.log(`cashmag tx ${request.txId.slice(0, 8)}: the payment was refused as busy (${r.error}) — waiting`);
        // With the claim signal on this connection: wait on it there; without it, off and connected again.
        if (driver.state().claim === 'other' && driver.state().connection === 'ready') continue;
        connected = false;
        await driver.disconnect();
      } else if (!cashmagMayWait(r)) return r;
      if (this.now() >= until) return r.valid ? refusedReply(CASHMAG_ERRORS.CLAIMED_BY_ANOTHER) : r;
      this.d.log(`cashmag tx ${request.txId.slice(0, 8)}: the machine is another client's — asked again in ${poll} ms`);
      this.say({ stage: 'busy', message: CASHMAG_BUSY_TEXT, canCancel: true });
      await this.pause(poll);
    }
  }

  /** [ms] in small steps: "חזרה" is heard at once. */
  private async pause(ms: number) {
    const step = Math.min(ms, 250);
    for (let t = 0; t < ms && !this.cancelRequested; t += step) await this.sleep(step);
  }

  /**
   * Connected: is the machine ours to pay at? The claim signal says IN_USE_BY_ANOTHER → the busy screen, the
   * connection kept, until it says FREE / ours (the payment then goes on by itself), "חזרה", the queue's limit, or the
   * connection lost. Not told (no claim signal from this server) → go on: the payment's own refusal says busy.
   */
  private async claimFree(driver: CashRecyclerDriver, until: number, txId: string): Promise<'free' | 'cancel' | 'timeout' | 'dropped'> {
    if (driver.state().claim !== 'other') return 'free';
    this.d.log(`cashmag tx ${txId.slice(0, 8)}: the machine is another client's (claim) — waiting for it to be free`);
    this.say({ stage: 'busy', message: CASHMAG_BUSY_TEXT, canCancel: true });
    for (;;) {
      if (this.cancelRequested) return 'cancel';
      const st = driver.state();
      if (st.connection !== 'ready') return 'dropped';
      if (st.claim !== 'other') {
        this.d.log(`cashmag tx ${txId.slice(0, 8)}: the machine is free (claim ${st.claim}) — the payment goes on`);
        return 'free';
      }
      if (this.now() >= until) return 'timeout';
      await this.sleep(100);
    }
  }

  /** The outcome in the journal and as the kiosk's cash outcome. */
  private record(entry: CashMagEntry, request: CashMagPayRequest, o: CashMagOutcome, liveInserted: number): CashOutcome {
    if (o.kind === 'paid') {
      this.save({ ...entry, stage: 'paid', insertedAgorot: o.receivedAgorot, changeAgorot: o.changeAgorot, owedAgorot: o.changeOwedAgorot, roundingAgorot: o.roundingAgorot });
      return { kind: 'paid', tx: txViewOf(entry, { state: 'DONE', outcome: 'paid', inserted: o.receivedAgorot, change: o.changeAgorot, owed: o.changeOwedAgorot }) };
    }
    if (o.kind === 'cancelled') {
      this.remove(entry.txId);
      const message = o.refundedAgorot > 0 ? `התשלום בוטל — הכסף הוחזר (${shekelText(o.refundedAgorot)})` : 'התשלום בוטל — לא נגבה דבר';
      return { kind: 'refunded', tx: txViewOf(entry, { state: 'DONE', outcome: o.refundedAgorot > 0 ? 'refunded' : 'nothing_inserted', inserted: o.refundedAgorot, refunded: o.refundedAgorot }), message };
    }
    if (o.kind === 'unavailable') {
      this.remove(entry.txId);
      return { kind: 'refunded', tx: null, message: cashmagUnavailableText(o.reason) };
    }
    // A fault: the staff's — no document; what the device was last seen holding goes on the fault slip.
    const held = o.lost ? Math.max(o.heldAgorot, liveInserted) : o.heldAgorot;
    this.save({ ...entry, stage: 'ended', outcome: o.lost ? 'unknown' : 'held', insertedAgorot: o.insertedAgorot || liveInserted, heldAgorot: held, reason: o.reason });
    return { kind: 'held', tx: txViewOf(entry, { state: 'HELD', outcome: null, inserted: o.insertedAgorot || liveInserted, held, message: o.reason }) };
  }

  /**
   * Once at the start (and after each sync): what a restart left. Answered paid → its document now (no paper);
   * sent and never answered → the staff's (the document voided: never one without a clear answer); not sent → closed.
   */
  async settle(h: {
    docStatus(docId: string): 'pending' | 'completed' | 'cancelled' | null;
    writePaid(entry: CashMagEntry, tx: TxView): Promise<boolean>;
    voidDoc(entry: CashMagEntry, outcome: string): void;
    /** Still being finished on the pay screen (the change-owed choice): left alone. */
    live?(entry: CashMagEntry): boolean;
  }): Promise<void> {
    let changed = false;
    for (const e of this.journal()) {
      if (e.txId === this.running || h.live?.(e)) continue;
      const status = h.docStatus(e.docId);
      if (e.stage === 'started') {
        if (status === 'pending') h.voidDoc(e, 'not_started');
        this.remove(e.txId);
        changed = true;
      } else if (e.stage === 'sent') {
        if (status === 'pending') h.voidDoc(e, 'interrupted');
        this.save({ ...e, stage: 'ended', outcome: 'interrupted', reason: 'RESTART' });
        this.d.log(`cashmag tx ${e.txId.slice(0, 8)}: the kiosk restarted with the payment out — the staff's`);
        changed = true;
      } else if (e.stage === 'paid') {
        if (status === 'completed' || status === null) {
          this.remove(e.txId);
          changed = true;
        } else if (status === 'pending') {
          const tx = txViewOf(e, { state: 'DONE', outcome: 'paid', inserted: e.insertedAgorot, change: e.changeAgorot, owed: e.owedAgorot });
          if (await h.writePaid(e, tx).catch(() => false)) {
            this.remove(e.txId);
            changed = true;
          }
        }
      } else if (e.stage === 'ended' && status === 'pending') {
        h.voidDoc(e, e.outcome ?? 'unknown');
        changed = true;
      }
    }
    if (changed) this.changed();
  }
}

function outcomeText(o: CashMagOutcome): string {
  switch (o.kind) {
    case 'paid':
      return `paid in=${o.receivedAgorot} change=${o.changeAgorot} owed=${o.changeOwedAgorot} rounding=${o.roundingAgorot}`;
    case 'cancelled':
      return `cancelled refunded=${o.refundedAgorot}`;
    case 'unavailable':
      return `unavailable ${o.reason ?? ''}`;
    default:
      return `failed ${o.reason} in=${o.insertedAgorot} held=${o.heldAgorot} lost=${o.lost}`;
  }
}

/** The kiosk's view of a CashMag payment (kiosk/cashPay.ts's TxView): one shape for the document and the screens. */
export function txViewOf(
  e: Pick<CashMagEntry, 'txId' | 'stationId' | 'amountAgorot' | 'dueAgorot' | 'startedAt'>,
  f: { state: 'DONE' | 'HELD'; outcome: TxView['outcome']; inserted: number; change?: number; owed?: number; refunded?: number; held?: number; message?: string | null },
): TxView {
  const owed = f.owed ?? 0;
  const change = f.change ?? 0;
  return {
    txId: e.txId,
    stationId: e.stationId,
    hostId: CASHMAG_HOST_ID,
    clientId: '',
    leaseId: '',
    state: f.state,
    outcome: f.outcome,
    amountAgorot: e.amountAgorot,
    dueAgorot: e.dueAgorot,
    roundingAgorot: e.dueAgorot - e.amountAgorot,
    insertedAgorot: f.inserted,
    remainingAgorot: Math.max(0, e.dueAgorot - f.inserted),
    escrowAgorot: 0,
    changeDueAgorot: change + owed,
    changePaidAgorot: change,
    changeOwedAgorot: owed,
    // The kiosk asks the customer what to do with change the machine could not give (§11.15א).
    changeOwedAsk: owed > 0,
    changeOwedAs: null,
    splitAgorot: 0,
    refundDueAgorot: f.refunded ?? 0,
    refundPaidAgorot: f.refunded ?? 0,
    heldAgorot: f.held ?? 0,
    heldReason: f.state === 'HELD' ? 'device_fault' : null,
    cancelReason: f.outcome === 'refunded' || f.outcome === 'nothing_inserted' ? 'customer' : null,
    inserted: [],
    paidOut: [],
    accepting: { coins: [], notes: [] },
    exactOnly: false,
    deadlineAt: 0,
    idleDeadlineAt: 0,
    message: f.message ?? null,
    error: f.state === 'HELD' && f.message ? { code: f.message, message: f.message } : null,
    owedId: null,
    slipCode: owed > 0 || f.state === 'HELD' ? slipCodeOf(e.txId) : null,
    acked: false,
    documentId: null,
    documentNumber: null,
    createdAt: e.startedAt,
    updatedAt: e.startedAt,
    seq: 0,
  };
}
