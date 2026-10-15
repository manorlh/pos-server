/**
 * One cash station ("עמדת מזומן", P:/specs/cash-paylink.md §12): one PayLink unit (the real one
 * through main/cash/paylinkDevice.ts, or the simulator), with its own lease queue, journal rows,
 * change ledger, alerts, lamps and drawer. The cash host (main/cash/host.ts) runs one per unit.
 *
 * The money rules live in core/cash/*; this is the loop that applies them to the device:
 *
 *  - `tick()` (every ~150 ms) reads the device (counters, blocks, events), keeps the ledger and the
 *    alerts, expires leases, and moves the open transaction along its states (core/cash/tx.ts);
 *  - every device command that can move money is journaled first, with the counters read just
 *    before it (journal.logCommand), and the transaction row is saved before the device is touched;
 *  - after a power cut / crash / unit reset an open transaction is never continued: it becomes
 *    HELD with what the counters say the customer is owed (§4) — staff settle it;
 *  - the CheckOperation watchdog (`watchdogTick`, every 500 ms from the host's own loop): if this
 *    process stops, PayLink stops taking money by itself.
 */

import { acceptanceCommand, acceptanceFor, closedCommand, deviceDenominations, escrowDecision, exactOnlyNow, type Acceptance } from '../../core/cash/acceptance';
import { applyEvent, blocking, stationAlerts, switchStates, type StationAlert } from '../../core/cash/alerts';
import { payoutStrategy, type Inventory } from '../../core/cash/change';
import type { CashDevice, DeviceCommand, DeviceEvent, DeviceSnapshot, DispenserSnap } from '../../core/cash/device';
import { CASH_API, LEASE_RENEW_MS, LEASE_TTL_MS, type CashEvent, type LeaseView, type StationState as StationStateName, type StationStatus } from '../../core/cash/lanProtocol';
import {
  acceptorKey,
  addToUnit,
  cashboxBaseOf,
  dispenserKey,
  dumpedToCashbox,
  emptyCashbox,
  ledgerView,
  setUnitCount,
  type LedgerView,
} from '../../core/cash/ledger';
import {
  canFullDump,
  canPartialDump,
  canUpdateDeviceCount,
  DISPENSER_CASHBOX_DUMP,
  DISPENSER_COUNT_UPDATED,
  DISPENSER_DUMP_FINISHED,
  DISPENSER_PARTIAL_DUMP,
  DISPENSER_UPDATE_COUNT,
  EXT_ESCROW_ACCEPT,
  EXT_ESCROW_NONE,
  EXT_ESCROW_OFF,
  EXT_ESCROW_PAUSE,
  EXT_ESCROW_PAUSED,
  EXT_ESCROW_POWER_ACTIVE,
  EXT_ESCROW_RETURN,
  EXT_ESCROW_RETURNED_OK,
  EXT_ESCROW_RETURNING_PROBLEM,
  EXT_ESCROW_STACK,
  EXT_ESCROW_STACKED_OK,
  EXT_ESCROW_STACKING_PROBLEM,
  EXT_ESCROW_START,
  EXT_ESCROW_STORED,
  hasPrecisePay,
  holdsChange,
  OPEN_RETRY_MS,
  PAY_ONGOING,
  WATCHDOG_TIMEOUT_MS,
  firmwareText,
} from '../../core/cash/paylinkApi';
import { cashDue } from '../../core/cash/change';
import { shekelText, type CashSettings } from '../../core/cash/settings';
import { isOpen, OWED_CHOICES, piecesBetween, slipCodeOf, txView, type CancelReason, type CashTx, type Counters, type HeldReason, type OwedChoice, type Piece, type TxView } from '../../core/cash/tx';
import type { CashJournal, CashMove, MoveKind, StationState } from './journal';

export interface StationConfig {
  stationId: string;
  name: string;
  location: string | null;
  /** The USB serial (OpenSpecificMHE); '' = the default unit. */
  serial: string;
  settings: CashSettings;
  clients: Array<{ machineId: string; name: string; kind: string }>;
}

export interface StationDeps {
  hostId(): string | null;
  device: CashDevice;
  journal: CashJournal;
  now(): number;
  newId(): string;
  log(m: string): void;
  /** The vendor's driver and DLL were found (the supervisor's word; always true for the simulator). */
  driverInstalled(): boolean;
}

interface Lease {
  leaseId: string;
  clientId: string;
  createdAt: number;
  renewedAt: number;
  txId: string | null;
  /** Gone after this long unrenewed, renewed this often: the LAN's 6 / 2 s, a lease through the cloud 20 / 5 s (§14.4). */
  ttlMs: number;
  renewMs: number;
}

/** How a lease is kept: the way its last call came (§14.4 — the cloud relay is slower than the LAN). */
export interface LeaseTiming {
  ttlMs: number;
  renewMs: number;
}

export const LAN_LEASE: LeaseTiming = { ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS };

export type Reply = { status: number; body: unknown };

const MESSAGES = {
  insert: 'הכניסו כסף במכשיר המזומן',
  exact: 'סכום מדויק בלבד',
  settling: 'רגע…',
  change: 'מחזיר עודף…',
  refunding: 'מחזיר את הכסף…',
  done: 'תודה!',
  refunded: 'הכסף הוחזר',
  nothing: 'לא הוכנס כסף',
  held: 'תקלה — פנה לצוות',
  gone: 'הקיוסק לא מגיב — הכסף יוחזר בעוד רגע',
  partial: 'השלימו את התשלום באשראי',
} as const;

/** How long a payout may report "ongoing" without progress before we look again (bills: settings.payoutTimeoutSec). */
const PAYOUT_MIN_MS = 800;
const EXT_ESCROW_WAIT_MS = 30_000;
const OPEN_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function err(status: number, error: string, extra: Record<string, unknown> = {}): Reply {
  return { status, body: { error, ...extra } };
}

export function countersOf(s: DeviceSnapshot): Counters {
  const coins: Counters['coins'] = {};
  for (const a of s.acceptors) for (const c of a.coins) coins[`${acceptorKey(a)}|${c.index}`] = { valueAgorot: c.valueAgorot, kind: a.kind, count: c.count };
  const dispensers: Counters['dispensers'] = {};
  for (const d of s.dispensers) if (holdsChange(d.cls)) dispensers[dispenserKey(d)] = { valueAgorot: d.valueAgorot, count: d.count };
  return { at: s.at, currentValueAgorot: s.currentValueAgorot, currentPaidAgorot: s.currentPaidAgorot, coins, dispensers, escrowThroughputAgorot: s.escrowThroughputAgorot };
}

export class CashStation {
  private snap: DeviceSnapshot | null = null;
  private view: LedgerView | null = null;
  private leases: Lease[] = [];
  private st: StationState;
  private alertList: StationAlert[] = [];
  private firstSeen = new Map<string, number>();
  private opened = false;
  private openFailures = 0;
  private nextOpenAt = 0;
  private openError: string | null = null;
  private openCode: number | null = null;
  private recovered = false;
  private ticking = false;
  private maintenance: { by: string | null; since: number } | null = null;
  private lastAcceptance = '';
  private lampState = new Map<number, boolean>();
  private listeners = new Set<(e: CashEvent, clientId: string | null) => void>();
  private lastStatusJson = '';
  private stateDirty = false;
  private extEscrowUnit: number | null = null;
  private escrowEnabled = false;
  /** Events read while opening (the first read), handled by the next tick. */
  private pendingEvents: DeviceEvent[] = [];
  private pendingDumps: Array<{ key: string; kind: 'note' | 'coin'; valueAgorot: number; before: number; at: number; moveId: string }> = [];

  constructor(
    public cfg: StationConfig,
    private readonly d: StationDeps,
  ) {
    this.st = d.journal.stationState(cfg.stationId);
  }

  get id(): string {
    return this.cfg.stationId;
  }

  get settings(): CashSettings {
    return this.cfg.settings;
  }

  /** New settings / clients from the cloud (the device stays open). */
  configure(cfg: StationConfig) {
    this.cfg = cfg;
    this.lastAcceptance = '';
  }

