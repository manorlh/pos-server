/**
 * "זיכוי באשראי (Z-Credit)" (docs/SPEC_REMOTE_CREDIT.md §11): the cloud refunds a card sale
 * charged through Z-Credit, and a till issues the credit note (remote credit, mode
 * `card_refunded`). The wire types and the pure rules the dialog applies before it asks (the
 * server checks everything again, and reads the sale at Z-Credit before refunding).
 *
 * No React and no `@/` imports: compiled and run by `npm test` on its own.
 */

import {
  CREDIT_DOCUMENT_TYPES,
  creditFor,
  defaultTarget,
  selectedLines,
  type RemoteCreditEvent,
  type RemoteCreditPrepare,
  type RemoteCreditSelection,
} from './remoteCredit';

export type CloudCardRefundStatus = 'in_flight' | 'refunded' | 'declined' | 'unknown';
export type CloudCardRefundAttention = 'unknown' | 'document_missing' | 'document_pending';

/** Who may refund (the server's `get_current_machine_admin`) — the remote credit's roles. */
export const CLOUD_CARD_REFUND_ROLES = ['company_manager', 'shop_manager', 'distributor', 'super_admin'] as const;

/** The remote-credit statuses a till still has to act on. */
const PENDING_REQUEST = new Set(['queued', 'sent', 'received']);

export interface CloudCardRefundLeg {
  paymentId: string;
  method: string;
  amount: string;
  provider?: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
  approvalNumber?: string | null;
  /** Charged through Z-Credit (even when nothing is left on it). */
  zcredit: boolean;
  refundable: boolean;
  refusal?: { code: string; message: string } | null;
  refundedAmount: string;
  inProgressAmount: string;
  tillCardCredits: string;
  remainingAmount: string;
}

export interface CloudCardRefundDocument {
  requestId?: string | null;
  requestStatus?: string | null;
  requestErrorCode?: string | null;
  requestErrorMessage?: string | null;
  machineId?: string | null;
  creditTransactionId?: string | null;
  creditDocumentNumber?: string | null;
  creditDocumentType?: number | null;
  landed: boolean;
}

export interface CloudCardRefund {
  id: string;
  transactionId: string;
  paymentId: string;
  originalDocumentNumber?: string | null;
  originalMachineId?: string | null;
  originalMachineName?: string | null;
  provider: string;
  terminal: string;
  credentialSource?: string | null;
  originalReference: string;
  originalLegAmount: string;
  cardLast4?: string | null;
  cardBrand?: string | null;
  amount: string;
  fullCredit: boolean;
  lines: { itemId: string; productName?: string | null; quantity: number; amount: string }[];
  reasonCode?: string | null;
  reason: string;
  status: CloudCardRefundStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  beforeStatusCode?: number | null;
  afterStatusCode?: number | null;
  returnCode?: number | null;
  returnMessage?: string | null;
  refundReference?: string | null;
  approvalNumber?: string | null;
  voucherNumber?: string | null;
  voided: boolean;
  resolvedBy?: 'gateway' | 'status_query' | 'manual' | null;
  resolutionNote?: string | null;
  queryCount: number;
  lastQueryAt?: string | null;
  refundSentAt?: string | null;
  refundedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  targetMachineId: string;
  targetMachineName?: string | null;
  targetOnline: boolean;
  attention?: CloudCardRefundAttention | null;
  attentionLabel?: string | null;
  /**
   * "זיכוי באשראי מהענן — חובה לפני ה-Z הבא" (§11.8–§11.10): where the owed note waits — the open
   * shift, or the till's next one ("ממתין למשמרת הבאה בקופה X") — whether it holds the next Z, the
   * warning when it does not, and a super admin's release from the next Z.
   */
  documentLanding?: 'open_shift' | 'next_shift' | null;
  documentLandingWords?: string | null;
  blocksNextZ?: boolean;
  zGateWarning?: string | null;
  zGateReleased?: boolean;
  /** "זיכוי אשראי מהענן ממתין להפקה (₪X)" while the note is owed. */
  pendingWords?: string | null;
  document: CloudCardRefundDocument;
  events?: RemoteCreditEvent[];
}

