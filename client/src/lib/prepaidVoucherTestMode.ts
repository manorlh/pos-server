/**
 * "מצב בדיקה" for a production voucher batch (P:/specs/voucher-test-mode.md; the cloud's
 * app/services/prepaid_voucher_test_mode.py): while it is on, the batch's real vouchers are scanned
 * through the whole redemption at any till, kiosk or voucher station, yet nothing is taken off them and
 * nothing counts anywhere — each scan goes to the batch's "יומן בדיקות" only. Turned on / off with
 * "ערוך סדרה" (`testMode`), at creation (`startInTestMode`) or for many batches at once.
 */
import { api } from './api';

/** One test scan, as the log lists it (₪, not agorot). */
export interface PrepaidTestRedemption {
  /** "test-…": the id the till got instead of a redemption's. */
  id: string;
  /** `redeem` (at once) or `reserve` (a hold, then confirmed / released). */
  operation: 'redeem' | 'reserve';
  status: 'done' | 'held' | 'confirmed' | 'released' | 'reversed';
  at: string | null;
  confirmedAt: string | null;
  releasedAt: string | null;
  reversedAt: string | null;
  machineId: string | null;
  machineName: string | null;
  shopId: string | null;
  shopName: string | null;
  posUserId: string | null;
  posUserName: string | null;
  voucherId: string;
  serial: number | null;
  saleRef: string | null;
  /** What would have been taken / given up: [{productId, name, quantity}]. */
  items: { productId?: string; name?: string | null; quantity?: number }[];
  forfeited: { productId?: string; name?: string | null; quantity?: number }[];
  accounting: string | null;
  /** ₪ the voucher would have covered, its value, the customer's top-up; a discount's ₪ and uses. */
  covered: number | null;
  value: number | null;
  topUp: number | null;
  listValue: number | null;
  discount: number | null;
  uses: number | null;
  /** What the voucher would have kept: a product's / a group's name, "total" or "uses". */
  remainingAfter: { key: string; name: string | null; quantity: number }[];
}

export interface PrepaidTestLog {
  batchId: string;
  testMode: boolean;
  testModeSince: string | null;
  testModeBy: string | null;
  total: number;
  items: PrepaidTestRedemption[];
}

export async function fetchPrepaidTestLog(batchId: string): Promise<PrepaidTestLog> {
  const { data } = await api.get<PrepaidTestLog>(`/prepaid-vouchers/batches/${batchId}/test-redemptions`);
  return data;
}

function qty(n: number | undefined | null): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(n);
}

/** "1× נקניקייה, 2× שתייה" — what a scan would have covered (a discount: its ₪, by the page). */
export function wouldCoverText(row: Pick<PrepaidTestRedemption, 'items'>): string {
  return row.items
    .filter((i) => Number(i.quantity ?? 0) > 0)
    .map((i) => `${qty(i.quantity)}× ${i.name ?? ''}`.trim())
    .join(', ');
}

/** "שתייה 1 · סה״כ 2" — what the voucher would have kept; [uses] / [total] are worded by the page. */
export function wouldRemainText(
  row: Pick<PrepaidTestRedemption, 'remainingAfter'>,
  words: { uses: string; total: string },
): string {
  return row.remainingAfter
    .map((r) => {
      const name = r.key === 'uses' ? words.uses : r.key === 'total' ? words.total : r.name ?? r.key;
      return `${name} ${qty(r.quantity)}`;
    })
    .join(' · ');
}