  onEvent(fn: (e: CashEvent, clientId: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: CashEvent, clientId: string | null) {
    for (const fn of this.listeners) fn(e, clientId);
  }

  /* ================================================================== the loop */

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.d.now();
      if (!this.opened) {
        if (now < this.nextOpenAt) return void this.afterTick(now);
        await this.tryOpen(now);
        if (!this.opened) return void this.afterTick(now);
      }
      let events: DeviceEvent[] = this.pendingEvents;
      this.pendingEvents = [];
      try {
        const r = await this.d.device.read();
        this.snap = r.snapshot;
        events = [...events, ...r.events];
      } catch (e) {
        this.lostDevice(`read: ${e instanceof Error ? e.message : String(e)}`);
        return void this.afterTick(now);
      }
      // Events first: a read that finds the unit gone still carries what it said before (bills pending…).
      for (const e of events) {
        this.st.latched = applyEvent(this.st.latched, e);
        if (e.code === (0x080 | 15)) this.st.billsPending = true; // IMHEI_NOTE_DISPENSER_PENDING
        this.stateDirty = true;
      }
      if (!this.snap.open) {
        this.lostDevice('the unit closed');
        return void this.afterTick(now);
      }
      if (!this.recovered) await this.recover(now);
      this.view = ledgerView(this.snap, this.st.ledger, this.cfg.settings);
      this.checkDumps(now);
      this.expireLeases(now);
      const active = this.activeTx();
      if (active) await this.drive(active, now);
      else await this.idle(now);
      this.holdUnacked(now);
      this.afterTick(now);
      await this.lamps();
    } catch (e) {
      this.d.log(`[cash ${this.cfg.name}] tick: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  private afterTick(now: number) {
    this.alertList = stationAlerts({
      now,
      driverInstalled: this.d.driverInstalled(),
      snapshot: this.opened ? this.snap : null,
      ledger: this.view,
      latched: [...this.st.latched, ...(this.st.billsPending || this.st.extEscrowPending ? [{ code: 'bills_pending' as const, unit: 'station', since: now, detail: null }] : [])],
      settings: this.cfg.settings,
      firstSeen: this.firstSeen,
      unackedCount: this.d.journal.unacked(this.id).filter((t) => t.state === 'DONE' && t.outcome === 'paid' && now - (t.doneAt ?? t.updatedAt) > 60_000).length,
      exactOnly: this.view ? exactOnlyNow(this.view.changeAvailableAgorot, this.hasDispensers(), this.cfg.settings.exactChangeBelowAgorot) : false,
    });
    if (this.stateDirty) {
      this.d.journal.saveStationState(this.id, this.st, now);
      this.stateDirty = false;
    }
    const status = this.status(null);
    const json = JSON.stringify({ ...status, time: 0 });
    if (json !== this.lastStatusJson) {
      this.lastStatusJson = json;
      this.emit({ type: 'status', status }, null);
    }
  }

  private async tryOpen(now: number) {
    const r = await this.d.device.open().catch((e: unknown) => ({ ok: false as const, code: null, message: e instanceof Error ? e.message : String(e), retry: true }));
    if (r.ok) {
      this.opened = true;
      this.openFailures = 0;
      this.openError = null;
      this.openCode = null;
      this.lastAcceptance = '';
      this.escrowEnabled = false;
      this.d.log(`[cash ${this.cfg.name}] open`);
      // Everything closed to money until a transaction opens it.
      const first = await this.d.device.read().catch(() => null);
      if (first) {
        this.snap = first.snapshot;
        this.pendingEvents.push(...first.events);
        await this.send(closedCommand(first.snapshot.acceptors), null);
        await this.setupEscrow(first.snapshot, now);
      }
      return;
    }
    this.openFailures++;
    this.openError = r.message;
    this.openCode = r.code;
    this.nextOpenAt = now + OPEN_BACKOFF_MS[Math.min(OPEN_BACKOFF_MS.length - 1, this.openFailures - 1)];
    if (this.openFailures === 1 || this.openFailures % 10 === 0) this.d.log(`[cash ${this.cfg.name}] open failed (${r.code ?? '-'}): ${r.message}`);
  }

  /** The device went away (USB, power, the driver): an open transaction is held at the next open. */
  private lostDevice(why: string) {
    if (this.opened) this.d.log(`[cash ${this.cfg.name}] device lost: ${why}`);
    this.opened = false;
    this.recovered = false;
    this.nextOpenAt = this.d.now() + OPEN_RETRY_MS / 5;
  }

  /** Single-note escrow on (notes wait for our word); a recycler's extended escrow started when used. */
  private async setupEscrow(s: DeviceSnapshot, now: number) {
    const block = s.escrows[0];
    this.extEscrowUnit = null;
    if (this.cfg.settings.extendedEscrow && block && block.state !== EXT_ESCROW_NONE) {
      this.extEscrowUnit = block.index;
      if (block.state === EXT_ESCROW_OFF || block.state === EXT_ESCROW_POWER_ACTIVE) {
        await this.send({ op: 'ext_escrow', unit: block.index, command: EXT_ESCROW_START }, null);
      }
      const after = (await this.d.device.read().catch(() => null))?.snapshot.escrows[0];
      // Notes from before a power cut: never stacked or returned without staff (§4).
      if (after && (after.state === EXT_ESCROW_POWER_ACTIVE || after.state === EXT_ESCROW_RETURNING_PROBLEM || (after.notes.length > 0 && after.totalValueAgorot > 0))) {
        this.st.extEscrowPending = true;
        this.stateDirty = true;
        this.d.log(`[cash ${this.cfg.name}] extended escrow holds ${after.totalValueAgorot} from before — waiting for staff`);
      }
    }
    if (s.acceptors.some((a) => a.kind === 'note')) {
      await this.send({ op: 'escrow', action: 'enable' }, null);
      this.escrowEnabled = true;
    }
    void now;
  }

  /**
   * After an open: any transaction that was open when the device / process went away is HELD with
   * what the counters say — never continued, never paid automatically (§4).
   */
  private async recover(now: number) {
    this.recovered = true;
    const s = this.snap!;
    if (!this.st.ledger.cashbox) {
      this.st.ledger = { ...this.st.ledger, cashbox: cashboxBaseOf(s, this.cfg.settings, now) };
      this.stateDirty = true;
    }
    for (const t of this.d.journal.openTxs(this.id)) {
      const inserted = s.currentValueAgorot - t.start.currentValueAgorot;
      const paid = s.currentPaidAgorot - t.start.currentPaidAgorot;
      let reason: HeldReason = 'power_loss';
      let net = inserted - paid;
      if (inserted < 0 || paid < 0) {
        // The counters went back: another unit, or a reset that lost them — the last known word.
        reason = 'consistency';
        net = Math.max(0, t.insertedAgorot - t.changePaidAgorot - t.refundPaidAgorot);
      }
      const nowCounters = countersOf(s);
      t.insertedAgorot = Math.max(0, inserted);
      t.inserted = piecesBetween(t.start, nowCounters, 'in');
      t.paidOut = piecesBetween(t.start, nowCounters, 'out');
      if (net > 0 || reason === 'consistency') {
        this.hold(t, reason, Math.max(0, net), now);
      } else {
        t.state = 'DONE';
        t.outcome = inserted > 0 ? 'refunded' : 'nothing_inserted';
        t.refundDueAgorot = Math.max(0, inserted);
        t.refundPaidAgorot = Math.max(0, paid);
        t.message = inserted > 0 ? MESSAGES.refunded : MESSAGES.nothing;
        t.doneAt = now;
        this.save(t, now);
      }
      this.d.log(`[cash ${this.cfg.name}] recovered ${t.txId}: ${t.state} (inserted ${inserted}, paid ${paid})`);
    }
  }

  /* ================================================================== leases */

  private activeTx(): CashTx | null {
    const open = this.d.journal.openTxs(this.id);
    return open[0] ?? null;
  }

  /** The queue: leases whose transaction is not final, in order. */
  private queue(): Lease[] {
    return this.leases.filter((l) => {
      if (!l.txId) return true;
      const t = this.d.journal.tx(l.txId);
      return !t || isOpen(t.state);
    });
  }

  private holder(): Lease | null {
    return this.queue()[0] ?? null;
  }

  private leaseView(l: Lease): LeaseView {
    const q = this.queue();
    const pos = q.indexOf(l);
    const position = pos < 0 ? 0 : pos;
    return {
      leaseId: l.leaseId,
      state: position === 0 ? 'granted' : 'queued',
      position,
      renewMs: l.renewMs,
      expiresAt: l.renewedAt + l.ttlMs,
      estimatedWaitSec: position === 0 ? 0 : position * 60,
    };
  }

  private expireLeases(now: number) {
    for (const l of [...this.leases]) {
      if (now - l.renewedAt <= l.ttlMs) continue;
      const t = l.txId ? this.d.journal.tx(l.txId) : null;
      if (t && isOpen(t.state)) {
        // The client vanished mid-transaction: acceptance closes now, refund after the grace (§4).
        if (t.graceUntil === null && (t.state === 'LEASED' || t.state === 'ACCEPTING' || t.state === 'PARTIAL')) {
          t.graceUntil = now + this.cfg.settings.refundGraceSec * 1000;
          t.message = MESSAGES.gone;
          this.save(t, now);
          this.d.log(`[cash ${this.cfg.name}] client ${l.clientId} stopped renewing during ${t.txId}`);
        }
        continue;
      }
      this.leases = this.leases.filter((x) => x !== l);
      if (t) this.notifyLease(l, now);
    }
  }

  private notifyLease(_l: Lease, _now: number) {
    for (const q of this.queue()) this.emit({ type: 'lease', lease: this.leaseView(q) }, q.clientId);
  }

  isClient(clientId: string): boolean {
    return this.cfg.clients.some((c) => c.machineId === clientId);
  }

  /** A lease renewed (its timing: the way this call came); a client back in its grace — its transaction goes on. */
  private renew(l: Lease, now: number, timing: LeaseTiming) {
    l.renewedAt = now;
    l.ttlMs = timing.ttlMs;
    l.renewMs = timing.renewMs;
    const t = l.txId ? this.d.journal.tx(l.txId) : null;
    if (t && t.graceUntil !== null && isOpen(t.state)) {
      // Back in time: the transaction goes on.
      t.graceUntil = null;
      t.closedForGrace = false;
      t.message = t.state === 'PARTIAL' ? MESSAGES.partial : MESSAGES.insert;
      this.lastAcceptance = '';
      this.save(t, now);
    }
  }

  /**
   * §14.4: any call of a client through the cloud renews its lease here — its own `GET tx` every second or so keeps
   * it, no extra lease calls through the relay. No lease — nothing.
   */
  touchLease(clientId: string, timing: LeaseTiming): void {
    const l = this.leases.find((x) => x.clientId === clientId);
    if (l) this.renew(l, this.d.now(), timing);
  }

  lease(clientId: string, body: { leaseId?: unknown; txId?: unknown }, timing: LeaseTiming = LAN_LEASE): Reply {
    const now = this.d.now();
    const existing = typeof body.leaseId === 'string' && body.leaseId ? this.leases.find((l) => l.leaseId === body.leaseId) : this.leases.find((l) => l.clientId === clientId);
    if (typeof body.leaseId === 'string' && body.leaseId && (!existing || existing.clientId !== clientId)) return err(404, 'unknown_lease', { message: 'הנעילה פגה — מצטרפים שוב לתור' });
    if (existing) {
      this.renew(existing, now, timing);
      return { status: 200, body: this.leaseView(existing) };
    }
    const status = this.status(clientId);
    if (!status.ready) return err(409, 'not_ready', { message: status.reason ?? 'מכשיר המזומן אינו זמין' });
    const l: Lease = { leaseId: this.d.newId(), clientId, createdAt: now, renewedAt: now, txId: null, ttlMs: timing.ttlMs, renewMs: timing.renewMs };
    this.leases.push(l);
    this.d.log(`[cash ${this.cfg.name}] lease ${l.leaseId} for ${clientId} (position ${this.queue().indexOf(l)})`);
    return { status: 200, body: this.leaseView(l) };
  }

  release(clientId: string, leaseId: string): Reply {
    const l = this.leases.find((x) => x.leaseId === leaseId && x.clientId === clientId);
    if (!l) return { status: 204, body: null };
    const t = l.txId ? this.d.journal.tx(l.txId) : null;
    if (t && isOpen(t.state)) return err(409, 'tx_active', { txId: t.txId });
    this.leases = this.leases.filter((x) => x !== l);
    this.notifyLease(l, this.d.now());
    return { status: 204, body: null };
  }

  /* ================================================================== transactions */

  startTx(clientId: string, txId: string, body: { leaseId?: unknown; amountAgorot?: unknown; orderRef?: unknown; orderLabel?: unknown }): Reply {
    const now = this.d.now();
    const amount = typeof body.amountAgorot === 'number' && Number.isInteger(body.amountAgorot) ? body.amountAgorot : NaN;
    const known = this.d.journal.tx(txId);
    if (known) {
      if (known.clientId !== clientId || known.stationId !== this.id || (Number.isFinite(amount) && amount !== known.amountAgorot) || (typeof body.leaseId === 'string' && body.leaseId !== known.leaseId)) {
        return err(409, 'tx_conflict', { message: 'מזהה העסקה כבר בשימוש' });
      }
      return { status: 200, body: txView(known) };
    }
    if (!Number.isFinite(amount) || amount < 1 || amount > 10_000_000) return err(400, 'amount', { message: 'סכום לא תקין' });
    const l = this.leases.find((x) => x.leaseId === body.leaseId && x.clientId === clientId);
    if (!l) return err(404, 'unknown_lease', { message: 'אין נעילה פעילה' });
    l.renewedAt = now;
    const q = this.queue();
    if (q[0] !== l) return err(409, 'not_holder', { position: Math.max(0, q.indexOf(l)) });
    if (l.txId) {
      const prev = this.d.journal.tx(l.txId);
      if (prev && isOpen(prev.state)) return err(409, 'tx_active', { txId: prev.txId });
    }
    const status = this.status(clientId);
    if (status.state === 'fault' || status.state === 'maintenance' || status.state === 'starting') return err(409, 'not_ready', { message: status.reason ?? 'מכשיר המזומן אינו זמין' });
    if (!this.snap) return err(409, 'not_ready', { message: 'מכשיר המזומן עולה' });
    const due = cashDue(amount, this.cfg.settings.rounding);
    const client = this.cfg.clients.find((c) => c.machineId === clientId);
    const t: CashTx = {
      txId,
      stationId: this.id,
      hostId: this.d.hostId() ?? '',
      clientId,
      clientName: client?.name ?? null,
      leaseId: l.leaseId,
      kind: 'sale',
      orderRef: typeof body.orderRef === 'string' ? body.orderRef.slice(0, 80) : null,
      orderLabel: typeof body.orderLabel === 'string' ? body.orderLabel.slice(0, 40) : null,
      amountAgorot: amount,
      dueAgorot: due.dueAgorot,
      roundingAgorot: due.roundingAgorot,
      state: 'LEASED',
      outcome: null,
      start: countersOf(this.snap),
      insertedAgorot: 0,
      inserted: [],
      escrowAgorot: 0,
      changeDueAgorot: 0,
      changePaidAgorot: 0,
      changeOwedAgorot: 0,
      changeOwedAsk: false,
      changeOwedAs: null,
      splitAsked: false,
      splitAgorot: 0,
      partialSince: null,
      refundDueAgorot: 0,
      refundPaidAgorot: 0,
      heldAgorot: 0,
      heldReason: null,
      paidOut: [],
      cancelReason: null,
      accepting: { coins: [], notes: [] },
      exactOnly: false,
      payout: null,
      extEscrow: null,
      step: null,
      escrowSeen: this.snap.escrowThroughputAgorot ?? 0,
      closedForGrace: false,
      error: null,
      message: MESSAGES.insert,
      owedId: null,
      slipCode: null,
      acked: false,
      documentId: null,
      documentNumber: null,
      createdAt: now,
      updatedAt: now,
      deadlineAt: now + this.cfg.settings.insertTimeoutSec * 1000,
      idleDeadlineAt: now + this.cfg.settings.idleTimeoutSec * 1000,
      lastInsertAt: null,
      settleUntil: null,
      graceUntil: null,
      doneAt: null,
      seq: 1,
      uploadedSeq: 0,
    };
    // The journal first: nothing touches the device before this row is on the disk.
    this.d.journal.saveTx(t);
    l.txId = txId;
    this.d.log(`[cash ${this.cfg.name}] tx ${txId} start: ${amount} (due ${due.dueAgorot}) for ${clientId}`);
    return { status: 200, body: txView(t) };
  }

  getTx(clientId: string, txId: string): Reply {
    const t = this.d.journal.tx(txId);
    if (!t || t.stationId !== this.id || t.clientId !== clientId) return err(404, 'unknown_tx');
    return { status: 200, body: txView(t) };
  }

  cancelTx(clientId: string, txId: string, reason: unknown): Reply {
    const t = this.d.journal.tx(txId);
    if (!t || t.stationId !== this.id || t.clientId !== clientId) return err(404, 'unknown_tx');
    const now = this.d.now();
    if (t.state === 'LEASED' || t.state === 'ACCEPTING' || t.state === 'PARTIAL') {
      this.beginRefund(t, reason === 'timeout' ? 'timeout' : reason === 'kiosk' ? 'kiosk' : 'customer', now);
      return { status: 200, body: txView(t) };
    }
    if (t.state === 'REFUNDING' || t.state === 'HELD' || (t.state === 'DONE' && t.outcome !== 'paid')) return { status: 200, body: txView(t) };
    return err(409, 'too_late', { message: 'הסכום כבר שולם', tx: txView(t) });
  }

  ackTx(clientId: string, txId: string, body: { documentId?: unknown; documentNumber?: unknown; orderLabel?: unknown; changeOwedAs?: unknown; void?: unknown }): Reply {
    const t = this.d.journal.tx(txId);
    if (!t || t.stationId !== this.id || t.clientId !== clientId) return err(404, 'unknown_tx');
    if (t.state !== 'DONE' && t.state !== 'HELD') return err(409, 'not_final', { tx: txView(t) });
    const now = this.d.now();
    // §11.15א: the customer's choice for the change owed — kept once; without `ask` always a slip.
    if (t.state === 'DONE' && t.outcome === 'paid' && t.changeOwedAgorot > 0 && !t.changeOwedAs) {
      const chosen = typeof body.changeOwedAs === 'string' && (OWED_CHOICES as readonly string[]).includes(body.changeOwedAs) ? (body.changeOwedAs as OwedChoice) : 'slip';
      t.changeOwedAs = t.changeOwedAsk ? chosen : 'slip';
      t.message = t.changeOwedAs === 'tip' ? MESSAGES.done : t.message;
      t.acked = false; // saved below with the rest of the acknowledgement
    }
    // §11.15ב: the split sale's document was voided (the card was not charged) — the cash part is the customer's: held.
    if (body.void === true && t.state === 'DONE' && t.outcome === 'paid' && (t.splitAgorot ?? 0) > 0) {
      t.acked = true;
      t.error = { code: 'split_void', message: 'האשראי לא חויב — המזומן שהוכנס מוחזק ללקוח' };
      this.hold(t, 'split_void', t.splitAgorot, now);
      this.leases = this.leases.filter((l) => l.txId !== txId);
      for (const q of this.queue()) this.emit({ type: 'lease', lease: this.leaseView(q) }, q.clientId);
      return { status: 200, body: txView(t) };
    }
    if (!t.acked || (typeof body.documentId === 'string' && t.documentId !== body.documentId)) {
      t.acked = true;
      if (typeof body.documentId === 'string') t.documentId = body.documentId.slice(0, 80);
      if (typeof body.documentNumber === 'string') t.documentNumber = body.documentNumber.slice(0, 40);
      // The order's number is known only once the document is written ("עודף חייב — הזמנה 57" at the tills).
      if (typeof body.orderLabel === 'string' && !t.orderLabel) t.orderLabel = body.orderLabel.slice(0, 40);
      this.save(t, now);
    }
    this.leases = this.leases.filter((l) => l.txId !== txId);
    for (const q of this.queue()) this.emit({ type: 'lease', lease: this.leaseView(q) }, q.clientId);
    return { status: 200, body: txView(t) };
  }

  /**
   * "להשלים באשראי" (§11.15ב): only while accepting with something in and something left — closed to money, settled
   * (a coin in the air, the escrowed notes stacked), then PARTIAL unless the amount was completed meanwhile.
   */
  splitTx(clientId: string, txId: string): Reply {
    const t = this.d.journal.tx(txId);
    if (!t || t.stationId !== this.id || t.clientId !== clientId) return err(404, 'unknown_tx');
    if (t.splitAsked || t.state === 'PARTIAL') return { status: 200, body: txView(t) };
    if (t.state !== 'ACCEPTING') return err(409, 'not_accepting', { message: 'אי אפשר לפצל כעת', tx: txView(t) });
    if (t.insertedAgorot <= 0) return err(409, 'nothing_inserted', { message: 'עוד לא הוכנס כסף' });
    if (t.insertedAgorot >= t.dueAgorot) return err(409, 'not_accepting', { message: 'הסכום כבר הושלם', tx: txView(t) });
    const now = this.d.now();
    t.splitAsked = true;
    t.state = 'SETTLING';
    t.step = 'closing';
    t.settleUntil = now + this.cfg.settings.settleMs;
    t.message = MESSAGES.settling;
    this.lastAcceptance = '';
    this.save(t, now);
    this.d.log(`[cash ${this.cfg.name}] tx ${txId}: split asked at ${t.insertedAgorot} of ${t.dueAgorot}`);
    return { status: 200, body: txView(t) };
  }

  /** The card paid the rest (§11.15ב): the cash part is paid — DONE, no change. Repeats harmlessly. */
  finishTx(clientId: string, txId: string): Reply {
    const t = this.d.journal.tx(txId);
    if (!t || t.stationId !== this.id || t.clientId !== clientId) return err(404, 'unknown_tx');
    if (t.state === 'DONE' && t.outcome === 'paid' && (t.splitAgorot ?? 0) > 0) return { status: 200, body: txView(t) };
    if (t.state !== 'PARTIAL') return err(409, 'not_partial', { message: 'העסקה אינה ממתינה לאשראי', tx: txView(t) });
    const now = this.d.now();
    t.changeDueAgorot = 0;
    this.finishPaid(t, now);
    this.save(t, now);
    this.d.log(`[cash ${this.cfg.name}] tx ${txId}: split finished, cash ${t.splitAgorot}`);
    return { status: 200, body: txView(t) };
  }

  /** Every change of a transaction: a new seq, the journal, the client told. */
  private save(t: CashTx, now: number) {
    t.updatedAt = now;
    t.seq += 1;
    this.d.journal.saveTx(t);
    this.emit({ type: 'tx', tx: txView(t) }, t.clientId);
  }

  private hold(t: CashTx, reason: HeldReason, held: number, now: number) {
    t.state = 'HELD';
    t.heldReason = reason;
    t.heldAgorot = held;
    t.payout = null;
    t.step = null;
    t.doneAt = now;
    t.slipCode = slipCodeOf(t.txId);
    t.owedId = t.txId;
    t.message = MESSAGES.held;
    t.error = t.error ?? { code: reason === 'consistency' ? 'consistency' : 'device', message: 'זיכוי מוחזק — יש לפנות לצוות' };
    this.save(t, now);
    this.d.log(`[cash ${this.cfg.name}] tx ${t.txId} HELD (${reason}): ${held}`);
  }

  /* ================================================================== driving a transaction */

  private hasDispensers(): boolean {
    return !!this.snap?.dispensers.some((d) => holdsChange(d.cls) && d.valueAgorot > 0 && d.valueAgorot < 999_999_999);
  }

  private precisePay(): boolean {
    return hasPrecisePay(this.snap?.firmware ?? null);
  }

  private inventory(): Inventory {
    return this.view?.inventory ?? new Map();
  }

  private acceptance(remaining: number): Acceptance {
    const s = this.snap!;
    const dev = deviceDenominations(s.acceptors);
    return acceptanceFor({
      remainingAgorot: remaining,
      inventory: this.inventory(),
      changeAvailableAgorot: this.view?.changeAvailableAgorot ?? 0,
      hasDispensers: this.hasDispensers(),
      precisePay: this.precisePay(),
      settings: this.cfg.settings,
      deviceCoins: dev.coins,
      deviceNotes: dev.notes,
    });
  }

  /** A device command, journaled first with the counters read just before it. */
  private async send(cmd: DeviceCommand, txId: string | null): Promise<boolean> {
    const money = cmd.op !== 'indicator' && cmd.op !== 'watchdog';
    const id = money ? this.d.journal.logCommand(this.id, txId, cmd, this.snap ? countersOf(this.snap) : null, this.d.now()) : null;
    try {
      const r = await this.d.device.command(cmd);
      if (id !== null) this.d.journal.commandResult(id, r);
      if (!r.ok) this.d.log(`[cash ${this.cfg.name}] ${cmd.op} refused: ${r.error}`);
      return r.ok;
    } catch (e) {
      if (id !== null) this.d.journal.commandResult(id, { ok: false, error: String(e) });
      this.d.log(`[cash ${this.cfg.name}] ${cmd.op} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  private extAcceptor(): number[] {
    if (this.extEscrowUnit === null || !this.snap) return [];
    const b = this.snap.escrows.find((e) => e.index === this.extEscrowUnit);
    return b ? [b.acceptorNo] : [];
  }

  private async applyAcceptance(t: CashTx, a: Acceptance | null) {
    const key = JSON.stringify(a);
    if (key === this.lastAcceptance) return;
    const s = this.snap!;
    const ext = this.extAcceptor();
    await this.send(acceptanceCommand(s.acceptors, a, ext), t.txId);
    if (this.extEscrowUnit !== null) {
      const notesOn = !!a && a.notes.length > 0;
      const block = s.escrows.find((e) => e.index === this.extEscrowUnit);
      if (notesOn && block && block.state !== 3 && block.state !== 4) await this.send({ op: 'ext_escrow', unit: this.extEscrowUnit, command: EXT_ESCROW_ACCEPT }, t.txId);
      if (!notesOn && block && (block.state === 3 || block.state === 4)) await this.send({ op: 'ext_escrow', unit: this.extEscrowUnit, command: EXT_ESCROW_PAUSE }, t.txId);
    }
    this.lastAcceptance = key;
    t.accepting = a ? { coins: a.coins, notes: a.notes } : { coins: [], notes: [] };
    t.exactOnly = a?.exactOnly ?? t.exactOnly;
  }

  private refreshMoney(t: CashTx) {
    const s = this.snap!;
    const c = countersOf(s);
    t.insertedAgorot = Math.max(0, s.currentValueAgorot - t.start.currentValueAgorot);
    t.inserted = piecesBetween(t.start, c, 'in');
    t.paidOut = piecesBetween(t.start, c, 'out');
  }

  private paidSince(t: CashTx): number {
    return Math.max(0, this.snap!.currentPaidAgorot - t.start.currentPaidAgorot);
  }

  private async drive(t: CashTx, now: number) {
    const s = this.snap!;
    // Every field (the internal steps too — the next tick reads the row back from the journal).
    const before = JSON.stringify(t);
    switch (t.state) {
      case 'LEASED': {
        // The starting counters again, read just now, before acceptance opens.
        t.start = countersOf(s);
        t.escrowSeen = s.escrowThroughputAgorot ?? 0;
        t.state = 'ACCEPTING';
        t.deadlineAt = now + this.cfg.settings.insertTimeoutSec * 1000;
        t.idleDeadlineAt = now + this.cfg.settings.idleTimeoutSec * 1000;
        if (this.extEscrowUnit !== null) t.extEscrow = { unit: this.extEscrowUnit, heldAgorot: 0 };
        this.lastAcceptance = '';
        this.d.journal.saveTx(t);
        await this.applyAcceptance(t, this.acceptance(t.dueAgorot));
        t.message = t.exactOnly ? `${MESSAGES.insert} · ${MESSAGES.exact}` : MESSAGES.insert;
        break;
      }
      case 'ACCEPTING':
        await this.accepting(t, now);
        break;
      case 'SETTLING':
        await this.settling(t, now);
        break;
      case 'PAYING_CHANGE':
        await this.payingChange(t, now);
        break;
      case 'PARTIAL':
        await this.partial(t, now);
        break;
      case 'REFUNDING':
        await this.refunding(t, now);
        break;
      default:
        break;
    }
    if (JSON.stringify(t) !== before) this.save(t, now);
  }

  private async accepting(t: CashTx, now: number) {
    const s = this.snap!;
    const was = t.insertedAgorot;
    this.refreshMoney(t);
    if (t.insertedAgorot > was) {
      t.lastInsertAt = now;
      t.idleDeadlineAt = now + this.cfg.settings.idleTimeoutSec * 1000;
    }
    const remaining = Math.max(0, t.dueAgorot - t.insertedAgorot);
    // A note in (single-note) escrow: kept or given back by the same rule as the inhibits.
    const et = s.escrowThroughputAgorot;
    if (et !== null) {
      if (et < t.escrowSeen) t.escrowSeen = et; // the acceptor returned it by itself
      if (et > t.escrowSeen) {
        const value = et - t.escrowSeen;
        t.escrowAgorot = value;
        const decision =
          t.closedForGrace || remaining <= 0
            ? 'return'
            : escrowDecision(value, {
                remainingAgorot: remaining,
                inventory: this.inventory(),
                changeAvailableAgorot: this.view?.changeAvailableAgorot ?? 0,
                hasDispensers: this.hasDispensers(),
                precisePay: this.precisePay(),
                settings: this.cfg.settings,
              });
        await this.send({ op: 'escrow', action: decision }, t.txId);
        t.escrowSeen = et;
        t.escrowAgorot = 0;
        if (decision === 'accept') t.lastInsertAt = now;
      }
    }
    if (t.insertedAgorot >= t.dueAgorot) {
      // The amount is in: closed to money, a moment for a coin still in the air.
      await this.applyAcceptance(t, null);
      t.state = 'SETTLING';
      t.step = 'closing';
      t.settleUntil = now + this.cfg.settings.settleMs;
      t.message = MESSAGES.settling;
      return;
    }
    if (t.graceUntil !== null) {
      if (!t.closedForGrace) {
        await this.applyAcceptance(t, null);
        t.closedForGrace = true;
      }
      if (now >= t.graceUntil) this.beginRefund(t, 'client_gone', now);
      return;
    }
    if (now >= t.deadlineAt) return this.beginRefund(t, 'timeout', now);
    if (now >= t.idleDeadlineAt) return this.beginRefund(t, 'idle', now);
    const a = this.acceptance(remaining);
    await this.applyAcceptance(t, a);
    t.message = a.exactOnly ? `${MESSAGES.insert} · ${MESSAGES.exact}` : MESSAGES.insert;
  }

  private beginRefund(t: CashTx, reason: CancelReason, now: number) {
    t.state = 'REFUNDING';
    t.cancelReason = t.cancelReason ?? reason;
    t.step = 'closing';
    t.settleUntil = now + this.cfg.settings.settleMs;
    t.message = MESSAGES.refunding;
    t.payout = null;
    this.save(t, now);
  }

  private async settling(t: CashTx, now: number) {
    const s = this.snap!;
    if (t.step === 'closing') {
      await this.applyAcceptance(t, null);
      if (now < (t.settleUntil ?? now)) return;
      // A note that reached escrow after the amount was in is not wanted: back.
      const et = s.escrowThroughputAgorot;
      if (et !== null && et > t.escrowSeen) {
        await this.send({ op: 'escrow', action: 'return' }, t.txId);
        t.escrowSeen = et;
      }
      this.refreshMoney(t);
      t.step = 'escrow';
      if (t.extEscrow) {
        const b = s.escrows.find((e) => e.index === t.extEscrow!.unit);
        if (b && b.totalValueAgorot > 0) {
          if (b.state !== EXT_ESCROW_PAUSED && b.state !== EXT_ESCROW_STORED) await this.send({ op: 'ext_escrow', unit: b.index, command: EXT_ESCROW_PAUSE }, t.txId);
          await this.send({ op: 'ext_escrow', unit: b.index, command: EXT_ESCROW_STACK }, t.txId);
          t.settleUntil = now + EXT_ESCROW_WAIT_MS;
          return;
        }
      }
    }
    if (t.step === 'escrow' && t.extEscrow) {
      const b = s.escrows.find((e) => e.index === t.extEscrow!.unit);
      const done = !b || b.state === EXT_ESCROW_STACKED_OK || b.state === EXT_ESCROW_STACKING_PROBLEM || b.totalValueAgorot === 0;
      if (!done && now < (t.settleUntil ?? now)) return;
      if (b && b.state === EXT_ESCROW_STACKING_PROBLEM) t.error = { code: 'device', message: 'בעיה בהעברת השטרות לקופסה' };
    }
    this.refreshMoney(t);
    if (t.splitAsked && t.insertedAgorot < t.dueAgorot) {
      // Cash + card: what went in is the cash part (no rounding on it); the card pays the rest.
      t.state = 'PARTIAL';
      t.step = null;
      t.splitAgorot = t.insertedAgorot;
      t.dueAgorot = t.insertedAgorot;
      t.roundingAgorot = 0;
      t.partialSince = now;
      t.message = MESSAGES.partial;
      return;
    }
    t.changeDueAgorot = Math.max(0, t.insertedAgorot - t.dueAgorot);
    if (t.changeDueAgorot === 0) return this.finishPaid(t, now);
    t.state = 'PAYING_CHANGE';
    t.step = 'paying';
    t.message = MESSAGES.change;
    await this.startPayout(t, 'change', t.changeDueAgorot, now);
  }

  private async startPayout(t: CashTx, purpose: 'change' | 'refund', amount: number, now: number) {
    const s = this.snap!;
    const strategy = payoutStrategy(amount, this.inventory(), this.precisePay());
    t.payout = { purpose, startPaidAgorot: s.currentPaidAgorot, requestedAgorot: amount, startedAt: now, mode: 'pay_out' };
    if (!this.hasDispensers()) {
      t.payout = { ...t.payout, startedAt: now - PAYOUT_MIN_MS * 10 };
      return;
    }
    this.d.journal.saveTx(t);
    if (strategy.kind === 'pay_specific') {
      const items = this.specificItems(strategy.plan);
      if (items) {
        t.payout.mode = 'pay_specific';
        const ok = await this.send({ op: 'pay_specific', items }, t.txId);
        if (ok) return;
      }
    }
    t.payout.mode = 'pay_out';
    await this.send({ op: 'pay_out', valueAgorot: amount }, t.txId);
  }

  /** A precise plan on actual dispensers (SetDispenseQuantity per dispenser). */
  private specificItems(plan: Array<{ valueAgorot: number; count: number }>): Array<{ dispenser: number; quantity: number; valueAgorot: number }> | null {
    const s = this.snap!;
    const out: Array<{ dispenser: number; quantity: number; valueAgorot: number }> = [];
    for (const p of plan) {
      let left = p.count;
      const ds = s.dispensers.filter((d) => holdsChange(d.cls) && d.valueAgorot === p.valueAgorot && !d.inhibit);
      for (const d of ds) {
        if (left <= 0) break;
        const have = this.view?.denominations.find((x) => x.valueAgorot === d.valueAgorot)?.dispensers.find((x) => x.index === d.index)?.count ?? 0;
        const n = Math.min(left, Math.max(0, have));
        if (n > 0) {
          out.push({ dispenser: d.index, quantity: n, valueAgorot: d.valueAgorot });
          left -= n;
        }
      }
      if (left > 0) return null;
    }
    return out;
  }

  /** A payout finished (or abandoned): what it paid. Null while it runs. */
  private async payoutResult(t: CashTx, now: number): Promise<number | null> {
    const s = this.snap!;
    const p = t.payout;
    if (!p) return 0;
    const paid = Math.max(0, s.currentPaidAgorot - p.startPaidAgorot);
    const ongoing = s.lastPayStatus === PAY_ONGOING;
    if (!this.hasDispensers()) return paid;
    if (ongoing) {
      // A bill presented and not taken: abandoned after the timeout (the unit takes it back).
      if (now - p.startedAt > this.cfg.settings.payoutTimeoutSec * 1000) {
        const notes = s.dispensers.filter((d) => d.cls === 'note' && !d.inhibit);
        if (notes.length > 0) {
          for (const d of notes) await this.send({ op: 'dispenser', index: d.index, inhibit: true }, t.txId);
          this.st.latched = [...this.st.latched];
          this.d.log(`[cash ${this.cfg.name}] payout of ${t.txId} abandoned after ${this.cfg.settings.payoutTimeoutSec}s`);
          (t as CashTx & { abandoned?: number[] }).abandoned = notes.map((d) => d.index);
        }
      }
      return null;
    }
    if (paid < p.requestedAgorot && now - p.startedAt < PAYOUT_MIN_MS) return null;
    // Dispensers we inhibited to abandon a bill: back in service.
    const abandoned = (t as CashTx & { abandoned?: number[] }).abandoned;
    if (abandoned?.length) {
      for (const i of abandoned) await this.send({ op: 'dispenser', index: i, inhibit: false }, t.txId);
      delete (t as CashTx & { abandoned?: number[] }).abandoned;
    }
    return paid;
  }

  private async payingChange(t: CashTx, now: number) {
    const paid = await this.payoutResult(t, now);
    this.refreshMoney(t);
    if (paid === null) {
      t.changePaidAgorot = this.paidSince(t);
      return;
    }
    t.changePaidAgorot = this.paidSince(t);
    t.changeOwedAgorot = Math.max(0, t.changeDueAgorot - t.changePaidAgorot);
    t.payout = null;
    if (t.changeOwedAgorot > 0) {
      // notify (and prevent, and ask until stage 2): the change owed is recorded, the slip, the manager and the alert tills told (§9א).
      t.slipCode = slipCodeOf(t.txId);
      t.owedId = t.txId;
      t.error = { code: 'change_short', message: `עודף חייב ${shekelText(t.changeOwedAgorot)}` };
      // `ask` (§11.15א): the client asks the customer — a slip, a credit or a tip — before its document.
      t.changeOwedAsk = this.cfg.settings.shortfall === 'ask';
      this.d.log(`[cash ${this.cfg.name}] tx ${t.txId}: change owed ${t.changeOwedAgorot}${t.changeOwedAsk ? ' (the customer chooses)' : ''}`);
    }
    this.finishPaid(t, now);
  }

  /** PARTIAL: waiting for the card on the kiosk (renewing its lease); gone → refunded after the grace; too long → held. */
  private async partial(t: CashTx, now: number) {
    await this.applyAcceptance(t, null);
    this.refreshMoney(t);
    if (t.graceUntil !== null && now >= t.graceUntil) return this.beginRefund(t, 'client_gone', now);
    if (t.partialSince !== null && now - t.partialSince > this.cfg.settings.splitWaitSec * 1000) {
      t.error = { code: 'timeout', message: 'האשראי לא הושלם בזמן — המזומן מוחזק' };
      this.hold(t, 'split_timeout', t.splitAgorot, now);
    }
  }

  private finishPaid(t: CashTx, now: number) {
    t.state = 'DONE';
    t.outcome = 'paid';
    t.step = null;
    t.doneAt = now;
    t.message =
      t.changeOwedAgorot > 0
        ? this.cfg.settings.shortfall === 'ask'
          ? `חסר עודף ${shekelText(t.changeOwedAgorot)}`
          : `עודף חייב ${shekelText(t.changeOwedAgorot)} — הפתק יודפס`
        : MESSAGES.done;
  }

  private async refunding(t: CashTx, now: number) {
    const s = this.snap!;
    if (t.step === 'closing') {
      await this.applyAcceptance(t, null);
      if (now < (t.settleUntil ?? now)) return;
      // A note waiting in single escrow: straight back, not counted.
      const et = s.escrowThroughputAgorot;
      if (et !== null && et > t.escrowSeen) {
        await this.send({ op: 'escrow', action: 'return' }, t.txId);
        t.escrowSeen = et;
        t.escrowAgorot = 0;
      }
      this.refreshMoney(t);
      t.refundDueAgorot = t.insertedAgorot;
      t.step = 'escrow';
      // The recycler's escrow gives back the customer's own notes.
      if (t.extEscrow) {
        const b = s.escrows.find((e) => e.index === t.extEscrow!.unit);
        if (b && b.totalValueAgorot > 0) {
          await this.send({ op: 'ext_escrow', unit: b.index, command: EXT_ESCROW_RETURN }, t.txId);
          t.settleUntil = now + EXT_ESCROW_WAIT_MS;
          return;
        }
      }
    }
    if (t.step === 'escrow') {
      if (t.extEscrow) {
        const b = s.escrows.find((e) => e.index === t.extEscrow!.unit);
        const done = !b || b.state === EXT_ESCROW_RETURNED_OK || b.state === EXT_ESCROW_RETURNING_PROBLEM || b.totalValueAgorot === 0;
        if (!done && now < (t.settleUntil ?? now)) return;
      }
      this.refreshMoney(t);
      const left = t.insertedAgorot - this.paidSince(t);
      t.step = 'paying';
      if (left > 0) {
        await this.startPayout(t, 'refund', left, now);
        return;
      }
    }
    if (t.step === 'paying') {
      const paid = await this.payoutResult(t, now);
      this.refreshMoney(t);
      t.refundPaidAgorot = this.paidSince(t);
      if (paid === null) return;
      t.payout = null;
      const owed = t.insertedAgorot - t.refundPaidAgorot;
      if (owed > 0) return this.hold(t, t.cancelReason === 'client_gone' ? 'client_gone_short' : 'refund_short', owed, now);
      t.state = 'DONE';
      t.outcome = t.insertedAgorot > 0 ? 'refunded' : 'nothing_inserted';
      t.step = null;
      t.doneAt = now;
      t.message = t.insertedAgorot > 0 ? MESSAGES.refunded : MESSAGES.nothing;
    }
  }

  /** No transaction: closed to money; a stray escrow note goes back; refill-through-the-acceptor runs here. */
  private async idle(now: number) {
    const s = this.snap!;
    if (this.st.refillVia) {
      const allowed = this.cfg.settings.coinsAccepted.concat(this.cfg.settings.notesAccepted);
      const key = `refill:${allowed.join(',')}`;
      if (this.lastAcceptance !== key) {
        await this.send(acceptanceCommand(s.acceptors, { coins: this.cfg.settings.coinsAccepted, notes: [], exactOnly: false }, this.extAcceptor()), null);
        this.lastAcceptance = key;
      }
      return;
    }
    if (this.lastAcceptance !== 'null') {
      await this.send(closedCommand(s.acceptors), null);
      this.lastAcceptance = 'null';
    }
    if (s.escrowThroughputAgorot !== null && s.acceptors.some((a) => a.coins.some((c) => c.heldInEscrow > 0))) await this.send({ op: 'escrow', action: 'return' }, null);
    void now;
  }

  /** A paid transaction its client never acknowledged becomes a held credit after `cashUnackedHoldMin`. */
  private holdUnacked(now: number) {
    const limit = this.cfg.settings.unackedHoldMin * 60_000;
    for (const t of this.d.journal.unacked(this.id)) {
      if (t.state === 'DONE' && t.outcome === 'paid' && now - (t.doneAt ?? t.updatedAt) > limit) {
        this.hold(t, 'unacked', Math.max(0, t.dueAgorot - t.changeOwedAgorot), now);
      }
    }
  }

  /* ================================================================== the watchdog, lamps */

  /** CheckOperation, every 500 ms from the host's loop: the unit stops taking money if this process stops. */
  async watchdogTick(): Promise<void> {
    if (!this.opened) return;
    this.st.watchdogSeq = (this.st.watchdogSeq % 2_000_000_000) + 1;
    if (this.st.watchdogSeq % 600 === 0) this.stateDirty = true;
    await this.d.device.command({ op: 'watchdog', sequence: this.st.watchdogSeq, timeoutMs: WATCHDOG_TIMEOUT_MS }).catch(() => undefined);
  }

  private async lamps() {
    const m = this.cfg.settings.lampMap;
    const want = new Map<number, boolean>();
    const st = this.status(null).state;
    const holder = this.holder();
    if (m.ready !== null) want.set(m.ready, st === 'ready');
    if (m.busy !== null) want.set(m.busy, st === 'busy');
    if (m.fault !== null) want.set(m.fault, st === 'fault' || this.alertList.some((a) => a.code === 'jam' || a.code === 'fraud'));
    for (const [client, n] of Object.entries(m.clients)) want.set(n, holder?.clientId === client);
    for (const [n, on] of want) {
      if (this.lampState.get(n) === on) continue;
      if (await this.send({ op: 'indicator', n, on }, null)) this.lampState.set(n, on);
    }
  }

  /* ================================================================== status */

  alerts(): StationAlert[] {
    return this.alertList;
  }

  ledger(): LedgerView | null {
    return this.view;
  }

  snapshot(): DeviceSnapshot | null {
    return this.snap;
  }

  /** A lease or a transaction is open: the updater waits (core/updatePolicy.ts). */
  busy(): boolean {
    return this.queue().length > 0 || this.activeTx() !== null;
  }

  status(clientId: string | null): StationStatus {
    const now = this.d.now();
    const block = blocking(this.alertList);
    const holder = this.holder();
    const active = this.activeTx();
    let state: StationStateName;
    let reason: string | null = null;
    if (!this.opened) {
      state = this.openFailures < 3 && this.d.driverInstalled() ? 'starting' : 'fault';
      reason = !this.d.driverInstalled() ? 'דרייבר מזומן לא מותקן' : this.openError ? `מכשיר המזומן לא זמין (${this.openError})` : 'מכשיר המזומן עולה';
    } else if (block) {
      state = 'fault';
      reason = block.message;
    } else if (this.maintenance || this.st.billsPending || this.st.extEscrowPending || this.st.refillVia) {
      state = 'maintenance';
      reason = this.st.billsPending || this.st.extEscrowPending ? 'שטרות ממתינים לצוות במכשיר' : 'מכשיר המזומן בתחזוקה';
    } else if (holder || active) state = 'busy';
    else state = 'ready';
    const mine = clientId ? this.leases.find((l) => l.clientId === clientId) : null;
    const q = this.queue();
    const dev = this.snap ? deviceDenominations(this.snap.acceptors) : { coins: [], notes: [] };
    const exactOnly = this.view ? exactOnlyNow(this.view.changeAvailableAgorot, this.hasDispensers(), this.cfg.settings.exactChangeBelowAgorot) : true;
    return {
      api: CASH_API,
      stationId: this.id,
      stationName: this.cfg.name,
      hostId: this.d.hostId() ?? '',
      time: now,
      state,
      ready: state === 'ready' || state === 'busy',
      reason,
      currency: 'ILS',
      accepts: {
        coins: this.cfg.settings.coinsAccepted.filter((v) => dev.coins.includes(v)),
        notes: this.cfg.settings.notesAccepted.filter((v) => dev.notes.includes(v)),
      },
      changeAvailableAgorot: this.view?.changeAvailableAgorot ?? 0,
      exactOnly,
      maxChangeAgorot: this.cfg.settings.maxChangeAgorot,
      queue: { length: q.length, holderClientId: holder?.clientId ?? null },
      you: { leaseId: mine?.leaseId ?? null, position: mine ? Math.max(0, q.indexOf(mine)) : null, txId: mine?.txId ?? null },
    };
  }

  /** The heartbeat's `cash.stations[]` entry (contract §11.9). */
  heartbeatBlock(): Record<string, unknown> {
    const s = this.snap;
    const status = this.status(null);
    const v = this.view;
    return {
      stationId: this.id,
      serial: this.cfg.serial,
      deviceSerial: s?.serial ?? null,
      firmware: s?.firmware != null ? firmwareText(s.firmware) : null,
      simulator: this.d.device.kind === 'simulator',
      state: status.state,
      reason: status.reason,
      driver: s?.driver ?? null,
      des: s?.des ?? null,
      changeAvailableAgorot: v?.changeAvailableAgorot ?? 0,
      exactOnly: status.exactOnly,
      denominations: (v?.denominations ?? []).map((d) => ({ valueAgorot: d.valueAgorot, kind: d.kind, count: d.count, accurate: d.accurate, level: d.level, isLow: d.isLow })),
      cashbox: v?.cashbox ?? null,
      queue: status.queue.length,
      activeTxId: this.activeTx()?.txId ?? null,
      heldCount: this.d.journal.byState(this.id, 'HELD', 500).filter((t) => !t.acked).length,
      alerts: this.alertList.map((a) => ({ code: a.code, unit: a.unit, message: `${this.cfg.name}${this.cfg.location ? ` (${this.cfg.location})` : ''}: ${a.message}`, since: a.since })),
    };
  }

  /* ================================================================== staff operations (§5 מסך צוות) */

  private staffGuard(): string | null {
    if (!this.opened || !this.snap) return 'מכשיר המזומן לא מחובר';
    if (this.activeTx()) return 'יש עסקה פתוחה — נסו שוב בעוד רגע';
    return null;
  }

  private move(kind: MoveKind, o: Partial<CashMove>, commandId: string | null): CashMove {
    const m: CashMove = {
      id: o.id ?? this.d.newId(),
      stationId: this.id,
      kind,
      amountAgorot: o.amountAgorot ?? 0,
      pieces: o.pieces ?? [],
      expectedAgorot: o.expectedAgorot ?? null,
      countedAgorot: o.countedAgorot ?? null,
      by: o.by ?? null,
      note: o.note ?? null,
      at: this.d.now(),
      commandId,
    };
    this.d.journal.saveMove(m);
    return m;
  }

  private dispensersOf(valueAgorot: number): DispenserSnap[] {
    return (this.snap?.dispensers ?? []).filter((d) => holdsChange(d.cls) && d.valueAgorot === valueAgorot);
  }

  setMaintenance(on: boolean, by: string | null) {
    this.maintenance = on ? { by, since: this.d.now() } : null;
  }

  get inMaintenance(): boolean {
    return this.maintenance !== null;
  }

  /**
   * "מילוי" / "קרן פתיחה": coins / notes loaded into the dispensers by hand. A unit that counts by itself
   * (SmartHopper, recyclers, MDB tubes) shows them on its own; a level-only hopper's count is the ledger's.
   */
  refill(kind: 'refill' | 'float', pieces: Array<{ valueAgorot: number; count: number }>, by: CashMove['by'], note: string | null, commandId: string | null): { ok: boolean; message: string; move?: CashMove } {
    const g = this.staffGuard();
    if (g) return { ok: false, message: g };
    const now = this.d.now();
    const out: CashMove['pieces'] = [];
    let total = 0;
    for (const p of pieces) {
      if (!(p.count > 0) || !(p.valueAgorot > 0)) continue;
      const ds = this.dispensersOf(p.valueAgorot);
      if (ds.length === 0) return { ok: false, message: `אין מכונת עודף ל-${shekelText(p.valueAgorot)}` };
      const d = ds[0];
      if (kind === 'float') this.st.ledger = setUnitCount(this.st.ledger, this.snap!, d, p.count, this.cfg.settings, now);
      else this.st.ledger = addToUnit(this.st.ledger, this.snap!, d, p.count, this.cfg.settings, now);
      out.push({ valueAgorot: p.valueAgorot, kind: d.cls === 'note' ? 'note' : 'coin', count: p.count });
      total += p.valueAgorot * p.count;
    }
    this.stateDirty = true;
    const m = this.move(kind, { amountAgorot: total, pieces: out, by, note }, commandId);
    this.view = this.snap ? ledgerView(this.snap, this.st.ledger, this.cfg.settings) : this.view;
    return { ok: true, message: `נרשם ${kind === 'float' ? 'קרן' : 'מילוי'} של ${shekelText(total)}`, move: m };
  }

  /** "מילוי דרך המקבל": staff insert coins through the acceptor; the credit is a refill, not a sale. */
  refillViaAcceptor(on: boolean, by: CashMove['by'], commandId: string | null): { ok: boolean; message: string; move?: CashMove } {
    if (on) {
      const g = this.staffGuard();
      if (g) return { ok: false, message: g };
      this.st.refillVia = { start: countersOf(this.snap!), by, startedAt: this.d.now() };
      this.stateDirty = true;
      this.lastAcceptance = '';
      return { ok: true, message: 'הכניסו את המטבעות למקבל' };
    }
    const r = this.st.refillVia;
    if (!r || !this.snap) return { ok: false, message: 'אין מילוי פתוח' };
    const now = countersOf(this.snap);
    const pieces = piecesBetween(r.start, now, 'in');
    const total = this.snap.currentValueAgorot - r.start.currentValueAgorot;
    this.st.refillVia = null;
    this.stateDirty = true;
    this.lastAcceptance = '';
    const m = this.move('refill', { amountAgorot: total, pieces, by: r.by, note: 'מילוי דרך המקבל' }, commandId);
    return { ok: true, message: `נכנסו ${shekelText(total)}`, move: m };
  }

  /**
   * "ספירה": what staff counted per denomination (and in the cashbox). A level-only hopper takes the
   * count; an ID-003 recycler (UBA / iPro) is told it (DISPENSER_UPDATE_COUNT); expected vs counted kept.
   */
  async count(pieces: Array<{ valueAgorot: number; count: number }>, cashboxCountedAgorot: number | null, by: CashMove['by'], note: string | null, commandId: string | null): Promise<{ ok: boolean; message: string; move?: CashMove }> {
    const g = this.staffGuard();
    if (g) return { ok: false, message: g };
    const now = this.d.now();
    const expected = (this.view?.changeAvailableAgorot ?? 0) + (cashboxCountedAgorot !== null ? (this.view?.cashbox.valueAgorot ?? 0) : 0);
    let counted = cashboxCountedAgorot ?? 0;
    const out: CashMove['pieces'] = [];
    for (const p of pieces) {
      const ds = this.dispensersOf(p.valueAgorot);
      if (ds.length === 0) continue;
      const d = ds[0];
      counted += p.valueAgorot * p.count;
      out.push({ valueAgorot: p.valueAgorot, kind: d.cls === 'note' ? 'note' : 'coin', count: p.count });
      if (canUpdateDeviceCount(d.cls, d.bus)) {
        await this.send({ op: 'dispenser', index: d.index, status: DISPENSER_UPDATE_COUNT, coinCount: p.count }, null);
      }
      this.st.ledger = setUnitCount(this.st.ledger, this.snap!, d, p.count, this.cfg.settings, now);
    }
    this.stateDirty = true;
    const m = this.move('count', { amountAgorot: counted, pieces: out, expectedAgorot: expected, countedAgorot: counted, by, note }, commandId);
    const diff = counted - expected;
    return { ok: true, message: diff === 0 ? 'הספירה תואמת' : `הפרש ${diff > 0 ? '+' : ''}${shekelText(diff)}`, move: m };
  }

  /** "ריקון קופסה": the cashbox was emptied (a deposit out of the station's drawer). */
  collect(countedAgorot: number | null, by: CashMove['by'], note: string | null, commandId: string | null): { ok: boolean; message: string; move?: CashMove } {
    const g = this.staffGuard();
    if (g) return { ok: false, message: g };
    const expected = this.view?.cashbox.valueAgorot ?? 0;
    const amount = countedAgorot ?? expected;
    this.st.ledger = emptyCashbox(this.st.ledger, this.snap!, this.cfg.settings, this.d.now());
    this.stateDirty = true;
    const m = this.move('collect', { amountAgorot: amount, expectedAgorot: expected, countedAgorot, by, note }, commandId);
    return { ok: true, message: `רוקנו ${shekelText(amount)}`, move: m };
  }

  /**
   * "ריקון מכונת עודף לקופסה": a recycler's full / partial dump (or the SmartHopper's), where the unit
   * can (never MDB). Internal: the money stays in the station's drawer.
   */
  async dump(valueAgorot: number | null, notes: number | null, by: CashMove['by'], commandId: string | null): Promise<{ ok: boolean; message: string; move?: CashMove }> {
    const g = this.staffGuard();
    if (g) return { ok: false, message: g };
    const s = this.snap!;
    const targets: DispenserSnap[] = [];
    if (valueAgorot === null) {
      const total = s.dispensers.find((d) => d.cls === 'smart_total');
      if (total && canFullDump(total.cls, total.bus)) targets.push(total);
      for (const d of s.dispensers) if (d.cls === 'note' && canFullDump(d.cls, d.bus)) targets.push(d);
    } else {
      for (const d of this.dispensersOf(valueAgorot)) {
        if (notes !== null ? canPartialDump(d.cls, d.bus) : canFullDump(d.cls, d.bus) || canPartialDump(d.cls, d.bus)) targets.push(d);
      }
    }
    if (targets.length === 0) return { ok: false, message: 'מכונת העודף הזו אינה תומכת בריקון לקופסה' };
    const moveId = this.d.newId();
    const pieces: CashMove['pieces'] = [];
    for (const d of targets) {
      const have = d.cls === 'smart_total' ? (this.view?.denominations.filter((x) => x.dispensers.some((y) => y.cls === 'smart_hopper')).reduce((sum, x) => sum + x.count, 0) ?? 0) : (this.view?.denominations.find((x) => x.valueAgorot === d.valueAgorot)?.dispensers.find((x) => x.index === d.index)?.count ?? 0);
      // A SmartHopper denomination has no full dump of its own (the manual): all of it as a partial dump.
      const partial = notes !== null ? notes : !canFullDump(d.cls, d.bus) && canPartialDump(d.cls, d.bus) ? have : null;
      if (partial !== null && canPartialDump(d.cls, d.bus)) {
        await this.send({ op: 'dispenser', index: d.index, status: DISPENSER_PARTIAL_DUMP, notesToDump: partial }, null);
        pieces.push({ valueAgorot: d.valueAgorot, kind: d.cls === 'note' ? 'note' : 'coin', count: Math.min(partial, have) });
      } else {
        await this.send({ op: 'dispenser', index: d.index, status: DISPENSER_CASHBOX_DUMP }, null);
        pieces.push({ valueAgorot: d.valueAgorot, kind: d.cls === 'note' ? 'note' : 'coin', count: have });
      }
      this.pendingDumps.push({ key: dispenserKey(d), kind: d.cls === 'note' ? 'note' : 'coin', valueAgorot: d.valueAgorot, before: have, at: this.d.now(), moveId });
    }
    const m = this.move('dump', { id: moveId, amountAgorot: pieces.reduce((sum, p) => sum + p.valueAgorot * p.count, 0), pieces, by, note: notes !== null ? `ריקון חלקי (${notes})` : 'ריקון מלא' }, commandId);
    return { ok: true, message: 'הריקון לקופסה התחיל', move: m };
  }

  /** A dump's end (DISPENSER_DUMP_FINISHED): the ledger moves the pieces to the cashbox. */
  private checkDumps(now: number) {
    if (this.pendingDumps.length === 0 || !this.snap) return;
    const keep: typeof this.pendingDumps = [];
    for (const p of this.pendingDumps) {
      const d = this.snap.dispensers.find((x) => dispenserKey(x) === p.key);
      const finished = !d || d.status === DISPENSER_DUMP_FINISHED || now - p.at > 120_000;
      if (!finished) {
        keep.push(p);
        continue;
      }
      if (d && d.cls !== 'smart_total') {
        const after = this.view?.denominations.find((x) => x.valueAgorot === d.valueAgorot)?.dispensers.find((x) => x.index === d.index);
        const moved = Math.max(0, p.before - (after?.accurate ? after.count : 0));
        this.st.ledger = dumpedToCashbox(this.st.ledger, p.kind, moved, p.valueAgorot);
        if (after && !after.accurate) this.st.ledger = setUnitCount(this.st.ledger, this.snap, d, 0, this.cfg.settings, now);
      } else if (d) {
        // The SmartHopper as a whole: every denomination went to the cashbox.
        for (const x of this.view?.denominations ?? []) {
          if (x.dispensers.some((y) => y.cls === 'smart_hopper')) this.st.ledger = dumpedToCashbox(this.st.ledger, 'coin', x.count, x.valueAgorot);
        }
      }
      this.stateDirty = true;
    }
    this.pendingDumps = keep;
  }

  /** "מסירת שטרות ממתינים": staff present, the bills PayLink held after a power cut are delivered. */
  async deliverPending(by: CashMove['by']): Promise<{ ok: boolean; message: string }> {
    if (!this.snap) return { ok: false, message: 'מכשיר המזומן לא מחובר' };
    for (const d of this.snap.dispensers) if (d.cls === 'note' && d.inhibit) await this.send({ op: 'dispenser', index: d.index, inhibit: false }, null);
    this.st.billsPending = false;
    this.st.latched = this.st.latched.filter((l) => l.code !== 'bills_pending');
    this.stateDirty = true;
    void by;
    return { ok: true, message: 'השטרות שוחררו' };
  }

  /** The extended escrow's notes from before a power cut: back to the customer (staff present) or kept. */
  async resolveExtEscrow(action: 'return' | 'stack'): Promise<{ ok: boolean; message: string }> {
    const g = this.staffGuard();
    if (g) return { ok: false, message: g };
    if (this.extEscrowUnit === null) return { ok: false, message: 'אין נאמנות שטרות' };
    await this.send({ op: 'ext_escrow', unit: this.extEscrowUnit, command: action === 'return' ? EXT_ESCROW_RETURN : EXT_ESCROW_STACK }, null);
    this.st.extEscrowPending = false;
    this.stateDirty = true;
    return { ok: true, message: action === 'return' ? 'השטרות הוחזרו' : 'השטרות הועברו למכשיר' };
  }

  resetAlerts(): void {
    this.st.latched = [];
    this.stateDirty = true;
  }

  /** The staff screen's look at the journal. */
  recentTxs(limit = 30): TxView[] {
    return this.d.journal.recent(this.id, limit).map(txView);
  }

  /** The station's drawer since the last collection (the staff screen). */
  drawerPieces(): Piece[] {
    return (this.view?.denominations ?? []).map((d) => ({ valueAgorot: d.valueAgorot, kind: d.kind, count: d.count }));
  }

  switchStates() {
    return switchStates(this.snap, this.cfg.settings);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** "מילוי דרך המקבל" runs. */
  get refillActive(): boolean {
    return this.st.refillVia !== null;
  }

  /** OpenMHE's last failure code (31: the driver does not run), for the driver's supervisor. */
  get openErrorCode(): number | null {
    return this.opened ? null : this.openCode;
  }

  /** Unit tests: the device's status update acknowledged (count updated / dump finished). */
  static readonly ACK = { DISPENSER_COUNT_UPDATED, DISPENSER_DUMP_FINISHED };
}
