/**
 * "מזומן" at the shop's cash station — the kiosk's side (P:/specs/cash-paylink.md §11.6, the
 * normative steps; the Android kiosk does the same):
 *
 *  - which station, where and with which secret: `GET /sync/{m}/cash` (ETag), kept in `kv` so a
 *    kiosk with no internet still reaches the station on the LAN (§13);
 *  - the station's status every 10 s while idle: the "מזומן" tile only while it answers ready;
 *  - a payment: the transaction id made here and written to the disk BEFORE anything is asked;
 *    the lease (queue: "עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום", §14.3), renewed; the start
 *    (idempotent by the id); the transaction followed to DONE / HELD; cancel at the customer's word;
 *    the station silent longer than `cashRefundGraceSec` → "lost" (fault slip, staff);
 *  - the acknowledgement once the document is written (or the failure handled), kept and retried
 *    until the station takes it; a kiosk restarted mid-payment settles from the station's word.
 *
 * The way to the station (§14.2 `cashRoute`): the LAN (default), the cloud relay, or `auto` — the LAN while it answers.
 * A payment keeps the way it started on to its end (written with it on the disk); its recovery may try both in
 * `auto`. A host kiosk's own payments at its own station run in this app (§14.1, `setLocalHost`).
 */

import { randomUUID } from 'node:crypto';
import type { Api } from '../sync/api';
import type { Kv } from '../db/schema';
import { LEASE_RENEW_MS, STATUS_POLL_MS, type StationStatus } from '../../core/cash/lanProtocol';
import { paymentVia, recoveryVia, type CashVia } from '../../core/cash/route';
import { cashSettingsOf, type CashSettings } from '../../core/cash/settings';
import type { OwedChoice, TxView } from '../../core/cash/tx';
import { CashCloudClient, CashLanClient, CashLocalClient, clientConfigOf, type CashCalls, type CashReply, type CashStationRef, type LocalCashHost } from '../cash/client';

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
  /** The way its calls go (§14.2), fixed when it started; absent — written before routes (the LAN). */
  via?: CashVia;
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
  /** A host kiosk (§14.1): the cloud gave it the host's part too. */
  hostsStations?: boolean;
}