export interface CloudCardRefundPrepare {
  enabled: boolean;
  disabledMessage?: string | null;
  label: string;
  legs: CloudCardRefundLeg[];
  credentials: {
    available: boolean;
    terminal?: string | null;
    source?: string | null;
    /** The layer of the terminal number: `machine` — the till's own; else shared by its branch / point of sale. */
    terminalSource?: string | null;
    refusal?: { code: string; message: string } | null;
  };
  /** The remote credit's prepare: lines, money, tills, reasons (the card refund's). */
  document: RemoteCreditPrepare;
  refunds: CloudCardRefund[];
}

export interface CloudCardRefundCreateBody {
  id: string;
  transactionId: string;
  paymentId: string;
  machineId: string;
  full: boolean;
  lines: { itemId: string; quantity: number }[];
  reason: string | null;
  reasonCode: string | null;
}

/** What the dialog has picked (the remote credit's selection without its mode). */
export type CloudCardRefundSelection = Omit<RemoteCreditSelection, 'mode'>;

export type CloudCardRefundProblem =
  | 'disabled'
  | 'notRefundable'
  | 'noCredentials'
  | 'notCreditable'
  | 'noLines'
  | 'overLine'
  | 'overLeg'
  | 'noTarget'
  | 'reasonRequired';

interface LegLike {
  method?: string | null;
  nayaxMeta?: Record<string, unknown> | null;
  noMoneyMovement?: boolean | null;
}

function resultOf(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const r = meta?.result;
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
}

/**
 * A card leg the till charged through Z-Credit (its reply says `provider: zcredit`): where the
 * dashboard offers "זיכוי באשראי (Z-Credit)". The server decides for good (a reference, the
 * money left, the switch); a leg of another terminal keeps "צור זיכוי" → להשלמה בקופה.
 */
export function isZCreditLeg(leg: LegLike): boolean {
  if ((leg.method ?? '').trim().toLowerCase() !== 'card' || leg.noMoneyMovement) return false;
  const meta = leg.nayaxMeta ?? null;
  const provider = resultOf(meta).provider ?? meta?.provider;
  return typeof provider === 'string' && provider.trim().toLowerCase() === 'zcredit';
}

/** A credit note's card leg that records a refund the cloud made (its id in the reply). */
export function cloudRefundIdOf(leg: LegLike): string | null {
  const id = leg.nayaxMeta?.cloudCardRefundId;
  return typeof id === 'string' && id ? id : null;
}

/** A sale (not a credit) that may still be refunded — the remote credit's rule. */
export function isRefundableDocument(tx: {
  documentType?: number | null;
  refundOfTransactionId?: string | null;
  status: string;
}): boolean {
  if (tx.documentType != null && CREDIT_DOCUMENT_TYPES.includes(tx.documentType)) return false;
  if (tx.refundOfTransactionId) return false;
  return tx.status === 'completed' || tx.status === 'partial_refund';
}

const toAgorot = (shekels: string | number): number => Math.round(Number(shekels) * 100);
const toShekels = (agorot: number): string => (agorot / 100).toFixed(2);

/** The money of the selection (₪, decimal string) — the server's figure for the same choice. */
export function refundAmount(prepare: RemoteCreditPrepare, selection: Pick<CloudCardRefundSelection, 'full' | 'quantities'>): string {
  let total = 0;
  for (const line of prepare.lines) {
    if (selection.full) {
      total += toAgorot(line.remainingAmount);
      continue;
    }
    const qty = Math.min(selection.quantities[line.itemId] ?? 0, line.remaining);
    if (qty <= 0) continue;
    total += creditFor(toAgorot(line.collected), line.quantity, line.credited + line.pending, qty);
  }
  return toShekels(total);
}

