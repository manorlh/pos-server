/**
 * "מזומן" at the shop's cash station — the kiosk's side (P:/specs/cash-paylink.md §11.6, the
 * normative steps; the Android kiosk does the same):
 *
 *  - which station, where and with which secret: `GET /sync/{m}/cash` (ETag), kept in `kv` so a
 *    kiosk with no internet still reaches the station on the LAN (§13);
 *  - the station's status every 10 s while idle: the "מזומן" tile only while it answers ready;
 *  - a payment: the transaction id made here and written to the disk BEFORE anything is asked;
 *    the lease (queue: "מכשיר המזומן תפוס — ממתין… (מקום N)"), renewed every 2 s; the start
 *    (idempotent by the id); the transaction followed to DONE / HELD; cancel at the customer's word;
 *    the station silent longer than `cashRefundGraceSec` → "lost" (fault slip, staff);
 *  - the acknowledgement once the document is written (or the failure handled), kept and retried
 *    until the station takes it; a kiosk restarted mid-payment settles from the station's word.
 */

import { randomUUID } from 'node:crypto';
import type { Api } from '../sync/api';
import type { Kv } from '../db/schema';
import { LEASE_RENEW_MS, STATUS_POLL_MS, type StationStatus } from '../../core/cash/lanProtocol';
import { cashSettingsOf, type CashSettings } from '../../core/cash/settings';
import type { OwedChoice, TxView } from '../../core/cash/tx';
import { CashLanClient, clientConfigOf, type CashReply, type CashStationRef } from '../cash/client';

export interface CashPending {
  txId: string;
  stationId: string;
  leaseId: string | null;
  orderId: string;
  docId: string;
  amountAgorot: number;
  orderLabel: string | null;
  startedAt: number;
  /** The start was sent (the station may hold money for it). */
  started: boolean;
  /** Final at the station; only the acknowledgement is left. */
  finalState: 'DONE' | 'HELD' | null;
  /**
   * Cash + card (§11.15ב): the cash part the station holds (PARTIAL) and what the card's outcome made of it — `finish`
   * (approved, or unknown: the cash is kept and the card decides) or `cancel` (refunded). A restart goes on from here.
   */
  split?: { cashAgorot: number; decision: 'finish' | 'cancel' | null } | null;
}

export type CashStage = 'connecting' | 'queued' | 'insert' | 'settling' | 'change' | 'refunding' | 'split_card';

export interface CashProgress {
  stage: CashStage;
  position: number | null;
  tx: TxView | null;
  /** Hebrew, as is. */
  message: string;
}

export type CashOutcome =
  | { kind: 'paid'; tx: TxView }
  /** No money taken, or all of it back: the order is not paid. */
  | { kind: 'refunded'; tx: TxView | null; message: string }
  /** The station keeps what the customer is owed: staff (a fault slip with the transaction). */
  | { kind: 'held'; tx: TxView }
  /** The station went silent mid-payment: unknown — a fault slip, settled when it answers again. */
  | { kind: 'lost'; txId: string; insertedAgorot: number };

interface ClientConfig {
  enabled: boolean;
  station: CashStationRef | null;
  settings: Record<string, unknown>;
}

const K = { config: 'cash.clientConfig', etag: 'cash.clientConfigEtag', pending: 'cash.pending' } as const;
const POLL_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CashPayDeps {
  api: Api;
  kv: Kv;
  machineId(): string | null;
  log(m: string): void;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests: shorter waits. */
  pollMs?: number;
}

