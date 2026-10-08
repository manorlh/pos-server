/**
 * "עסקאות שלא הושלמו" — failed payment attempts (docs/SPEC_FAILED_PAYMENTS.md): the
 * wire types of `GET /failed-payments` (pos-server app/routers/failed_payments.py) and
 * the pure rules the dashboard applies to them.
 *
 * Money is integer agorot (`amountAgorot`, `totalAgorot`); a cancelled document's
 * `totalAmount` is in shekels as stored. Informational only: never part of a total.
 *
 * Kept free of React and of the `@/` alias so `npm test` can compile and run it on its
 * own (src/lib/failedPayments.test.ts).
 */

export const FAILED_OUTCOMES = [
  'declined',
  'cancelled_terminal',
  'cancelled_cashier',
  'no_answer',
  'terminal_error',
  'card_locked',
  // "לא הוכרע": the card's result is not known yet — possibly charged; the till's documents wait.
  'unresolved',
  // "אושר בבדיקה": found charged on a check, the sale completed — NOT a failed payment.
  'approved_late',
] as const;
export type FailedOutcome = (typeof FAILED_OUTCOMES)[number];

/** Outcomes that are not a failed / not-completed payment: in no count or total. */
export const NOT_FAILED_OUTCOMES: readonly string[] = ['approved_late'];

/** The tenders a paying document may have had ("שולם בהמשך במזומן / באשראי …"). */
export const PAID_LATER_METHODS = ['cash', 'card', 'voucher', 'mixed'] as const;

export interface FailedPaymentAttempt {
  id: string;
  occurredAt: string;
  resolvedAt?: string | null;
  receivedAt?: string | null;
  updatedAt?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  shiftId?: string | null;
  shiftNumber?: number | null;
  businessDate?: string | null;
  posUserId?: string | null;
  employeeName?: string | null;
  amountAgorot: number;
  /** `card` today; `voucher` and others possible. */
  method: string;
  /** sale | keyed | payout (money back to a card that failed). */
  kind: string;
  /** till | kiosk. */
  channel: string;
  terminalType?: string | null;
  terminalId?: string | null;
  outcome: FailedOutcome | string;
  reasonCode?: string | null;
  reasonMessage?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  lineCount?: number | null;
  vuid?: string | null;
  /** The pending document the till voided for this attempt, and its number as printed. */
  transactionId?: string | null;
  transactionNumber?: string | null;
  /** The document that eventually paid the same basket. */
  paidByTransactionId?: string | null;
  paidByTransactionNumber?: string | null;
  paidByMethod?: string | null;
  paidAt?: string | null;
  /** An unresolved attempt's latest manager command to its till; null when none. */
  cardCommand?: CardCommand | null;
  /** Its latest check the till answered — what the terminal said; null when never checked. */
  cardCheck?: CardCommand | null;
}

export interface FailedPaymentSummary {
  /** kind sale + keyed — `approved_late` in none of these. */
  count: number;
  totalAgorot: number;
  payoutCount: number;
  payoutTotalAgorot: number;
  paidLaterCount: number;
  /** "לא הוכרע", also in the figures above (an open attempt). Absent on an older server. */
  unresolvedCount?: number;
  unresolvedTotalAgorot?: number;
  /** "אושר בבדיקה": counted apart only. */
  approvedLateCount?: number;
}

// ── "תשלום לא מוכרע": the manager's commands (pos-server app/services/card_attempt_commands.py) ──

export type CardCommandAction = 'check' | 'mark_approved' | 'mark_not_approved';
export const CARD_COMMAND_ACTIONS: readonly CardCommandAction[] = ['check', 'mark_approved', 'mark_not_approved'];
export type CardCommandStatus = 'pending' | 'done' | 'failed' | 'not_found' | 'busy' | 'expired' | 'cancelled';
export const CARD_COMMAND_STATUSES: readonly CardCommandStatus[] = [
  'pending',
  'done',
  'failed',
  'not_found',
  'busy',
  'expired',
  'cancelled',
];
export type CardCommandResult = 'approved' | 'not_charged' | 'unknown';
/** What the terminal said on a check; `not_checked` when no check was answered. */
export type CheckVerdict = 'approved' | 'cancelled' | 'not_found' | 'unknown' | 'not_checked';
export const CHECK_VERDICTS: readonly CheckVerdict[] = ['approved', 'cancelled', 'not_found', 'unknown', 'not_checked'];

