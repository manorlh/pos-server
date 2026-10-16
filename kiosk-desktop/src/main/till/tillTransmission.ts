/**
 * "פעולות אשראי" on the Windows till (pos-android ui/reports/TransmissionScreen.kt `TransmissionViewModel`,
 * data/repo/TerminalInfoRepository.kt, P:/specs/nayax-deferred-all.md §10–§13): the rules and the words are
 * core/till/transmission.ts; this module holds the screen's state and talks to the terminal and the cloud:
 *
 *  - the terminal's deferred mode ("מצב לא מקוון (Deferred)") read with `getConfig ["device"]` — when the screen opens, and
 *    every two minutes while nothing is on the terminal (never with a card on it, nor 45 s after one) — kept on disk, so the
 *    §13 warning on the payment screen and the sell screen's banner say it from the first second;
 *  - its switch (a confirmation first on the way on) and "אשר עסקאות ממתינות" — under TRANSMIT, the engine's gate;
 *  - "שדר עסקאות עכשיו": the service's transmission (doPeriodic, the row to the cloud through the outbox);
 *  - the history: `GET /sync/{m}/transmissions?limit=30&offset=N`, with this till's rows the cloud does not have yet.
 *
 * Electron-free.
 */

import { formatShekelSign } from '../../core/money';
import {
  TX_TEXT,
  ageText,
  authorizationText,
  deferredCardNotices,
  deferredPendingOnTerminal,
  mergeHistory,
  offlineBanner,
  pendingLine,
  rowOf,
  rowWords,
  transmitResultMessage,
  type Authorization,
  type OfflineModeStatus,
  type TransmissionRow,
} from '../../core/till/transmission';
import type { TillContext } from './tillContext';

const OFFLINE_KEY = 'till.terminalOffline';
/** This till's count of card sales approved while the terminal was deferred (tillOfflinePending), until they are approved. */
const OWN_PENDING_KEY = 'till.offlinePending';
const READ_EVERY_MS = 120_000;
const PAGE = 30;

interface KeptOffline extends OfflineModeStatus {
  readAt: number;
}

/** `TillState.transmission`: what "פעולות אשראי" shows. */
export interface TransmissionView {
  /** A terminal here that transmits (Nayax / SynqPay); else the screen says so. */
  supported: boolean;
  deferredSupported: boolean;
  offline: {
    reading: boolean;
    failed: boolean;
    status: (OfflineModeStatus & { readAt: number }) | null;
    stateLine: string | null;
    limitsLine: string | null;
    switching: boolean;
  };
  pendingLine: string | null;
  neverTransmitted: boolean;
  lastFailed: string | null;
  running: boolean;
  message: string | null;
  history: {
    rows: Array<{ id: string; at: string | null; status: string; tone: 'ok' | 'error' | 'muted'; trigger: string; facts: string[]; detail: string | null; unsynced: boolean }>;
    total: number | null;
    error: string | null;
    loading: boolean;
    more: boolean;
  };
}

