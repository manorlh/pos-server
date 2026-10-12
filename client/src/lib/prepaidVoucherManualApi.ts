/**
 * "מימוש ידני מהענן" (server: app/services/prepaid_voucher_manual.py): redeem production vouchers from
 * the dashboard when the till's scanner failed — one voucher in detail, "סמן כמומש" (everything left),
 * a list of codes, and undo of a manual redemption.
 */
import { api } from './api';
import type { PrepaidVoucher } from './prepaidVouchersApi';
import type { DashboardAccess } from './dashboardAccess';
import { canAccess } from './dashboardAccess';

/** "מימוש ידני של שוברים", or edit on "שוברי הפקה" (the server accepts either). */
export function canRedeemManually(access: DashboardAccess): boolean {
  return canAccess(access, 'prepaid_voucher_redeem', 'edit') || canAccess(access, 'prepaid_vouchers', 'edit');
}

export interface ManualRefusal {
  code: string;
  message: string;
  overrideText?: string;
}

export interface ManualGroupLeft {
  key: string;
  name: string | null;
  minQty: number;
  maxQty: number;
  remaining: number;
  products: { id: string; name: string | null }[];
}

export interface ManualVoucherState {
  input: string;
  found: boolean;
  voucherId?: string;
  code?: string;
  displayCode?: string;
  serial?: number;
  batchId?: string;
  batchName?: string;
  kind?: 'items' | 'order_discount' | 'item_discount';
  /** How it is redeemed here: a fixed list, item groups (a punch card is one), or a discount's uses. */
  selection?: 'items' | 'groups' | 'discount';
  status?: string;
  splitAllowed?: boolean;
  /** "נותרו: מזון ×1, שתייה ×1". */
  leftText?: string;
  quota?: number | null;
  remaining?: number | null;
  usesLeft?: number | null;
  items?: { productId: string; name: string; quantity: number; remaining: number; weighed?: boolean; unitLabel?: string | null }[];
  groups?: ManualGroupLeft[];
  validShops?: { id: string; name: string }[];
  defaultShopId?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  testMode?: boolean;
  /** What refuses it now (null: nothing). */
  refusal: ManualRefusal | null;
  /** A super admin's: the rules "כפייה" would pass (expired, not yet valid, another shop). */
  overridable?: ManualRefusal[];
  canForce?: boolean;
  needsShop?: boolean;
  /** The chosen shop's tills ("קופה — לא חובה"). */
  tills?: { id: string; name: string | null }[];
}

export interface ManualPreview {
  total: number;
  ok: number;
  refused: number;
  notFound: number;
  forced: number;
  vouchers: ManualVoucherState[];
}

export interface ManualRedeemBody {
  code?: string;
  voucherId?: string;
  shopId?: string | null;
  machineId?: string | null;
  occurredAt?: string | null;
  reason?: string | null;
  oneClick?: boolean;
  force?: boolean;
  full?: boolean;
  items?: { productId?: string; groupKey?: string; quantity: number }[];
  units?: number;
  uses?: number;
  forfeitRest?: boolean;
  clientRequestId: string;
}

export interface ManualRedeemResult {
  ok: boolean;
  replayed: boolean;
  redemptionId: string;
  redeemedAt: string | null;
  override: string[];
  leftText: string;
  voucher: PrepaidVoucher;
}

export interface ManualBulkResult {
  ok: boolean;
  total: number;
  redeemed: number;
  replayed: number;
  refused: number;
  results: {
    input: string;
    status: 'redeemed' | 'replayed' | 'refused';
    voucherId?: string;
    code?: string | null;
    serial?: number;
    redemptionId?: string;
    override?: string[];
    reason?: string;
    message?: string;
  }[];
}

export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The server's Hebrew of a refusal (`{detail: {code, message}}`), else the fallback. */
export function manualErrorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { detail?: unknown } }; message?: string };
  const d = e?.response?.data?.detail;
  if (d && typeof d === 'object' && 'message' in d && typeof (d as { message: unknown }).message === 'string') {
    return (d as { message: string }).message;
  }
  if (typeof d === 'string') return d;
  return fallback;
}

export async function previewManualRedeem(body: {
  codes?: string[];
  voucherIds?: string[];
  shopId?: string | null;
  occurredAt?: string | null;
}): Promise<ManualPreview> {
  const { data } = await api.post<ManualPreview>('/prepaid-vouchers/manual-redeem/preview', body);
  return data;
}

export async function manualRedeem(body: ManualRedeemBody): Promise<ManualRedeemResult> {
  const { data } = await api.post<ManualRedeemResult>('/prepaid-vouchers/manual-redeem', body, {
    headers: { 'Idempotency-Key': body.clientRequestId },
  });
  return data;
}

export async function manualRedeemBulk(body: {
  codes?: string[];
  voucherIds?: string[];
  shopId?: string | null;
  machineId?: string | null;
  occurredAt?: string | null;
  reason?: string | null;
  oneClick?: boolean;
  force?: boolean;
  clientRequestId: string;
}): Promise<ManualBulkResult> {
  const { data } = await api.post<ManualBulkResult>('/prepaid-vouchers/manual-redeem/bulk', { ...body, full: true }, {
    headers: { 'Idempotency-Key': body.clientRequestId },
  });
  return data;
}

export async function reverseManualRedemption(redemptionId: string, reason: string): Promise<{ ok: boolean; voucher: PrepaidVoucher }> {
  const { data } = await api.post<{ ok: boolean; voucher: PrepaidVoucher }>(
    `/prepaid-vouchers/redemptions/${redemptionId}/reverse`,
    { reason },
  );
  return data;
}

/** Codes from pasted text or a file's cells: anything that looks like a voucher code ("PV:" and dashes dropped). */
export function codesFromText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const code = raw.trim().replace(/^PV:/i, '').replace(/[-\s]/g, '').toUpperCase();
    if (code.length < 8 || code.length > 40 || !/^[A-Z0-9]+$/.test(code)) continue;
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/** Codes from a CSV / XLS / XLSX file's first sheet (SheetJS), every cell. */
export async function codesFromFile(file: File): Promise<string[]> {
  if (/\.(csv|txt)$/i.test(file.name)) return codesFromText(await file.text());
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellText: true, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', blankrows: false });
  return codesFromText(rows.map((r) => (r as unknown[]).map((c) => (c == null ? '' : String(c))).join(' ')).join('\n'));
}
