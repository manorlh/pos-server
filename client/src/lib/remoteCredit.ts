/**
 * "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): a credit for a document, asked for from the
 * dashboard and issued by a till with an open shift. The wire types and the pure rules the
 * dialog applies before it asks (the server checks everything again).
 *
 * No React and no `@/` imports: compiled and run by `npm test` on its own.
 */

/**
 * `card_refunded` ("זוכה באשראי מהענן", §11) is never picked here: a cloud card refund
 * (lib/cloudCardRefund.ts) creates it, and it cannot be cancelled — only sent to another till.
 */
export type RemoteCreditMode = 'no_money' | 'prepared' | 'card_refunded';

export type RemoteCreditStatus =
  | 'queued'
  | 'sent'
  | 'received'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** The modes the dialog offers. */
export const REMOTE_CREDIT_MODES: readonly RemoteCreditMode[] = ['no_money', 'prepared'];

/** A request the dashboard may cancel while pending: not a card the cloud already refunded. */
export function isCancellableRemoteCredit(req: { status: RemoteCreditStatus; mode: RemoteCreditMode }): boolean {
  return PENDING_REMOTE_CREDIT.has(req.status) && req.mode !== 'card_refunded';
}

/** The statuses a till still has to act on; the dialog polls while one of these. */
export const PENDING_REMOTE_CREDIT: ReadonlySet<RemoteCreditStatus> = new Set<RemoteCreditStatus>([
  'queued',
  'sent',
  'received',
]);

/** Who may ask (the server's `get_current_machine_admin`): owners and managers. */
export const REMOTE_CREDIT_ROLES = ['company_manager', 'shop_manager', 'distributor', 'super_admin'] as const;

/** A credit note (330) or an exempt dealer's receipt refund (-400). */
export const CREDIT_DOCUMENT_TYPES: readonly number[] = [330, -400];

export interface RemoteCreditLine {
  itemId: string;
  productId?: string | null;
  productName?: string | null;
  quantity: number;
  /** Decimal string, ₪. */
  amount: string;
}

export interface RemoteCreditTender {
  method: string;
  amount: string;
}

export interface RemoteCreditEvent {
  at: string;
  actor: 'user' | 'till' | 'system' | string;
  action: string;
  by?: string | null;
  detail?: string | null;
}

export interface RemoteCreditRequest {
  id: string;
  transactionId: string;
  originalDocumentNumber?: string | null;
  originalDocumentType?: number | null;
  originalIssuedAt?: string | null;
  originalMachineId?: string | null;
  originalMachineName?: string | null;
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  online: boolean;
  mode: RemoteCreditMode;
  /** Mode `card_refunded`: the cloud card refund whose credit note this is. */
  cardRefundId?: string | null;
  fullCredit: boolean;
  lines: RemoteCreditLine[];
  amount: string;
  tenders: RemoteCreditTender[];
  reasonCode?: string | null;
  reason: string;
  status: RemoteCreditStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  creditTransactionId?: string | null;
  creditDocumentNumber?: string | null;
  creditDocumentType?: number | null;
  creditAmount?: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  sentAt?: string | null;
  receivedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  cancelledAt?: string | null;
  createdByUserId: string;
  createdBy?: string | null;
  cancelledBy?: string | null;
  cancelReason?: string | null;
  events?: RemoteCreditEvent[];
}

export interface RemoteCreditTarget {
  machineId: string;
  name: string;
  posNumber?: string | null;
  shopId: string;
  shopName?: string | null;
  online: boolean;
  lastHeartbeatAt?: string | null;
  openShift?: { id: string; openedAt?: string | null; sequenceNumber?: number | null } | null;
  isOriginalTill: boolean;
  areaId?: string | null;
  /**
   * A cloud card refund's target only (SPEC_REMOTE_CREDIT.md §11.8): where its credit note lands —
   * the open shift, or (`cloudCardRefundLanding = open_or_next_shift`) the till's next shift — in
   * the server's words ("ייכנס למשמרת הבאה בקופה X — חובה לפני ה-Z הבא").
   */
  landing?: 'open_shift' | 'next_shift' | null;
  landingWords?: string | null;
  /** `cloudCardRefundBlocksNextZ` of that till: its next Z waits for the note. */
  blocksNextZ?: boolean;
  /** Shares the sale's Z-Credit terminal (its branch / point of sale); always true for a till's own terminal. */
  sameBranch?: boolean;
}

export interface RemoteCreditPrepareLine {
  itemId: string;
  productId?: string | null;
  productName?: string | null;
  /** Sold on the original. */
  quantity: number;
  /** Taken by credit notes already issued. */
  credited: number;
  /** Held by other pending requests. */
  pending: number;
  remaining: number;
  unitPrice: string;
  /** What the customer paid for the whole line (after its discounts), ₪. */
  collected: string;
  /** The money for everything still left on the line, ₪. */
  remainingAmount: string;
}

export interface RemoteCreditPrepare {
  transactionId: string;
  documentNumber?: string | null;
  documentType?: number | null;
  machineId: string;
  createdAt: string;
  status: string;
  creditable: boolean;
  refusal?: { code: string; message: string } | null;
  collected: string;
  creditedAmount: string;
  pendingAmount: string;
  remainingAmount: string;
  lines: RemoteCreditPrepareLine[];
  tenders: RemoteCreditTender[];
  targets: RemoteCreditTarget[];
  pendingRequests: RemoteCreditRequest[];
  reasons: { code: string; label: string }[];
  preparedExpiryHours: number;
  /** A cloud card refund's prepare only: the till the server proposes for the credit note (§11.8). */
  defaultTargetId?: string | null;
}