export class CashPay {
  private cfg: ClientConfig | null;
  private status: StationStatus | null = null;
  private statusAt = 0;
  /** Since when the station has not answered on the LAN (null: it answers / no station). */
  private silentSince: number | null = null;
  private lan: CashLanClient | null = null;
  private cancelRequested = false;
  private splitRequested = false;
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly d: CashPayDeps) {
    this.cfg = d.kv.getJson<ClientConfig>(K.config);
    this.now = d.now ?? Date.now;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.running) void this.refreshStatus();
    }, STATUS_POLL_MS);
    void this.refreshStatus();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  /* ------------------------------------------------------------------ the cloud's word */

  async pull(): Promise<void> {
    const m = this.d.machineId();
    if (!m) return;
    const etag = this.d.kv.get(K.etag);
    const reply = await this.d.api.get<Record<string, unknown>>(`sync/${m}/cash`, { headers: etag && this.cfg ? { 'If-None-Match': etag } : {}, timeoutMs: 15_000 });
    if (reply.kind !== 'ok' || reply.status === 304) return;
    const c = clientConfigOf(reply.body);
    if (!c) return;
    const before = JSON.stringify(this.cfg);
    this.cfg = c;
    this.d.kv.setJson(K.config, c);
    const tag = reply.headers.get('etag');
    if (tag) this.d.kv.set(K.etag, tag);
    if (JSON.stringify(c) !== before) {
      this.lan = null;
      this.changed();
      void this.refreshStatus();
    }
  }

  settings(): CashSettings {
    return cashSettingsOf(this.cfg?.settings ?? {});
  }

  station(): CashStationRef | null {
    return this.cfg?.station ?? null;
  }

  /** The cloud set this kiosk to take cash at a station that reported where it listens. */
  configured(): boolean {
    return !!this.cfg?.enabled && !!this.cfg.station?.lanAddress;
  }

  private client(): CashLanClient | null {
    const st = this.cfg?.station;
    const me = this.d.machineId();
    if (!st || !me || !st.lanAddress) return null;
    if (!this.lan) this.lan = new CashLanClient(me, st, this.d.fetch, this.now);
    else this.lan.setStation(st);
    return this.lan;
  }

  async refreshStatus(): Promise<void> {
    const c = this.configured() ? this.client() : null;
    const before = this.usable();
    if (!c) {
      this.status = null;
      this.silentSince = null;
    } else {
      const r = await c.status();
      this.status = r.kind === 'ok' ? r.body : null;
      this.statusAt = this.now();
      // Any answer (a refusal too) is the station there; only silence counts.
      if (r.kind === 'offline') this.silentSince ??= this.now();
      else this.silentSince = null;
    }
    if (this.usable() !== before) this.changed();
  }

  /** The "מזומן" tile may be offered: configured, and the station answered ready lately. */
  usable(): boolean {
    return this.configured() && !!this.status?.ready && this.now() - this.statusAt < 3 * STATUS_POLL_MS;
  }

  /**
   * "אין קשר לעמדת המזומן" (P:/specs/cash-paylink.md §11.8, §11.15ג): the kiosk's own alert for the cloud while its
   * station has been silent on the LAN this long — the station, by id and name. Null while it answers.
   */
  unreachableAlert(afterMs = 60_000): Record<string, unknown> | null {
    const st = this.cfg?.station;
    if (!this.configured() || !st || this.silentSince === null || this.now() - this.silentSince < afterMs) return null;
    return {
      kind: 'cash',
      key: 'cash:unreachable',
      reason: 'unreachable',
      text: `אין קשר לעמדת המזומן ${st.name}`,
      detail: { stationId: st.stationId, stationName: st.name },
    };
  }

  offReason(): string | null {
    if (!this.configured()) return 'מזומן לא מוגדר לקיוסק';
    if (!this.status) return 'מכשיר המזומן לא זמין';
    return this.status.ready ? null : (this.status.reason ?? 'מכשיר המזומן לא זמין');
  }

  get inFlight(): boolean {
    return this.running;
  }

  /* ------------------------------------------------------------------ the pending payments (the disk) */

  pending(): CashPending[] {
    // After stop() the database may be closed: nothing more is read or written here.
    if (this.stopped) return [];
    return this.d.kv.getJson<CashPending[]>(K.pending) ?? [];
  }

  private savePending(p: CashPending) {
    if (this.stopped) return;
    const list = this.pending().filter((x) => x.txId !== p.txId);
    list.push(p);
    this.d.kv.setJson(K.pending, list);
  }

  forget(txId: string) {
    if (this.stopped) return;
    this.d.kv.setJson(
      K.pending,
      this.pending().filter((x) => x.txId !== txId),
    );
  }

  /* ------------------------------------------------------------------ a payment */

  cancel() {
    this.cancelRequested = true;
  }

  /** "להשלים באשראי" (§11.15ב): the payment in flight asks the station for its cash part so far. */
  requestSplit(): boolean {
    if (!this.running) return false;
    this.splitRequested = true;
    return true;
  }

  /**
   * [hooks.partial]: the station holds the cash part (PARTIAL) — the card is charged for the rest meanwhile (the lease
   * renewed all along) and its word decides: `finish` (the cash part paid) or `cancel` (all of it back).
   */
  async pay(
    input: { orderId: string; docId: string; amountAgorot: number; orderLabel: string | null },
    onProgress: (p: CashProgress) => void,
    hooks: { partial?: (tx: TxView) => Promise<'finish' | 'cancel'> } = {},
  ): Promise<CashOutcome> {
    const c = this.client();
    if (!c || !this.cfg?.station) return { kind: 'refunded', tx: null, message: 'מכשיר המזומן לא זמין' };
    this.running = true;
    this.cancelRequested = false;
    this.splitRequested = false;
    const poll = this.d.pollMs ?? POLL_MS;
    const renewEvery = Math.min(LEASE_RENEW_MS, poll * 5);
    const settings = this.settings();
    const graceMs = settings.refundGraceSec * 1000;
    const txId = randomUUID();
    const pending: CashPending = { txId, stationId: this.cfg.station.stationId, leaseId: null, orderId: input.orderId, docId: input.docId, amountAgorot: input.amountAgorot, orderLabel: input.orderLabel, startedAt: this.now(), started: false, finalState: null };
    this.savePending(pending);
    try {
      // 1. The lease: the head of the station's queue.
      onProgress({ stage: 'connecting', position: null, tx: null, message: 'מתחבר למכשיר המזומן…' });
      let silentSince: number | null = null;
      const queueStart = this.now();
      for (;;) {
        if (this.cancelRequested) {
          if (pending.leaseId) await c.release(pending.leaseId);
          this.forget(txId);
          return { kind: 'refunded', tx: null, message: 'התשלום בוטל' };
        }
        const r = await c.lease(pending.leaseId, txId, input.amountAgorot);
        if (r.kind === 'ok') {
          silentSince = null;
          if (pending.leaseId !== r.body.leaseId) {
            pending.leaseId = r.body.leaseId;
            this.savePending(pending);
          }
          if (r.body.state === 'granted') break;
          const long = this.now() - queueStart > settings.queueTimeoutSec * 1000;
          onProgress({ stage: 'queued', position: r.body.position, tx: null, message: `מכשיר המזומן תפוס — ממתין… (מקום ${r.body.position})${long ? ' · ההמתנה ארוכה מהרגיל' : ''}` });
        } else if (r.kind === 'refused') {
          if (r.error === 'unknown_lease') pending.leaseId = null;
          else {
            this.forget(txId);
            return { kind: 'refunded', tx: null, message: typeof r.body.message === 'string' ? r.body.message : 'מכשיר המזומן לא זמין' };
          }
        } else {
          silentSince ??= this.now();
          if (this.now() - silentSince > 15_000) {
            this.forget(txId);
            return { kind: 'refunded', tx: null, message: 'מכשיר המזומן לא זמין' };
          }
        }
        await sleep(renewEvery);
      }
      // 2. The start (idempotent: sent again until the station answers).
      pending.started = true;
      this.savePending(pending);
      let tx: TxView | null = null;
      silentSince = null;
      for (;;) {
        const r = await c.start(txId, { leaseId: pending.leaseId!, amountAgorot: input.amountAgorot, orderRef: input.orderId, orderLabel: input.orderLabel });
        if (r.kind === 'ok') {
          tx = r.body;
          break;
        }
        if (r.kind === 'refused') {
          // Not started at all (the station refused): nothing taken.
          this.forget(txId);
          if (pending.leaseId) await c.release(pending.leaseId);
          return { kind: 'refunded', tx: null, message: typeof r.body.message === 'string' ? r.body.message : 'מכשיר המזומן לא זמין' };
        }
        silentSince ??= this.now();
        if (this.now() - silentSince > graceMs) return { kind: 'lost', txId, insertedAgorot: 0 };
        await sleep(poll);
      }
      // 3. Following it to the end.
      let cancelSent = false;
      let splitSent = false;
      let decisionSent = false;
      let lastRenew = this.now();
      silentSince = null;
      for (;;) {
        if (this.cancelRequested && !cancelSent && (tx.state === 'LEASED' || tx.state === 'ACCEPTING')) {
          const r = await c.cancel(txId, 'customer');
          if (r.kind !== 'offline') cancelSent = true;
          if (r.kind === 'ok') tx = r.body;
        }
        if (this.splitRequested && !splitSent && !this.cancelRequested && tx.state === 'ACCEPTING') {
          const r = await c.split(txId);
          if (r.kind !== 'offline') splitSent = true;
          if (r.kind === 'ok') tx = r.body;
          else if (r.kind === 'refused') this.splitRequested = false;
        }
        if (tx.state === 'PARTIAL') {
          if (!pending.split) {
            pending.split = { cashAgorot: tx.splitAgorot, decision: null };
            this.savePending(pending);
          }
          if (pending.split.decision === null) {
            onProgress({ stage: 'split_card', position: 0, tx, message: tx.message ?? '' });
            // The card is charged meanwhile: the lease is renewed all along (the station would refund a silent kiosk).
            const lease = pending.leaseId;
            const renew = setInterval(() => void c.lease(lease, txId), renewEvery);
            let decision: 'finish' | 'cancel' = 'cancel';
            try {
              decision = hooks.partial ? await hooks.partial(tx) : 'cancel';
            } catch (e) {
              this.d.log(`cash split: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              clearInterval(renew);
            }
            pending.split = { ...pending.split, decision };
            this.savePending(pending);
            lastRenew = this.now();
          }
          if (!decisionSent) {
            const r: CashReply<TxView> = pending.split.decision === 'finish' ? await c.finish(txId) : await c.cancel(txId, 'customer');
            if (r.kind === 'ok') {
              decisionSent = true;
              tx = r.body;
            } else if (r.kind === 'refused') decisionSent = true;
          }
        }
        if (this.now() - lastRenew >= renewEvery) {
          await c.lease(pending.leaseId, txId);
          lastRenew = this.now();
        }
        // The app quits mid-payment: the transaction stays pending on the disk, settled at the next start.
        if (this.stopped) return { kind: 'lost', txId, insertedAgorot: tx.insertedAgorot };
        const r = await c.tx(txId);
        if (r.kind === 'ok') {
          silentSince = null;
          tx = r.body;
          if (tx.state === 'DONE' || tx.state === 'HELD') {
            pending.finalState = tx.state;
            this.savePending(pending);
            if (tx.state === 'HELD') return { kind: 'held', tx };
            if (tx.outcome === 'paid') return { kind: 'paid', tx };
            return { kind: 'refunded', tx, message: tx.outcome === 'nothing_inserted' ? 'לא הוכנס כסף' : 'הכסף הוחזר' };
          }
          onProgress({ stage: stageOf(tx), position: 0, tx, message: tx.message ?? '' });
        } else {
          silentSince ??= this.now();
          if (this.now() - silentSince > graceMs) return { kind: 'lost', txId, insertedAgorot: tx.insertedAgorot };
        }
        await sleep(poll);
      }
    } finally {
      this.running = false;
      this.cancelRequested = false;
    }
  }

  /**
   * The document is written (or the failure handled): the station may let the lease go. Kept until it answers.
   * [extra]: the customer's choice for the change owed (§11.15א); `void` — a split sale's document voided (§11.15ב).
   */
  async ack(txId: string, documentId: string | null, documentNumber: string | null, orderLabel: string | null = null, extra: { changeOwedAs?: OwedChoice | null; void?: boolean } = {}): Promise<boolean> {
    const c = this.client();
    if (!c) return false;
    const r = await c.ack(txId, documentId, documentNumber, orderLabel, extra);
    if (r.kind === 'ok' || (r.kind === 'refused' && r.status === 404)) {
      this.forget(txId);
      return true;
    }
    const p = this.pending().find((x) => x.txId === txId);
    if (p) this.savePending({ ...p, finalState: p.finalState ?? 'DONE' });
    return false;
  }

  /** The station's word on a pending payment (recovery after a restart / a lost station). */
  async lookUp(txId: string): Promise<{ kind: 'tx'; tx: TxView } | { kind: 'none' } | { kind: 'offline' }> {
    const c = this.client();
    if (!c) return { kind: 'offline' };
    const r = await c.tx(txId);
    if (r.kind === 'ok') return { kind: 'tx', tx: r.body };
    if (r.kind === 'refused' && r.status === 404) return { kind: 'none' };
    return { kind: 'offline' };
  }

  async cancelAt(txId: string): Promise<void> {
    await this.client()?.cancel(txId, 'kiosk');
  }

  /** A split left in PARTIAL by a restart whose card decided (or may have): the cash part is paid (§11.15ב). */
  async finishAt(txId: string): Promise<void> {
    await this.client()?.finish(txId);
  }

  /** What a restart left of a payment's split (§11.15ב). */
  splitOf(txId: string): CashPending['split'] {
    return this.pending().find((p) => p.txId === txId)?.split ?? null;
  }
}

export function stageOf(tx: TxView): CashStage {
  switch (tx.state) {
    case 'SETTLING':
      return 'settling';
    case 'PAYING_CHANGE':
      return 'change';
    case 'REFUNDING':
      return 'refunding';
    case 'PARTIAL':
      return 'split_card';
    default:
      return 'insert';
  }
}
