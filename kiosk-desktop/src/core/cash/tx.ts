/**
 * One cash transaction at a cash station (P:/specs/cash-paylink.md §4, contract §11.4): the record
 * the host's journal keeps (main/cash/journal.ts) — written BEFORE the device is touched, with the
 * device's lifetime counters at the start, and again before every command — and the view the LAN
 * API answers.
 *
 *   LEASED ──start──▶ ACCEPTING ──due reached──▶ SETTLING ──▶ PAYING_CHANGE ──▶ DONE (paid)
 *                         │                          (no change) ─────────────────▶ DONE (paid)
 *                         └─cancel / timeout / client gone─▶ REFUNDING ──▶ DONE (refunded | nothing_inserted)
 *   cash + card (§11.15ב): ACCEPTING ──split──▶ SETTLING ──▶ PARTIAL ──finish──▶ DONE (paid, splitAgorot)
 *                                                               └─cancel / client gone─▶ REFUNDING
 *   any state ──power cut / crash / refund failed──▶ HELD (heldAgorot = what the customer is owed)
 *
 * Never auto-paid after a power cut: an open transaction found at start becomes HELD (§4).
 *
 * Pure.
 */

export type TxState = 'LEASED' | 'ACCEPTING' | 'SETTLING' | 'PAYING_CHANGE' | 'PARTIAL' | 'REFUNDING' | 'DONE' | 'HELD';
export type TxOutcome = 'paid' | 'refunded' | 'nothing_inserted';
export type CancelReason = 'customer' | 'timeout' | 'idle' | 'client_gone' | 'kiosk' | 'device' | 'staff';
export type HeldReason = 'power_loss' | 'refund_short' | 'client_gone_short' | 'unacked' | 'device_fault' | 'consistency' | 'split_timeout' | 'split_void';
/** §11.15א: what the customer chose for change the station could not pay. */
export type OwedChoice = 'slip' | 'credit' | 'tip';
export const OWED_CHOICES: readonly OwedChoice[] = ['slip', 'credit', 'tip'];

export const OPEN_STATES: readonly TxState[] = ['LEASED', 'ACCEPTING', 'SETTLING', 'PAYING_CHANGE', 'PARTIAL', 'REFUNDING'];
export const FINAL_STATES: readonly TxState[] = ['DONE', 'HELD'];

export function isOpen(s: TxState): boolean {
  return OPEN_STATES.includes(s);
}

/** The device's lifetime counters at a moment (the journal's "starting counters"). */
export interface Counters {
  at: number;
  currentValueAgorot: number;
  currentPaidAgorot: number;
  /** acceptorKey|coinIndex → lifetime count (per-denomination breakdown). */
  coins: Record<string, { valueAgorot: number; kind: 'coin' | 'note'; count: number }>;
  /** dispenserKey → lifetime count paid. */
  dispensers: Record<string, { valueAgorot: number; count: number }>;
  escrowThroughputAgorot: number | null;
}

export interface Piece {
  valueAgorot: number;
  kind: 'coin' | 'note';
  count: number;
}

export interface CashTx {
  txId: string;
  stationId: string;
  hostId: string;
  clientId: string;
  clientName: string | null;
  leaseId: string;
  kind: 'sale';
  /** The kiosk's order (local id) and the label staff see ("הזמנה 57"). */
  orderRef: string | null;
  orderLabel: string | null;
  /** The document's amount; the cash due is it rounded (`cashRounding`). */
  amountAgorot: number;
  dueAgorot: number;
  roundingAgorot: number;
  state: TxState;
  outcome: TxOutcome | null;
  start: Counters;
  insertedAgorot: number;
  inserted: Piece[];
  /** A note held in (single-note) escrow, not yet money. */
  escrowAgorot: number;
  changeDueAgorot: number;
  changePaidAgorot: number;
  /** Change that could not be paid (notify policy: a "עודף חייב" slip, the manager and the alert tills told). */
  changeOwedAgorot: number;
  /** `ask` (§11.15א): the client asks the customer what to do with the change owed before its document. */
  changeOwedAsk: boolean;
  /** The customer's choice as the client acknowledged it (null: not yet / none owed). */
  changeOwedAs: OwedChoice | null;
  /** Cash + card (§11.15ב): the client asked to pay the rest by card (`split`) — what the cash paid once PARTIAL. */
  splitAsked: boolean;
  splitAgorot: number;
  /** When it became PARTIAL (the `cashSplitWaitSec` limit). */
  partialSince: number | null;
  refundDueAgorot: number;
  refundPaidAgorot: number;
  /** What the customer is owed and the device kept (power cut, a refund that could not be paid). */
  heldAgorot: number;
  heldReason: HeldReason | null;
  paidOut: Piece[];
  cancelReason: CancelReason | null;
  /** The denominations enabled now. */
  accepting: { coins: number[]; notes: number[] };
  exactOnly: boolean;
  /** The payout in progress: CurrentPaid when it started, what was asked, how. */
  payout: { purpose: 'change' | 'refund'; startPaidAgorot: number; requestedAgorot: number; startedAt: number; mode: 'pay_out' | 'pay_specific' | 'ext_return' } | null;
  /** The extended escrow of the station holds this transaction's notes. */
  extEscrow: { unit: number; heldAgorot: number } | null;
  /** Where a multi-step state is (SETTLING / REFUNDING): closing → escrow → paying. */
  step: 'closing' | 'escrow' | 'paying' | null;
  /** EscrowThroughput already decided on (single-note escrow). */
  escrowSeen: number;
  /** Acceptance was closed because the client stopped renewing (re-opened if it comes back in time). */
  closedForGrace: boolean;
  error: { code: string; message: string } | null;
  /** The Hebrew line the client's screen may show as is. */
  message: string | null;
  owedId: string | null;
  slipCode: string | null;
  acked: boolean;
  documentId: string | null;
  documentNumber: string | null;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  idleDeadlineAt: number;
  lastInsertAt: number | null;
  settleUntil: number | null;
  /** The client stopped renewing its lease: refunded at the device after this. */
  graceUntil: number | null;
  doneAt: number | null;
  /** Monotonic per change: clients keep the highest they saw. */
  seq: number;
  uploadedSeq: number;
}