export class TillTransmission {
  private reading = false;
  private readFailed = false;
  private switching = false;
  private running = false;
  private message: string | null = null;
  private batch: { count: number | null; amountAgorot: number | null } | null = null;
  private cloudRows: TransmissionRow[] = [];
  private total: number | null = null;
  private historyError: string | null = null;
  private loading = false;
  private offset = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly c: TillContext) {}

  start() {
    const tick = () => {
      if (!this.c.svc.pay.deferredSupported || this.c.paying() || !this.c.svc.pay.terminalQuiet()) return;
      void this.readOffline(false).catch(() => undefined);
    };
    this.timers.push(setTimeout(tick, 10_000), setInterval(tick, READ_EVERY_MS));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  /* ------------------------------------------------------------------ the terminal's deferred mode */

  kept(): KeptOffline | null {
    return this.c.svc.kv.getJson<KeptOffline>(OFFLINE_KEY);
  }

  /** `tillOfflineMode`: the terminal works deferred, as it last said (a SynqPay or no terminal: never). */
  offlineOn(): boolean {
    return this.c.svc.pay.deferredSupported && this.kept()?.working === true;
  }

  /** What waits for the card company: this till's count since the last approval, or the terminal's own by its limits. */
  pendingOffline(): number {
    const own = Math.max(0, this.c.svc.kv.getNumber(OWN_PENDING_KEY) ?? 0);
    return Math.max(own, deferredPendingOnTerminal(this.kept()) ?? 0);
  }

  /** A card sale approved while deferred: one more for the card company. */
  noteApprovedCard() {
    if (!this.offlineOn()) return;
    this.c.svc.kv.setNumber(OWN_PENDING_KEY, Math.max(0, this.c.svc.kv.getNumber(OWN_PENDING_KEY) ?? 0) + 1);
  }

  private remember(status: OfflineModeStatus) {
    this.c.svc.kv.setJson(OFFLINE_KEY, { ...status, readAt: this.c.now() } satisfies KeptOffline);
  }

  /** `getConfig ["device"]`: read and kept; [forced] — a person asked (the screen), still never with a card on it. */
  async readOffline(forced = true): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    this.readFailed = false;
    this.c.changed();
    try {
      const r = await this.c.svc.pay.offlineMode(forced);
      if (!r) return;
      if (r.status) this.remember(r.status);
      else this.readFailed = true;
    } finally {
      this.reading = false;
      this.c.changed();
    }
  }

  /** The switch, decided and approved by the engine: read back; on the way off the deferred sales sent for approval. */
  async switchOffline(on: boolean): Promise<string> {
    if (this.switching) return TX_TEXT.switching;
    this.switching = true;
    this.c.changed();
    try {
      const r = await this.c.svc.pay.setOfflineMode(on);
      if (!r) return TX_TEXT.noTerminal;
      if (r.error === 'busy') return (this.message = TX_TEXT.busy);
      if (r.status) this.remember(r.status);
      if (r.error) return (this.message = TX_TEXT.switchFailed(r.error));
      this.c.log(`terminal: deferred mode ${on ? 'on' : 'off'}`);
      this.recordEvent(on ? 'deferred_mode_on' : 'deferred_mode_off', r.authorization);
      if (on) return (this.message = TX_TEXT.turnedOn);
      if (r.authorization?.ok) this.authorized();
      return (this.message = `${TX_TEXT.turnedOff}\n${authorizationText(r.authorization, (a) => formatShekelSign(a))}`);
    } finally {
      this.switching = false;
      this.c.changed();
    }
  }

  /** "אשר עסקאות ממתינות". */
  async authorizePending(): Promise<string> {
    if (this.switching) return TX_TEXT.switching;
    this.switching = true;
    this.c.changed();
    try {
      const a = await this.c.svc.pay.authorizePending();
      if (a === 'busy') return (this.message = TX_TEXT.busy);
      if (a?.ok) this.authorized();
      if (a) this.reportAuthorization(a);
      return (this.message = authorizationText(a, (x) => formatShekelSign(x)));
    } finally {
      this.switching = false;
      this.c.changed();
      void this.readOffline(true).catch(() => undefined);
    }
  }

  private authorized() {
    this.c.svc.kv.setNumber(OWN_PENDING_KEY, 0);
  }

  /** `POST /sync/{m}/offline-authorizations` — what the approval run came to (best effort, as Android queues it). */
  private reportAuthorization(a: Authorization) {
    const m = this.c.svc.machineId;
    if (!m || (a.approved.length === 0 && a.declined.length === 0)) return;
    const body = { id: crypto.randomUUID(), authorizedAt: new Date(this.c.now()).toISOString(), statusCode: a.statusCode ?? 0, approved: a.approved, declined: a.declined, totalAmount: a.totalAmountAgorot ?? 0, totalCount: a.totalCount ?? a.approved.length };
    void this.c.svc.api.post(`sync/${m}/offline-authorizations`, body, { timeoutMs: 15_000 }).catch(() => undefined);
  }

  private recordEvent(type: string, authorization: Authorization | null) {
    try {
      const op = this.c.operator();
      this.c.svc.recordEngineEvent?.({
        id: crypto.randomUUID(),
        type,
        occurredAt: new Date(this.c.now()).toISOString(),
        shiftId: this.c.svc.ledger.currentShift()?.id ?? null,
        posUserId: op?.id ?? null,
        details: {
          source: 'till',
          trigger: 'manual',
          by: op ? [op.firstName, op.lastName].filter(Boolean).join(' ') || op.username : null,
          kind: this.c.svc.pay.describe().kind,
          pending: this.pendingOffline(),
          ...(authorization ? { approved: authorization.approved.length, declined: authorization.declined.length, authorizationOk: authorization.ok } : {}),
        },
      });
    } catch (e) {
      this.c.log(`terminal: deferred event — ${String(e)}`);
    }
  }

  /* ------------------------------------------------------------------ the transmission */

  /** "שדר עסקאות עכשיו", approved by the engine. */
  async transmitNow(): Promise<string> {
    if (this.running) return TX_TEXT.running;
    this.running = true;
    this.c.changed();
    try {
      const t = await this.c.svc.transmitNow('manual');
      return (this.message = transmitResultMessage(t ? { outcome: t.outcome, batchNumber: t.batchNumber, statusCode: t.statusCode, statusMessage: t.statusMessage, error: t.error } : null));
    } finally {
      this.running = false;
      this.c.changed();
      void this.reload().catch(() => undefined);
    }
  }

  /** The screen opened: the terminal read, the batch, the history's first page. */
  async open(): Promise<void> {
    this.message = null;
    await Promise.all([
      this.c.svc.pay.deferredSupported ? this.readOffline(true) : Promise.resolve(),
      this.c.svc.pay
        .batchReport(true)
        .then((b) => {
          this.batch = b;
        })
        .catch(() => undefined),
      this.reload(),
    ]);
  }

  /** The history from its first page (the cloud's, with this till's rows not sent yet). */
  async reload(): Promise<void> {
    this.offset = 0;
    this.cloudRows = [];
    await this.page();
  }

  async more(): Promise<void> {
    await this.page();
  }

  private async page(): Promise<void> {
    const m = this.c.svc.machineId;
    if (!m) {
      this.historyError = TX_TEXT.historyNotPaired;
      this.c.changed();
      return;
    }
    this.loading = true;
    this.c.changed();
    try {
      const r = await this.c.svc.api.get<{ total?: number; items?: unknown[] }>(`sync/${m}/transmissions?limit=${PAGE}&offset=${this.offset}`, { timeoutMs: 15_000 });
      if (r.kind === 'ok') {
        const rows = (Array.isArray(r.body?.items) ? r.body.items : []).map(rowOf).filter((x): x is TransmissionRow => x !== null);
        this.cloudRows = this.offset === 0 ? rows : [...this.cloudRows, ...rows];
        this.total = typeof r.body?.total === 'number' ? r.body.total : null;
        this.offset += rows.length;
        this.historyError = null;
      } else if (this.offset === 0) {
        this.historyError = r.kind === 'offline' ? TX_TEXT.historyOffline : TX_TEXT.historyServer;
      } else {
        this.historyError = TX_TEXT.historyOffline;
      }
    } finally {
      this.loading = false;
      this.c.changed();
    }
  }

  /* ------------------------------------------------------------------ what the screens show */

  /** The §13 notices now: the cashier's on the payment screen, the customer's on the display. */
  notices(): { cashier: string | null; customer: string | null } {
    return deferredCardNotices(this.offlineOn(), this.c.svc.cloud.parameters());
  }

  /** The sell screen's banner (deferred, or sales waiting for the card company). */
  banner(): { text: string; tone: 'amber' } | null {
    if (!this.c.svc.pay.deferredSupported) return null;
    return offlineBanner({ on: this.offlineOn(), pending: this.pendingOffline(), online: !this.c.svc.isOffline });
  }

  view(): TransmissionView {
    const svc = this.c.svc;
    const kept = this.kept();
    const local = svc.localTransmissions().map((r) => ({ ...r, unsynced: !r.synced }));
    const rows = mergeHistory(local, this.cloudRows);
    const lastOk = rows.find((r) => r.status === 'success');
    const lastAt = lastOk ? Date.parse(lastOk.finishedAt ?? lastOk.startedAt ?? '') : NaN;
    const lastSuccessAtMs = Number.isFinite(lastAt) ? lastAt : null;
    const last = rows[0] ?? null;
    const now = this.c.now();
    const pending = this.batch?.count ?? 0;
    const offline = kept
      ? {
          stateLine: !kept.allowed ? TX_TEXT.notAllowed : kept.working ? TX_TEXT.stateOn : TX_TEXT.stateOff,
          limitsLine:
            [
              kept.amountLimit !== null && kept.amountLeft !== null ? TX_TEXT.limitAmount(formatShekelSign(kept.amountLeft), formatShekelSign(kept.amountLimit)) : null,
              kept.txLimit !== null && kept.txLeft !== null ? TX_TEXT.limitTx(kept.txLeft, kept.txLimit) : null,
            ]
              .filter(Boolean)
              .join(' · ') || TX_TEXT.noLimits,
        }
      : { stateLine: null, limitsLine: null };
    void ageText;
    return {
      supported: svc.pay.canTransmit,
      deferredSupported: svc.pay.deferredSupported,
      offline: { reading: this.reading, failed: this.readFailed, status: kept, ...offline, switching: this.switching },
      pendingLine: pendingLine({ running: this.running, pending, amountText: formatShekelSign(this.batch?.amountAgorot ?? 0), lastSuccessAtMs, now, full: true }),
      neverTransmitted: lastSuccessAtMs === null,
      lastFailed: last && last.status === 'failed' ? (last.error ?? last.statusMessage ?? '—') : null,
      running: this.running,
      message: this.message,
      history: {
        rows: rows.map((r) => ({ id: r.id, at: r.startedAt ?? r.finishedAt, ...rowWords(r), unsynced: r.unsynced === true })),
        total: this.total,
        error: this.historyError,
        loading: this.loading,
        more: this.total !== null && this.cloudRows.length < this.total,
      },
    };
  }
}
