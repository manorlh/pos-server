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
] as const;
export type FailedOutcome = (typeof FAILED_OUTCOMES)[number];

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
}

export interface FailedPaymentSummary {
  /** kind sale + keyed. */
  count: number;
  totalAgorot: number;
  payoutCount: number;
  payoutTotalAgorot: number;
  paidLaterCount: number;
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

/** The summary of a list of attempts — sales (sale + keyed) and payouts apart, as the server's. */
export function summarize(items: FailedPaymentAttempt[]): FailedPaymentSummary {
  const out: FailedPaymentSummary = { count: 0, totalAgorot: 0, payoutCount: 0, payoutTotalAgorot: 0, paidLaterCount: 0 };
  for (const a of items) {
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
