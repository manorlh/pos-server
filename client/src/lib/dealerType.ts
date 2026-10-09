/**
 * "סוג עוסק" — a company's tax status (docs/SPEC_BUSINESS_TYPE.md): the shapes the server
 * sends and the small rules the dashboard applies to them. No imports, so `npm test`
 * compiles it alone. The API calls are in lib/dealerTypeApi.ts.
 *
 * - `company`  — חברה בע״מ (ח.פ.): VAT, tax invoice-receipts (320) and credit notes (330).
 * - `licensed` — עוסק מורשה: exactly like a company.
 * - `exempt`   — עוסק פטור: no VAT, receipts (400) only; money back on a receipt refund.
 */

export type DealerType = 'company' | 'licensed' | 'exempt';

export const DEALER_TYPES: readonly DealerType[] = ['company', 'licensed', 'exempt'];

/** One change of a company's dealer type, as the server keeps it. */
export interface DealerTypeChange {
  from: DealerType;
  to: DealerType;
  at: string;
  by?: string | null;
  byName?: string | null;
}

/** `GET /companies/{id}/dealer-turnover`. */
export type TurnoverStatus = 'none' | 'ok' | 'approaching' | 'exceeded';

export interface DealerTurnover {
  year: number;
  dealerType: DealerType;
  turnover: number;
  /** Null until the super admin sets the ceiling (`/system/dealer-types`). */
  threshold: number | null;
  warnRatio: number;
  ratio: number | null;
  status: TurnoverStatus;
}

/** `GET /system/dealer-types`. */
export interface DealerTypeSettings {
  exemptTurnoverThreshold: number | null;
  warnRatio: number;
}

/** The type a company row means: anything unknown or absent (an older server) is a company. */
export function dealerTypeOf(value: unknown): DealerType {
  return value === 'licensed' || value === 'exempt' ? value : 'company';
}

/**
 * Who may change a company's dealer type: its administrators, never a branch — the same
 * set the server enforces (`Resource.DEALER_TYPE`). Choosing it on a new company is
 * whoever may create one.
 */
export function canChangeDealerType(role: string | null | undefined): boolean {
  return role === 'super_admin' || role === 'distributor' || role === 'company_manager';
}

/** Whether saving `next` over `current` changes the type (and so needs the warning). */
export function isDealerTypeChange(current: unknown, next: unknown): boolean {
  return dealerTypeOf(current) !== dealerTypeOf(next);
}

/** The message key of the label before the business number: ח.פ. / עוסק מורשה / עוסק פטור. */
export function numberLabelKey(type: unknown): 'numberCompany' | 'numberLicensed' | 'numberExempt' {
  const t = dealerTypeOf(type);
  return t === 'exempt' ? 'numberExempt' : t === 'licensed' ? 'numberLicensed' : 'numberCompany';
}

/** Document types an exempt dealer issues: a receipt and a receipt refund (internal -400). */
export const RECEIPT = 400;
export const RECEIPT_REFUND = -400;

/** The message key naming a document type this feature adds, or null for the others. */
export function receiptDocumentKey(type: number | null | undefined): 'docReceipt' | 'docReceiptRefund' | null {
  if (type === RECEIPT) return 'docReceipt';
  if (type === RECEIPT_REFUND) return 'docReceiptRefund';
  return null;
}

/** A Z prints "ללא מע״מ" only for an exempt dealer with no VAT in it (a mixed day keeps the split). */
export function zShowsExempt(type: unknown, vatTotal: string | number | null | undefined): boolean {
  if (dealerTypeOf(type) !== 'exempt') return false;
  if (vatTotal == null || vatTotal === '') return true;
  const n = typeof vatTotal === 'number' ? vatTotal : Number(vatTotal);
  return Number.isFinite(n) && Math.abs(n) < 0.005;
}

/** The share of the ceiling as a whole percent, or null with no ceiling. */
export function turnoverPercent(t: Pick<DealerTurnover, 'turnover' | 'threshold'>): number | null {
  if (!t.threshold || t.threshold <= 0) return null;
  return Math.round((t.turnover / t.threshold) * 100);
}

/** The ceiling as typed into the field: a positive number, empty = unset; anything else is invalid. */
export function parseThreshold(text: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = text.replace(/[,\s₪]/g, '');
  if (trimmed === '') return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}