const K = { config: 'cash.clientConfig', etag: 'cash.clientConfigEtag', pending: 'cash.pending' } as const;
const POLL_MS = 400;
/** Through the cloud: the next look as soon as the previous answer is in (each call is itself ~0.5 s, §14.5). */
const CLOUD_POLL_MS = 100;
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
  private cloud: CashCloudClient | null = null;
  private local: CashLocalClient | null = null;
  /** The host running in this app (a host kiosk, §14.1), for its own payments. */
  private localHost: LocalCashHost | null = null;
  /** When the station last answered on the LAN (`auto` chooses by it). */
  private lastLanAt: number | null = null;
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
      this.cloud = null;
      this.local = null;
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

  /**
   * The cloud set this kiosk to take cash at a station it can reach: on the LAN — one that reported where it listens;
   * through the cloud — any with a host; its own (a host kiosk) — always.
   */
  configured(): boolean {
    const st = this.cfg?.station;
    if (!this.cfg?.enabled || !st) return false;
    if (this.ownHost()) return true;
    return this.settings().route === 'lan' ? !!st.lanAddress : !!st.hostId;
  }

  /** A host kiosk (§14.1): the cloud gave it stations to run. */
  hostsStations(): boolean {
    return this.cfg?.hostsStations === true;
  }

  /** The station's host runs in this app (a host kiosk) — its own payments call it directly. */
  setLocalHost(host: LocalCashHost | null): void {
    if (this.localHost === host) return;
    this.localHost = host;
    this.local = null;
    void this.refreshStatus();
  }

  /** This kiosk's station is run by this kiosk. */
  private ownHost(): boolean {
    const st = this.cfg?.station;
    const me = this.d.machineId();
    return !!st && !!me && !!st.hostId && st.hostId.toLowerCase() === me.toLowerCase();
  }

  /** The station's calls one way (null: that way is not there — no address, no cloud, no host in the app). */
  private transport(via: CashVia): CashCalls | null {
    const st = this.cfg?.station;
    const me = this.d.machineId();
    if (!st || !me) return null;
    if (via === 'local') {
      if (!this.ownHost()) return null;
      if (!this.local) this.local = new CashLocalClient(me, st, () => this.localHost);
      else this.local.setStation(st);
      return this.local;
    }
    if (via === 'cloud') {
      if (!st.hostId) return null;
      if (!this.cloud) this.cloud = new CashCloudClient(me, st, this.d.api, this.now);
      else this.cloud.setStation(st);
      return this.cloud;
    }
    if (!st.lanAddress) return null;
    if (!this.lan) this.lan = new CashLanClient(me, st, this.d.fetch, this.now);
    else this.lan.setStation(st);
    return this.lan;
  }

  /** The station's status the way the tile is fed (§14.2): its own — in the app; `auto` — the LAN, else the cloud. */
  private async probe(): Promise<CashReply<StationStatus> | null> {
    if (this.ownHost()) return (await this.transport('local')?.status()) ?? null;
    const route = this.settings().route;
    if (route !== 'cloud') {
      const lan = this.transport('lan');
      const r = lan ? await lan.status() : null;
      if (r && r.kind !== 'offline') this.lastLanAt = this.now();
      if (route === 'lan' || (r && r.kind !== 'offline')) return r;
    }
    const cloud = this.transport('cloud');
    return cloud ? cloud.status() : null;
  }

  async refreshStatus(): Promise<void> {
    const before = this.usable();
    const r = this.configured() ? await this.probe() : null;
    if (!r) {
      this.status = null;
      this.silentSince = null;
    } else {
      this.status = r.kind === 'ok' ? r.body : null;
      this.statusAt = this.now();
      // Any answer (a refusal too) is the station there; only silence counts — not this kiosk's own way to the cloud.
      if (r.kind === 'offline' && !r.reason.startsWith('cloud:')) this.silentSince ??= this.now();
      else if (r.kind !== 'offline') this.silentSince = null;
    }
    if (this.usable() !== before) this.changed();
  }

  /** The way a payment starting now goes (§14.2). */
  viaForPayment(): CashVia {
    return paymentVia(this.settings().route, this.ownHost(), this.lastLanAt === null ? null : this.now() - this.lastLanAt);
  }

  /**
   * A call for a payment whose own loop is over (its ack, a restart's look, a cancel or finish): its own way first,
   * then — `auto` — the other (§14.2.3); the first that answers.
   */
  private async settleCall<T>(txId: string, fn: (c: CashCalls) => Promise<CashReply<T>>): Promise<CashReply<T> | null> {
    const p = this.pending().find((x) => x.txId === txId);
    const order = recoveryVia(this.settings().route, this.ownHost());
    const ways = p?.via ? [p.via, ...order.filter((v) => v !== p.via)] : order;
    let last: CashReply<T> | null = null;
    for (const via of ways) {
      const c = this.transport(via);
      if (!c) continue;
      last = await fn(c);
      if (last.kind !== 'offline') return last;
    }
    return last;
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
    const via = this.viaForPayment();
    const c = this.transport(via);
    if (!c || !this.cfg?.station) return { kind: 'refunded', tx: null, message: 'מכשיר המזומן לא זמין' };
    this.running = true;
    this.cancelRequested = false;
    this.splitRequested = false;
    // Through the cloud each call is itself ~0.5 s: the next look follows at once (§14.5).
    const poll = this.d.pollMs ?? (via === 'cloud' ? CLOUD_POLL_MS : POLL_MS);
    // The queue asked every 2 s (its place on the screen); the holder's lease renewed the way's own pace — through the
    // cloud every 5 s, and every relayed call renews it anyway (§14.4).
    const queueEvery = Math.min(LEASE_RENEW_MS, Math.max(poll, POLL_MS) * 5);
    const renewEvery = via === 'cloud' ? c.renewMs : queueEvery;
    const settings = this.settings();
    const graceMs = settings.refundGraceSec * 1000;
    const txId = randomUUID();
    const pending: CashPending = { txId, stationId: this.cfg.station.stationId, leaseId: null, orderId: input.orderId, docId: input.docId, amountAgorot: input.amountAgorot, orderLabel: input.orderLabel, startedAt: this.now(), started: false, finalState: null, via };
    this.savePending(pending);
    this.d.log(`cash: payment ${txId} via ${via}`);
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
          onProgress({ stage: 'queued', position: r.body.position, tx: null, message: queuedMessage(r.body.position, long) });
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
        await sleep(queueEvery);
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
    const r = await this.settleCall(txId, (c) => c.ack(txId, documentId, documentNumber, orderLabel, extra));
    if (!r) return false;
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
    const r = await this.settleCall(txId, (c) => c.tx(txId));
    if (!r) return { kind: 'offline' };
    if (r.kind === 'ok') return { kind: 'tx', tx: r.body };
    if (r.kind === 'refused' && r.status === 404) return { kind: 'none' };
    return { kind: 'offline' };
  }

  async cancelAt(txId: string): Promise<void> {
    await this.settleCall(txId, (c) => c.cancel(txId, 'kiosk'));
  }

  /** A split left in PARTIAL by a restart whose card decided (or may have): the cash part is paid (§11.15ב). */
  async finishAt(txId: string): Promise<void> {
    await this.settleCall(txId, (c) => c.finish(txId));
  }

  /** What a restart left of a payment's split (§11.15ב). */
  splitOf(txId: string): CashPending['split'] {
    return this.pending().find((p) => p.txId === txId)?.split ?? null;
  }
}

/**
 * The queue's words (§14.3, every route): "עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום", its place from 2
 * on, and "ההמתנה ארוכה מהרגיל" past `cashQueueTimeoutSec`.
 */
export function queuedMessage(position: number, long: boolean): string {
  return `עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום${position >= 2 ? ` · מקום ${position} בתור` : ''}${long ? ' · ההמתנה ארוכה מהרגיל' : ''}`;
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