/** A check's answer from the terminal (the till's read-only lookup by vuid). */
export interface CardCheckDetails {
  verdict: Exclude<CheckVerdict, 'not_checked'> | string;
  terminalUid?: string | null;
  at?: string | null;
  amountAgorot?: number | null;
  last4?: string | null;
  authNumber?: string | null;
  brand?: string | null;
  checkedAt?: string | null;
}

export interface CardCommand {
  id: string;
  attemptId?: string | null;
  machineId: string;
  vuid?: string | null;
  action: CardCommandAction | string;
  status: CardCommandStatus | string;
  requestedByName?: string | null;
  requestedAt?: string | null;
  expiresAt?: string | null;
  deliveredAt?: string | null;
  answeredAt?: string | null;
  resultOutcome?: CardCommandResult | string | null;
  resultMessage?: string | null;
  cancelledByName?: string | null;
  /** mark_approved / mark_not_approved: the cloud's decision (waits for the till, never expires). */
  isDecision?: boolean;
  /** A check: what the terminal said. */
  details?: CardCheckDetails | null;
  verdict?: string | null;
  /** A decision: what the latest check said when it was made, and the manager's confirmation. */
  verdictAtDecision?: string | null;
  checkCommandId?: string | null;
  mismatchConfirmed?: boolean;
}

export interface CancelledSale {
  id: string;
  documentNumber?: string | null;
  transactionNumber: string;
  documentType?: number | null;
  /** Shekels, as stored. */
  totalAmount: number;
  totalAgorot: number;
  paymentMethod?: string | null;
  createdAt: string;
  shopId?: string | null;
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  shiftId?: string | null;
  cashierId?: string | null;
  cashierName?: string | null;
}

export interface FailedPaymentsResponse {
  page: number;
  pageSize: number;
  total: number;
  summary: FailedPaymentSummary;
  items: FailedPaymentAttempt[];
  cancelledSales: { count: number; totalAgorot: number; items: CancelledSale[] };
}

export interface FailedPaymentsQuery {
  machineId?: string | null;
  shopId?: string | null;
  shiftId?: string | null;
  zReportId?: string | null;
  from?: string | null;
  to?: string | null;
  outcome?: string | null;
  cardLast4?: string | null;
  page?: number;
  pageSize?: number;
}

