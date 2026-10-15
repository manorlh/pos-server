/**
 * A cash recycler that is no device at all (the flow's tests): every call scripted, every call recorded.
 */

import { okReply, type CashMagConfig, type CashRecyclerReply } from '../../src/core/cash/cashmag';
import type { CashMagClaim } from '../../src/core/cash/cashmagWire';
import { IDLE_STATE, type CashRecyclerDriver, type CashRecyclerSignal, type CashRecyclerState } from '../../src/main/cash/recycler';

export class FakeRecycler implements CashRecyclerDriver {
  readonly installed = true;
  readonly notInstalledReason = 'NOT_CONNECTED';
  readonly calls: string[] = [];
  /** connect's answers in turn (the last one repeats). */
  connectReplies: CashRecyclerReply[] = [okReply()];
  startReply: CashRecyclerReply = okReply();
  /** The payment: what it answers (it may signal first). */
  payWith: (f: FakeRecycler, dueAgorot: number) => Promise<CashRecyclerReply> = async () => okReply();
  answers: boolean[] = [];
  reachable = true;
  private st: CashRecyclerState = { ...IDLE_STATE };
  private listeners = new Set<(s: CashRecyclerSignal) => void>();
  /** Resolves the payment in progress from outside (dialogCancel → this). */
  onAnswer: ((confirm: boolean) => void) | null = null;

  state(): CashRecyclerState {
    return this.st;
  }

  onSignal(fn: (s: CashRecyclerSignal) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(s: Omit<CashRecyclerSignal, 'at'>) {
    if (s.type === 'deposits') this.st = { ...this.st, insertedAgorot: s.insertedAgorot ?? 0 };
    if (s.type === 'claim') this.st = { ...this.st, claim: s.claim ?? 'unknown' };
    for (const fn of this.listeners) fn({ ...s, at: Date.now() });
  }

  setClaim(claim: CashMagClaim) {
    this.emit({ type: 'claim', name: 'signalClaimStateChanged', claim });
  }

  async connect(_c: CashMagConfig): Promise<CashRecyclerReply> {
    this.calls.push('connect');
    const r = this.connectReplies.length > 1 ? this.connectReplies.shift()! : this.connectReplies[0];
    this.st = { ...this.st, connection: r.valid ? 'ready' : 'closed' };
    return r;
  }

  async start(): Promise<CashRecyclerReply> {
    this.calls.push('start');
    return this.startReply;
  }

  async stop(): Promise<CashRecyclerReply> {
    this.calls.push('stop');
    return okReply();
  }

  async pay(_a: number, due: number): Promise<CashRecyclerReply> {
    this.calls.push(`pay:${due}`);
    return this.payWith(this, due);
  }

  async answer(confirm: boolean): Promise<CashRecyclerReply> {
    this.calls.push(confirm ? 'valid' : 'cancel');
    this.answers.push(confirm);
    this.onAnswer?.(confirm);
    return okReply();
  }

  async probe(): Promise<boolean> {
    this.calls.push('probe');
    return this.reachable;
  }

  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
    this.st = { ...this.st, connection: 'closed' };
  }
}