/** The LAN API's answer for a transaction (contract §11.4). */
export interface TxView {
  txId: string;
  stationId: string;
  hostId: string;
  clientId: string;
  leaseId: string;
  state: TxState;
  outcome: TxOutcome | null;
  amountAgorot: number;
  dueAgorot: number;
  roundingAgorot: number;
  insertedAgorot: number;
  remainingAgorot: number;
  escrowAgorot: number;
  changeDueAgorot: number;
  changePaidAgorot: number;
  changeOwedAgorot: number;
  changeOwedAsk: boolean;
  changeOwedAs: OwedChoice | null;
  splitAgorot: number;
  refundDueAgorot: number;
  refundPaidAgorot: number;
  heldAgorot: number;
  heldReason: HeldReason | null;
  cancelReason: CancelReason | null;
  inserted: Piece[];
  paidOut: Piece[];
  accepting: { coins: number[]; notes: number[] };
  exactOnly: boolean;
  deadlineAt: number;
  idleDeadlineAt: number;
  message: string | null;
  error: { code: string; message: string } | null;
  owedId: string | null;
  slipCode: string | null;
  acked: boolean;
  documentId: string | null;
  documentNumber: string | null;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export function txView(t: CashTx): TxView {
  return {
    txId: t.txId,
    stationId: t.stationId,
    hostId: t.hostId,
    clientId: t.clientId,
    leaseId: t.leaseId,
    state: t.state,
    outcome: t.outcome,
    amountAgorot: t.amountAgorot,
    dueAgorot: t.dueAgorot,
    roundingAgorot: t.roundingAgorot,
    insertedAgorot: t.insertedAgorot,
    remainingAgorot: Math.max(0, t.dueAgorot - t.insertedAgorot),
    escrowAgorot: t.escrowAgorot,
    changeDueAgorot: t.changeDueAgorot,
    changePaidAgorot: t.changePaidAgorot,
    changeOwedAgorot: t.changeOwedAgorot,
    changeOwedAsk: t.changeOwedAsk ?? false,
    changeOwedAs: t.changeOwedAs ?? null,
    splitAgorot: t.splitAgorot ?? 0,
    refundDueAgorot: t.refundDueAgorot,
    refundPaidAgorot: t.refundPaidAgorot,
    heldAgorot: t.heldAgorot,
    heldReason: t.heldReason,
    cancelReason: t.cancelReason,
    inserted: t.inserted,
    paidOut: t.paidOut,
    accepting: t.accepting,
    exactOnly: t.exactOnly,
    deadlineAt: t.deadlineAt,
    idleDeadlineAt: t.idleDeadlineAt,
    message: t.message,
    error: t.error,
    owedId: t.owedId,
    slipCode: t.slipCode,
    acked: t.acked,
    documentId: t.documentId,
    documentNumber: t.documentNumber,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    seq: t.seq,
  };
}

/** Pieces by value from two counter readings (what went in / out between them). */
export function piecesBetween(a: Counters, b: Counters, side: 'in' | 'out'): Piece[] {
  const by = new Map<string, Piece>();
  if (side === 'in') {
    for (const [k, now] of Object.entries(b.coins)) {
      const was = a.coins[k]?.count ?? now.count;
      const n = now.count - was;
      if (n <= 0) continue;
      const key = `${now.kind}:${now.valueAgorot}`;
      const p = by.get(key) ?? { valueAgorot: now.valueAgorot, kind: now.kind, count: 0 };
      p.count += n;
      by.set(key, p);
    }
  } else {
    for (const [k, now] of Object.entries(b.dispensers)) {
      const was = a.dispensers[k]?.count ?? now.count;
      const n = now.count - was;
      if (n <= 0) continue;
      const kind: 'coin' | 'note' = now.valueAgorot >= 2000 ? 'note' : 'coin';
      const key = `${kind}:${now.valueAgorot}`;
      const p = by.get(key) ?? { valueAgorot: now.valueAgorot, kind, count: 0 };
      p.count += n;
      by.set(key, p);
    }
  }
  return [...by.values()].sort((x, y) => y.valueAgorot - x.valueAgorot);
}

const SLIP_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY3479';

/** A short code for the "עודף חייב" slip / the held credit (from the transaction id, stable). */
export function slipCodeOf(txId: string): string {
  let h = 2166136261;
  for (let i = 0; i < txId.length; i++) {
    h ^= txId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += SLIP_ALPHABET[h % SLIP_ALPHABET.length];
    h = (Math.floor(h / SLIP_ALPHABET.length) ^ Math.imul(i + 7, 2654435761)) >>> 0;
  }
  return `C-${out}`;
}

/** The transaction's short id for staff (first 8 of the uuid). */
export function shortTx(txId: string): string {
  return txId.replace(/-/g, '').slice(0, 8).toUpperCase();
}