export interface RemoteCreditCreateBody {
  id: string;
  transactionId: string;
  machineId: string;
  mode: RemoteCreditMode;
  full: boolean;
  lines: { itemId: string; quantity: number }[];
  reason: string | null;
  reasonCode: string | null;
}

/** What the dialog has picked. `quantities` by line id (partial only). */
export interface RemoteCreditSelection {
  full: boolean;
  quantities: Record<string, number>;
  mode: RemoteCreditMode | null;
  machineId: string | null;
  reasonCode: string | null;
  reason: string;
}

export type SelectionProblem =
  | 'notCreditable'
  | 'noLines'
  | 'overLine'
  | 'noMode'
  | 'noTarget'
  | 'reasonRequired';

export function isPendingRemoteCredit(status: RemoteCreditStatus | null | undefined): boolean {
  return !!status && PENDING_REMOTE_CREDIT.has(status);
}

/**
 * How often the dialog asks for a request it follows: every 2 s for its first half minute (a
 * till online answers within seconds), every 5 s up to three minutes, then every 15 s (a till
 * offline — it is handed the request on its next beat). `false`: not pending, no more polling.
 */
export function remoteCreditPollMs(
  req: Pick<RemoteCreditRequest, 'status' | 'createdAt'> | null | undefined,
  nowMs: number,
): number | false {
  if (req && !isPendingRemoteCredit(req.status)) return false;
  const created = req ? Date.parse(req.createdAt) : NaN;
  const age = Number.isNaN(created) ? 0 : Math.max(0, nowMs - created);
  if (age < 30_000) return 2000;
  if (age < 180_000) return 5000;
  return 15_000;
}

export function remoteCreditStatusVariant(
  status: RemoteCreditStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed':
      return 'default';
    case 'failed':
    case 'expired':
      return 'destructive';
    case 'cancelled':
      return 'outline';
    default:
      return 'secondary';
  }
}

/** A sale (not a credit) that has been completed — what may be credited at all. */
export function isCreditableDocument(tx: {
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

/**
 * The money for crediting `quantity` of a line — the till's rule (RefundMath.creditFor):
 * the rounded share of everything credited up to and including these units, less the
 * rounded share of what went before. So a line credited in pieces adds up to what was paid.
 */
export function creditFor(collectedAgorot: number, originalQty: number, already: number, quantity: number): number {
  if (quantity <= 0 || originalQty <= 0) return 0;
  const before = Math.min(Math.max(already, 0), originalQty);
  const after = Math.min(before + quantity, originalQty);
  const share = (q: number) => Math.round(collectedAgorot * (q / originalQty));
  return share(after) - share(before);
}

/** The amount (₪, decimal string) of what is selected — the server's figure for the same choice. */
export function selectionAmount(lines: RemoteCreditPrepareLine[], selection: Pick<RemoteCreditSelection, 'full' | 'quantities'>): string {
  let total = 0;
  for (const line of lines) {
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

/** The lines of the request: everything left (full), or what was picked. */
export function selectedLines(
  lines: RemoteCreditPrepareLine[],
  selection: Pick<RemoteCreditSelection, 'full' | 'quantities'>,
): { itemId: string; quantity: number }[] {
  return lines
    .map((l) => ({ itemId: l.itemId, quantity: selection.full ? l.remaining : selection.quantities[l.itemId] ?? 0 }))
    .filter((l) => l.quantity > 0);
}

/** Why the selection cannot be sent yet; empty when it can. */
export function selectionProblems(prepare: RemoteCreditPrepare, selection: RemoteCreditSelection): SelectionProblem[] {
  const out: SelectionProblem[] = [];
  if (!prepare.creditable) out.push('notCreditable');
  const picked = selectedLines(prepare.lines, selection);
  if (picked.length === 0) out.push('noLines');
  if (
    !selection.full &&
    prepare.lines.some((l) => (selection.quantities[l.itemId] ?? 0) > l.remaining + 0.0005)
  ) {
    out.push('overLine');
  }
  if (!selection.mode) out.push('noMode');
  if (!selection.machineId || !prepare.targets.some((t) => t.machineId === selection.machineId)) out.push('noTarget');
  const text = selection.reason.trim();
  if (text.length < 2 && (!selection.reasonCode || selection.reasonCode === 'other')) out.push('reasonRequired');
  return out;
}

export function buildCreateBody(
  prepare: RemoteCreditPrepare,
  selection: RemoteCreditSelection,
  commandId: string,
): RemoteCreditCreateBody {
  return {
    id: commandId,
    transactionId: prepare.transactionId,
    machineId: selection.machineId ?? '',
    mode: selection.mode ?? 'prepared',
    full: selection.full,
    lines: selection.full ? [] : selectedLines(prepare.lines, selection),
    reason: selection.reason.trim() || null,
    reasonCode: selection.reasonCode,
  };
}

/**
 * The default till: the document's own till when it may issue the credit (an original of
 * its open shift nets out there), else the only one offered, else none.
 */
export function defaultTarget(targets: RemoteCreditTarget[]): string | null {
  const own = targets.find((t) => t.isOriginalTill);
  if (own) return own.machineId;
  return targets.length === 1 ? targets[0].machineId : null;
}

/** A command id the server dedupes by — a double click is one request. */
export function newCommandId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 from Math.random — only where randomUUID is missing (old browsers).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** The last thing that happened, for a one-line status in a list. */
export function lastEvent(req: RemoteCreditRequest): RemoteCreditEvent | null {
  const events = req.events ?? [];
  return events.length ? events[events.length - 1] : null;
}
