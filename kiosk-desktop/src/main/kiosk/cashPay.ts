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
import type { TxView } from '../../core/cash/tx';
import { CashLanClient, clientConfigOf, type CashStationRef } from '../cash/client';

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
}

export type CashStage = 'connecting' | 'queued' | 'insert' | 'settling' | 'change' | 'refunding';

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
  private lan: CashLanClient | null = null;
  private cancelRequested = false;
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
    } else {
      const r = await c.status();
      this.status = r.kind === 'ok' ? r.body : null;
      this.statusAt = this.now();
    }
    if (this.usable() !== before) this.changed();
  }

  /** The "מזומן" tile may be offered: configured, and the station answered ready lately. */
  usable(): boolean {
    return this.configured() && !!this.status?.ready && this.now() - this.statusAt < 3 * STATUS_POLL_MS;
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

  async pay(input: { orderId: string; docId: string; amountAgorot: number; orderLabel: string | null }, onProgress: (p: CashProgress) => void): Promise<CashOutcome> {
    const c = this.client();
    if (!c || !this.cfg?.station) return { kind: 'refunded', tx: null, message: 'מכשיר המזומן לא זמין' };
    this.running = true;
    this.cancelRequested = false;
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
      let lastRenew = this.now();
      silentSince = null;
      for (;;) {
        if (this.cancelRequested && !cancelSent && (tx.state === 'LEASED' || tx.state === 'ACCEPTING')) {
          const r = await c.cancel(txId, 'customer');
          if (r.kind !== 'offline') cancelSent = true;
          if (r.kind === 'ok') tx = r.body;
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

  /** The document is written (or the failure handled): the station may let the lease go. Kept until it answers. */
  async ack(txId: string, documentId: string | null, documentNumber: string | null, orderLabel: string | null = null): Promise<boolean> {
    const c = this.client();
    if (!c) return false;
    const r = await c.ack(txId, documentId, documentNumber, orderLabel);
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
}

export function stageOf(tx: TxView): CashStage {
  switch (tx.state) {
    case 'SETTLING':
      return 'settling';
    case 'PAYING_CHANGE':
      return 'change';
    case 'REFUNDING':
      return 'refunding';
    default:
      return 'insert';
  }
}