/** Why the selection cannot be sent yet; empty when it can. */
export function refundProblems(
  prepare: CloudCardRefundPrepare,
  leg: CloudCardRefundLeg | null,
  selection: CloudCardRefundSelection,
): CloudCardRefundProblem[] {
  const out: CloudCardRefundProblem[] = [];
  const doc = prepare.document;
  if (!prepare.enabled) out.push('disabled');
  if (!leg || !leg.refundable) out.push('notRefundable');
  if (!prepare.credentials.available) out.push('noCredentials');
  if (!doc.creditable) out.push('notCreditable');
  const picked = selectedLines(doc.lines, selection);
  if (picked.length === 0) out.push('noLines');
  if (!selection.full && doc.lines.some((l) => (selection.quantities[l.itemId] ?? 0) > l.remaining + 0.0005)) {
    out.push('overLine');
  }
  if (leg && toAgorot(refundAmount(doc, selection)) > toAgorot(leg.remainingAmount)) out.push('overLeg');
  if (!selection.machineId || !doc.targets.some((t) => t.machineId === selection.machineId)) out.push('noTarget');
  const text = selection.reason.trim();
  if (text.length < 2 && (!selection.reasonCode || selection.reasonCode === 'other')) out.push('reasonRequired');
  return out;
}

export function buildRefundBody(
  prepare: CloudCardRefundPrepare,
  paymentId: string,
  selection: CloudCardRefundSelection,
  refundId: string,
): CloudCardRefundCreateBody {
  return {
    id: refundId,
    transactionId: prepare.document.transactionId,
    paymentId,
    machineId: selection.machineId ?? '',
    full: selection.full,
    lines: selection.full ? [] : selectedLines(prepare.document.lines, selection),
    reason: selection.reason.trim() || null,
    reasonCode: selection.reasonCode,
  };
}

/**
 * Where the selection starts: everything left when the card leg covers it, else nothing
 * picked (the owner chooses lines that fit the card).
 */
export function initialFull(prepare: CloudCardRefundPrepare, leg: CloudCardRefundLeg | null): boolean {
  if (!leg) return false;
  return toAgorot(prepare.document.remainingAmount) <= toAgorot(leg.remainingAmount);
}

export function refundStatusVariant(status: CloudCardRefundStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'refunded':
      return 'default';
    case 'unknown':
      return 'destructive';
    case 'declined':
      return 'outline';
    default:
      return 'secondary';
  }
}

/** Still moving: the dialog polls while the refund runs or its credit note is on its way. */
export function isLiveRefund(r: Pick<CloudCardRefund, 'status' | 'document'>): boolean {
  if (r.status === 'in_flight') return true;
  return r.status === 'refunded' && !r.document.creditTransactionId && PENDING_REQUEST.has(r.document.requestStatus ?? '');
}

/** "שלח לקופה": a refunded card whose credit note no till has issued. */
export function canResend(r: Pick<CloudCardRefund, 'status' | 'document'>): boolean {
  return r.status === 'refunded' && !r.document.creditTransactionId && !r.document.landed;
}

/** Sending it elsewhere moves a note still waiting at a till (needs the user's confirmation). */
export function resendNeedsForce(r: Pick<CloudCardRefund, 'document'>): boolean {
  return PENDING_REQUEST.has(r.document.requestStatus ?? '');
}

/**
 * The till the dialog starts on: the server's proposal (§11.8 — the sale's till first; for a terminal
 * the branch shares, an open till of the branch before the sale's till's next shift), else the
 * remote credit's rule.
 */
export function cardDefaultTarget(prepare: CloudCardRefundPrepare): string | null {
  const proposed = prepare.document.defaultTargetId;
  // An older server says nothing: the remote credit's rule. A null proposal is "none" — the user picks.
  if (proposed === undefined) return defaultTarget(prepare.document.targets);
  return proposed && prepare.document.targets.some((t) => t.machineId === proposed) ? proposed : null;
}

/** "כפה Z בלי הזיכוי" (support): a refunded card whose owed note holds the next Z and is not released yet. */
export function canReleaseFromZ(
  r: Pick<CloudCardRefund, 'status' | 'document' | 'blocksNextZ' | 'zGateReleased'>,
  role: string | null | undefined,
): boolean {
  return role === 'super_admin' && r.status === 'refunded' && !r.document.creditTransactionId &&
    !r.document.landed && r.blocksNextZ !== false && !r.zGateReleased;
}

/** The card as the dialog names it: "****4580", or the brand alone. */
export function cardLabel(last4?: string | null): string {
  return last4 ? `****${last4}` : '—';
}
