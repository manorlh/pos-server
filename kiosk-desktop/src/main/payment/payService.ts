/**
 * The kiosk's card payment, whatever the terminal (provider.ts) — the till's rules
 * (pos-server docs/SPEC_CARD_RECOVERY.md; pos-android CheckoutViewModel.chargeCard,
 * CardAttemptRecovery.kt, KioskTerminalMonitor.kt):
 *
 *  1. refused BEFORE anything is written or sent: no terminal set up at all, a frame already out,
 *     or — only with "חסימת אשראי כשיש תשלום לא מוכרע" on in the cloud (cardLockOnUnresolved) — an
 *     earlier attempt unresolved. A terminal whose health check did not answer is tried on the
 *     press, its error said then (the owner, 08.10.2026: "אל תחסום בכללי — אם יש שגיאה שיופיע
 *     בלחיצה על אשראי"); an unresolved attempt is otherwise an alert for staff;
 *  2. the pending document is written (by the caller, with its number) — then the attempt goes to
 *     disk (reference, amount, document) — only then the frame leaves;
 *  3. approved → complete; certainly not charged → void (a new attempt is a new document and
 *     reference) — and so is a frame that never left (NOT_SENT: no link, nothing written; the
 *     attempt is dropped, nothing to look up); unknown → asked about THE SAME reference (never a
 *     second charge) — approved, not charged, or held for a person (the document stays pending,
 *     every card blocked);
 *  4. the customer's "ביטול": before the frame, nothing; after it and before an answer, an abort
 *     and the sale's own answer awaited; never an abort after an answer;
 *  5. at start, and before the day's transmission, every orphan attempt is settled first.
 */

import { blocksCard, cancelAction, cardBlocked, lookupVoidMeta, type CardAttempt } from '../../core/cardRecovery';
import { mayCheckTerminal, terminalCheckDue, terminalConfigState, terminalState, type TerminalState } from '../../core/kioskHealth';
import type { Db } from '../db/sqlite';
import type { ApprovedCard, PaymentProvider, Resolution, TransmitResult } from './provider';

export type ChargeOutcome =
  | { kind: 'approved'; card: ApprovedCard; recovered: boolean }
  | { kind: 'declined'; message: string; voidMeta: Record<string, unknown> | null }
  | { kind: 'unknown'; message: string }
  | { kind: 'refused'; reason: 'terminal' | 'in_flight' | 'unresolved' | 'amount' };

export interface MonitorState {
  config: 'ready' | 'unconfigured' | 'not_external';
  failures: number;
  lastCheckAtMs: number | null;
  lastOkAtMs: number | null;
  lastError: string | null;
  state: TerminalState;
}

export class PayService {
  private provider: PaymentProvider | null = null;
  private integration: string | null = null;
  private inFlight: { reference: string; sent: boolean; answered: boolean; abort: boolean } | null = null;
  private lastCardAnswerAtMs: number | null = null;
  readonly monitor: MonitorState = { config: 'unconfigured', failures: 0, lastCheckAtMs: null, lastOkAtMs: null, lastError: null, state: 'unconfigured' };
  private listeners = new Set<() => void>();
  /** "חסימת אשראי כשיש תשלום לא מוכרע" (the till parameter cardLockOnUnresolved), read per charge. Off unless set. */
  private lockOnUnresolved: () => boolean = () => false;

