/**
 * A cash recycler the kiosk pays at (P:/specs/cashmag-windows.md §4) — the same line as pos-android's
 * `hardware/cash/CashRecyclerDriver.kt`: CashMag over its WebSocket (main/cash/cashmagDriver.ts), nothing at all
 * for a protocol we cannot speak ([UnavailableRecycler] — RLP until the vendor gives its wire format), a fake in the
 * tests. No wire format crosses it: what the server answered is a [CashRecyclerReply] (core/cash/cashmag.ts), what
 * it says meanwhile a [CashRecyclerSignal].
 *
 * Beside Android's: no `attach` / `onPause` (no vendor dialog on Windows — the screens are ours), and `answer`
 * (the server's question → dialogValid / dialogCancel) and `probe` (is the server there, without taking it).
 * Android's `licenseStatus` / `isStarted` / `claimState` have no function in the WebSocket's table yet.
 */

import { CASHMAG_ERRORS, refusedReply, type CashMagConfig, type CashRecyclerReply } from '../../core/cash/cashmag';
import type { CashMagClaim } from '../../core/cash/cashmagWire';

export interface CashRecyclerSignal {
  /**
   * deposits: money went in (`insertedAgorot` so far); question: the server asks (`question`); claim: who has the
   * machine now (`claim`); device: the pay station changed.
   */
  type: 'deposits' | 'question' | 'claim' | 'device' | 'other';
  claim?: CashMagClaim;
  name: string;
  at: number;
  insertedAgorot?: number;
  question?: { title: string; text: string };
}

export interface CashRecyclerState {
  connection: 'idle' | 'connecting' | 'ready' | 'busy' | 'unreachable' | 'closed';
  /** The server answered a probe lately (null: not asked yet). */
  reachable: boolean | null;
  lastError: string | null;
  lastSignal: string | null;
  lastSignalAt: number | null;
  /** What went in during the payment now (the deposits signal). */
  insertedAgorot: number;
  /** The server's question waiting for an answer. */
  question: { title: string; text: string } | null;
  /** Who has the machine, as the claim signal last said on this connection ('unknown': not told). */
  claim: CashMagClaim;
}

export const IDLE_STATE: CashRecyclerState = {
  connection: 'idle',
  reachable: null,
  lastError: null,
  lastSignal: null,
  lastSignalAt: null,
  insertedAgorot: 0,
  question: null,
  claim: 'unknown',
};

export interface CashRecyclerDriver {
  /** This kiosk can speak to such a device at all; else every call is [notInstalledReason]. */
  readonly installed: boolean;
  readonly notInstalledReason: string;
  state(): CashRecyclerState;
  onSignal(fn: (s: CashRecyclerSignal) => void): () => void;
  /** Where the server is and who this kiosk is (the user code): before anything else. Busy → CLAIMED_BY_ANOTHER. */
  connect(config: CashMagConfig): Promise<CashRecyclerReply>;
  start(): Promise<CashRecyclerReply>;
  stop(): Promise<CashRecyclerReply>;
  /** One payment, as long as it lasts: [dueAgorot] is what the device collects (after rounding). */
  pay(amountAgorot: number, dueAgorot: number, currency: string, autoCancelSec: number): Promise<CashRecyclerReply>;
  /** The open dialog ended by this kiosk: confirm (dialogValid) or cancel (dialogCancel — the customer's "ביטול"). */
  answer(confirm: boolean): Promise<CashRecyclerReply>;
  /** Is the server there — without taking it from whoever has it. */
  probe(config: CashMagConfig): Promise<boolean>;
  /** Off the server (the machine free for the next client). */
  disconnect(): Promise<void>;
}

/** Nothing to call, every call says why (RLP before the vendor's wire format). */
export class UnavailableRecycler implements CashRecyclerDriver {
  readonly installed = false;
  constructor(readonly notInstalledReason: string = CASHMAG_ERRORS.RLP_NOT_AVAILABLE) {}
  state(): CashRecyclerState {
    return IDLE_STATE;
  }
  onSignal(): () => void {
    return () => undefined;
  }
  private no(): Promise<CashRecyclerReply> {
    return Promise.resolve(refusedReply(this.notInstalledReason));
  }
  connect() {
    return this.no();
  }
  start() {
    return this.no();
  }
  stop() {
    return this.no();
  }
  pay() {
    return this.no();
  }
  answer() {
    return this.no();
  }
  async probe(): Promise<boolean> {
    return false;
  }
  async disconnect(): Promise<void> {}
}