/** The query string of `GET /failed-payments`: empty filters left out. */
export function failedPaymentsParams(q: FailedPaymentsQuery): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const keys = ['machineId', 'shopId', 'shiftId', 'zReportId', 'from', 'to', 'outcome'] as const;
  for (const key of keys) {
    const value = q[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  if (q.cardLast4 && /^\d{4}$/.test(q.cardLast4)) out.cardLast4 = q.cardLast4;
  if (q.page && q.page > 1) out.page = q.page;
  if (q.pageSize) out.pageSize = q.pageSize;
  return out;
}

/** Agorot as shekels, for the currency formatter. */
export function agorotToShekels(agorot: number | null | undefined): number {
  return Math.round(Number(agorot) || 0) / 100;
}

export function isPayout(a: Pick<FailedPaymentAttempt, 'kind'>): boolean {
  return a.kind === 'payout';
}

/** The message key of an outcome; an unknown code shows as itself. */
export function outcomeKey(code: string | null | undefined): FailedOutcome | null {
  return (FAILED_OUTCOMES as readonly string[]).includes(code ?? '') ? (code as FailedOutcome) : null;
}

/** "שולם בהמשך …": the key of the paying tender, or `other` when the till did not say. */
export function paidLaterKey(method: string | null | undefined): (typeof PAID_LATER_METHODS)[number] | 'other' {
  const m = (method ?? '').trim().toLowerCase();
  return (PAID_LATER_METHODS as readonly string[]).includes(m) ? (m as (typeof PAID_LATER_METHODS)[number]) : 'other';
}

export function wasPaidLater(a: Pick<FailedPaymentAttempt, 'paidByTransactionId' | 'paidByMethod'>): boolean {
  return !!(a.paidByTransactionId || a.paidByMethod);
}

/** `****1234`, or null with no digits (only the last four are ever stored). */
export function maskedCard(last4: string | null | undefined): string | null {
  return last4 && /^\d{4}$/.test(last4) ? `****${last4}` : null;
}

/** The terminal's code and words in one line: `003 · התקשר לחברת האשראי`. */
export function reasonText(a: Pick<FailedPaymentAttempt, 'reasonCode' | 'reasonMessage'>): string | null {
  const parts = [a.reasonCode, a.reasonMessage].map((p) => (p ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** A failed or not-completed attempt — not one found charged later (`approved_late`). */
export function isFailedAttempt(a: Pick<FailedPaymentAttempt, 'outcome'>): boolean {
  return !NOT_FAILED_OUTCOMES.includes(a.outcome ?? '');
}

export function isUnresolved(a: Pick<FailedPaymentAttempt, 'outcome'>): boolean {
  return a.outcome === 'unresolved';
}

/** The list's order: the unresolved first (possibly charged, the till waits), then newest first. */
export function sortAttempts<T extends Pick<FailedPaymentAttempt, 'outcome' | 'occurredAt' | 'id'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const ua = isUnresolved(a) ? 0 : 1;
    const ub = isUnresolved(b) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Who may send a command (the people of a remote credit; the server checks the till too). */
export const CARD_COMMAND_ROLES: readonly string[] = ['super_admin', 'distributor', 'company_manager', 'shop_manager'];

export interface CardCommandActions {
  check: boolean;
  markApproved: boolean;
  markNotApproved: boolean;
  /** Withdraw the pending command. */
  cancel: boolean;
}

/**
 * What a user may do on a row: only an unresolved attempt with a vuid; while a decision waits
 * for the till, only withdraw it (a pending check may still be replaced by a decision). Nothing
 * for someone outside CARD_COMMAND_ROLES, or without edit on "דוחות" ([canEdit]: the dashboard
 * section the server's route rules ask for).
 */
export function cardCommandActions(
  a: Pick<FailedPaymentAttempt, 'outcome' | 'vuid' | 'cardCommand'>,
  role: string | null | undefined,
  canEdit = true,
): CardCommandActions {
  const none = { check: false, markApproved: false, markNotApproved: false, cancel: false };
  if (!canEdit || !role || !CARD_COMMAND_ROLES.includes(role) || !isUnresolved(a)) return none;
  const pending = a.cardCommand?.status === 'pending' ? a.cardCommand : null;
  if (pending && isDecision(pending)) return { ...none, cancel: true };
  if (!(a.vuid ?? '').trim()) return pending ? { ...none, cancel: true } : none;
  if (pending) return { check: false, markApproved: true, markNotApproved: true, cancel: true };
  return { check: true, markApproved: true, markNotApproved: true, cancel: false };
}

export function isDecision(cmd: Pick<CardCommand, 'action' | 'isDecision'> | null | undefined): boolean {
  if (!cmd) return false;
  return cmd.isDecision ?? (cmd.action === 'mark_approved' || cmd.action === 'mark_not_approved');
}

/**
 * How the row's command reads:
 * - a decision: `waiting` ("ממתין לקופה") until the till answers, then `done` ("בוצע");
 * - a check: `sent` ("נשלח לקופה…"), `delivered` once the till took it, then `answered`;
 * - `ended` (expired / withdrawn), or `none`.
 */
export type CardCommandPhase = 'none' | 'waiting' | 'sent' | 'delivered' | 'done' | 'answered' | 'ended';

export function cardCommandPhase(cmd: CardCommand | null | undefined): CardCommandPhase {
  if (!cmd) return 'none';
  if (cmd.status === 'expired' || cmd.status === 'cancelled') return 'ended';
  if (isDecision(cmd)) return cmd.status === 'pending' ? 'waiting' : cmd.status === 'done' ? 'done' : 'answered';
  if (cmd.status === 'pending') return cmd.deliveredAt ? 'delivered' : 'sent';
  return 'answered';
}

/** What the latest answered check said (its details, else its outcome); `not_checked` with none. */
export function checkVerdict(check: CardCommand | null | undefined): CheckVerdict {
  if (!check) return 'not_checked';
  const v = check.details?.verdict ?? check.verdict;
  if (v === 'approved' || v === 'cancelled' || v === 'not_found' || v === 'unknown') return v;
  if (check.resultOutcome === 'approved') return 'approved';
  if (check.resultOutcome === 'not_charged') return 'cancelled';
  return 'unknown';
}

/**
 * Whether a decision goes against the terminal's answer, as the server rules: approving after
 * anything but "approved", cancelling after anything but "cancelled" / "not found" — so with no
 * check, or an "unknown" one, either decision needs the manager's explicit confirmation.
 */
export function decisionDisagrees(action: 'mark_approved' | 'mark_not_approved', verdict: CheckVerdict): boolean {
  if (action === 'mark_approved') return verdict !== 'approved';
  return verdict !== 'cancelled' && verdict !== 'not_found';
}

/** The server's 409 `card_decision_mismatch` (stale page): the verdict it holds, else null. */
export function decisionMismatchOf(err: unknown): { verdict: CheckVerdict; label: string | null } | null {
  const detail = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as { code?: unknown; verdict?: unknown; verdictLabel?: unknown };
  if (d.code !== 'card_decision_mismatch') return null;
  const v = typeof d.verdict === 'string' && (CHECK_VERDICTS as readonly string[]).includes(d.verdict)
    ? (d.verdict as CheckVerdict)
    : 'unknown';
  return { verdict: v, label: typeof d.verdictLabel === 'string' ? d.verdictLabel : null };
}

/** The summary of a list of attempts — sales (sale + keyed) and payouts apart, as the server's. */
export function summarize(items: FailedPaymentAttempt[]): FailedPaymentSummary {
  const out: FailedPaymentSummary = {
    count: 0,
    totalAgorot: 0,
    payoutCount: 0,
    payoutTotalAgorot: 0,
    paidLaterCount: 0,
    unresolvedCount: 0,
    unresolvedTotalAgorot: 0,
    approvedLateCount: 0,
  };
  for (const a of items) {
    if (!isFailedAttempt(a)) {
      out.approvedLateCount = (out.approvedLateCount ?? 0) + 1;
      continue;
    }
    if (isUnresolved(a)) {
      out.unresolvedCount = (out.unresolvedCount ?? 0) + 1;
      out.unresolvedTotalAgorot = (out.unresolvedTotalAgorot ?? 0) + (Number(a.amountAgorot) || 0);
    }
    if (isPayout(a)) {
      out.payoutCount += 1;
      out.payoutTotalAgorot += Number(a.amountAgorot) || 0;
    } else {
      out.count += 1;
      out.totalAgorot += Number(a.amountAgorot) || 0;
      if (wasPaidLater(a)) out.paidLaterCount += 1;
    }
  }
  return out;
}

/** Nothing to show: no attempt and no cancelled sale. */
export function isEmpty(data: FailedPaymentsResponse | null | undefined): boolean {
  if (!data) return true;
  return data.total === 0 && (data.cancelledSales?.count ?? 0) === 0;
}

/** "קופה 2": the till's number, else its name, else the start of its id. */
export function tillLabel(row: { posNumber?: string | null; machineName?: string | null; machineId: string }): string {
  if (row.posNumber) return row.posNumber;
  return row.machineName || row.machineId.slice(0, 8);
}