  constructor(
    private readonly db: Db,
    private readonly log: (m: string) => void = () => undefined,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** The cloud settings changed: pick the provider (never while a frame is out). */
  setProvider(p: PaymentProvider | null, integration: string | null) {
    if (this.inFlight) return;
    // A terminal paired since (or no longer) is another provider: its own settings say so.
    const same =
      p && this.provider && p.kind === this.provider.kind && p.describe().address === this.provider.describe().address &&
      (p.configured !== false) === (this.provider.configured !== false);
    if (!same) {
      // The terminal it replaces lets go of what it holds (a COM port opens once at a time).
      if (this.provider && this.provider !== p) {
        try {
          this.provider.dispose?.();
        } catch {
          /* closing */
        }
      }
      this.provider = p;
      this.monitor.failures = 0;
      this.monitor.lastCheckAtMs = null;
    }
    this.integration = integration;
    // SynqPay not paired yet: no orders until it is (as the Android kiosk's KioskTerminal.configured).
    this.monitor.config = terminalConfigState({ integration, providerConfigured: !!p && p.configured !== false });
    this.monitor.state = terminalState(this.monitor.config, this.monitor.failures);
    this.emit();
  }

  get current(): PaymentProvider | null {
    return this.provider;
  }

  get cardInFlight(): boolean {
    return this.inFlight !== null;
  }

  /* -------------------------------------------------------------- attempts */

  attempts(): CardAttempt[] {
    return this.db.all<{ json: string }>('SELECT json FROM card_attempts').map((r) => JSON.parse(r.json) as CardAttempt);
  }

  private saveAttempt(a: CardAttempt) {
    this.db.run('INSERT INTO card_attempts (vuid, json) VALUES (?, ?) ON CONFLICT(vuid) DO UPDATE SET json = excluded.json', a.vuid, JSON.stringify(a));
  }

  forgetAttempt(reference: string) {
    this.db.run('DELETE FROM card_attempts WHERE vuid = ?', reference);
  }

  /** The cloud's "חסימת אשראי כשיש תשלום לא מוכרע" (read on every check). */
  setLockOnUnresolved(fn: () => boolean) {
    this.lockOnUnresolved = fn;
  }

  /** Any attempt unresolved (an urgent alert for staff), whatever the parameter says. */
  unresolved(): boolean {
    return cardBlocked(this.attempts());
  }

  /** Card refused for an unresolved attempt: only with "חסימת אשראי כשיש תשלום לא מוכרע" on. */
  blocked(): boolean {
    let lock = false;
    try {
      lock = this.lockOnUnresolved();
    } catch {
      lock = false;
    }
    return lock && this.unresolved();
  }

  /** A terminal is set up to charge on: what refuses a card in advance — never its health check. */
  get configured(): boolean {
    return !!this.provider && this.monitor.config === 'ready';
  }

  /* ------------------------------------------------------------- charging */

  /**
   * One charge for a pending document. `onSent` is called once the attempt is on disk and the
   * frame is about to leave (the screen moves to "הצמידו כרטיס").
   */
  async charge(input: {
    transactionId: string;
    orderId: string | null;
    amountAgorot: number;
    tipAgorot: number;
    payments?: number;
    onSent?: () => void;
    onProgress?: (message: string) => void;
  }): Promise<ChargeOutcome> {
    const provider = this.provider;
    if (!provider || this.monitor.config !== 'ready') return { kind: 'refused', reason: 'terminal' };
    if (this.inFlight) return { kind: 'refused', reason: 'in_flight' };
    if (this.blocked()) return { kind: 'refused', reason: 'unresolved' };
    if (!Number.isInteger(input.amountAgorot) || input.amountAgorot < 1) return { kind: 'refused', reason: 'amount' };
    const reference = provider.newReference();
    const attempt: CardAttempt = {
      vuid: reference,
      transactionId: input.transactionId,
      orderId: input.orderId,
      amountAgorot: input.amountAgorot,
      method: 'card',
      kind: 'sale',
      payments: input.payments ?? 1,
      terminalTip: false,
      tipAgorot: input.tipAgorot,
      startedAt: new Date().toISOString(),
      state: 'sent',
      note: null,
      supersededBy: null,
    };
    this.saveAttempt(attempt); // on disk BEFORE the frame leaves
    this.inFlight = { reference, sent: true, answered: false, abort: false };
    this.emit();
    input.onSent?.();
    try {
      const result = await provider.sale({
        amountAgorot: input.amountAgorot,
        reference,
        payments: attempt.payments,
        onProgress: input.onProgress,
        // Answered (its acknowledgement may still be on its way): a cancel now sends nothing.
        onAnswered: () => {
          if (this.inFlight?.reference === reference) this.inFlight.answered = true;
        },
      });
      if (result.answer === 'NOT_SENT') {
        // Nothing reached the terminal (no link, nothing written): certainly not charged — the
        // document is voided with the reason, and there is nothing to look up or to settle.
        this.forgetAttempt(reference);
        this.log(`card: not sent (${reference}): ${result.message}`);
        return { kind: 'declined', message: result.message, voidMeta: null };
      }
      this.inFlight.answered = true;
      this.lastCardAnswerAtMs = Date.now();
      if (result.answer === 'APPROVED') return { kind: 'approved', card: result.card, recovered: false };
      if (result.answer === 'DECLINED') return { kind: 'declined', message: result.message, voidMeta: null };
      // Unknown: never a second charge — ask about this reference.
      this.saveAttempt({ ...attempt, state: 'unknown', note: result.message });
      input.onProgress?.('בודק סטטוס תשלום…');
      const r = await provider.resolve({ reference, amountAgorot: input.amountAgorot, terminalTip: false });
      return this.fromResolution(attempt, r);
    } catch (e) {
      this.saveAttempt({ ...attempt, state: 'unknown', note: String(e) });
      return { kind: 'unknown', message: e instanceof Error ? e.message : String(e) };
    } finally {
      this.inFlight = null;
      this.emit();
    }
  }

  private fromResolution(a: CardAttempt, r: Resolution): ChargeOutcome {
    if (r.kind === 'approved') return { kind: 'approved', card: r.card, recovered: true };
    if (r.kind === 'not_charged') return { kind: 'declined', message: r.message, voidMeta: lookupVoidMeta(a, r.outcome, r.message, new Date().toISOString()) };
    this.saveAttempt({ ...a, state: 'unknown', note: r.message });
    return { kind: 'unknown', message: r.message };
  }

  /** The customer's "ביטול" on the pay screen. */
  async cancel(): Promise<'dropped' | 'aborted' | 'none'> {
    const f = this.inFlight;
    const action = cancelAction({ sent: !!f?.sent, answered: !!f?.answered });
    if (!f) return 'none';
    if (action === 'abort_and_wait' && this.provider && !f.abort) {
      f.abort = true;
      await this.provider.abort(f.reference).catch(() => undefined);
      return 'aborted';
    }
    return action === 'drop' ? 'dropped' : 'none';
  }

  /** Settle every attempt nobody is waiting for (app start, before a transmission). */
  async resolveOrphans(handlers: {
    isPending: (transactionId: string) => boolean;
    complete: (a: CardAttempt, card: ApprovedCard) => void;
    void: (a: CardAttempt, meta: Record<string, unknown>) => void;
  }): Promise<{ settled: number; unknown: number }> {
    let settled = 0;
    let unknown = 0;
    const provider = this.provider;
    for (const a of this.attempts()) {
      if (this.inFlight?.reference === a.vuid) continue;
      if (!handlers.isPending(a.transactionId)) {
        this.forgetAttempt(a.vuid);
        continue;
      }
      if (!blocksCard(a) || !provider) {
        unknown++;
        continue;
      }
      const r = await provider.resolve({ reference: a.vuid, amountAgorot: a.amountAgorot, terminalTip: a.terminalTip }).catch((e) => ({ kind: 'unknown' as const, message: String(e) }));
      if (r.kind === 'approved') {
        handlers.complete(a, r.card);
        this.forgetAttempt(a.vuid);
        settled++;
      } else if (r.kind === 'not_charged') {
        handlers.void(a, lookupVoidMeta(a, r.outcome, r.message, new Date().toISOString()));
        this.forgetAttempt(a.vuid);
        settled++;
      } else {
        this.saveAttempt({ ...a, state: 'unknown', note: r.message });
        unknown++;
      }
    }
    this.emit();
    return { settled, unknown };
  }

  /** "סמן כלא אושר והמשך" — a manager, after checking the terminal: void and forget. */
  markNotApproved(reference: string, by: { id: string; name: string }, voidDoc: (a: CardAttempt, meta: Record<string, unknown>) => void): boolean {
    const a = this.attempts().find((x) => x.vuid === reference);
    if (!a) return false;
    const meta = { ...lookupVoidMeta(a, 'marked_not_approved', a.note, new Date().toISOString()), markedById: by.id, markedByName: by.name, markedAt: new Date().toISOString(), stateWhenMarked: a.state };
    voidDoc(a, meta);
    this.forgetAttempt(reference);
    this.emit();
    return true;
  }

  /* -------------------------------------------------------------- monitor */

  /** The 10-second tick: check the terminal when due and allowed (KioskTerminalMonitor). */
  async monitorTick(flow: { busy: boolean; screen: string }, forced = false): Promise<void> {
    const p = this.provider;
    if (!p) return;
    const now = Date.now();
    if (!forced && !terminalCheckDue(this.monitor.lastCheckAtMs, this.monitor.failures, now)) return;
    if (!mayCheckTerminal({ cardInFlight: this.cardInFlight, lastCardAnswerAtMs: this.lastCardAnswerAtMs, nowMs: now, flowBusy: flow.busy, screen: flow.screen, forced })) return;
    this.monitor.lastCheckAtMs = now;
    const r = await p.check().catch((e) => ({ ok: false, detail: String(e) }));
    if (r.ok) {
      this.monitor.failures = 0;
      this.monitor.lastOkAtMs = Date.now();
      this.monitor.lastError = null;
    } else {
      this.monitor.failures++;
      this.monitor.lastError = r.detail;
    }
    const before = this.monitor.state;
    this.monitor.state = terminalState(this.monitor.config, this.monitor.failures);
    if (before !== this.monitor.state) this.log(`terminal: ${before} → ${this.monitor.state}`);
    this.emit();
  }

  /** The day's batch (doPeriodic), never with a card on the terminal. */
  async transmit(): Promise<TransmitResult | null> {
    if (!this.provider?.transmit) return null;
    if (this.inFlight) return { outcome: 'busy', batchNumber: null, statusCode: null, statusMessage: null, error: 'card in flight', transactionCount: null, amountAgorot: null, raw: null };
    return this.provider.transmit();
  }

  describe(): { kind: string | null; address: string | null; integration: string | null } {
    const d = this.provider?.describe();
    return { kind: d?.kind ?? null, address: d?.address ?? null, integration: this.integration };
  }
}
